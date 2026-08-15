import { useEffect, useRef, useState } from 'react'
import {
  AppBridge,
  PostMessageTransport,
} from '@modelcontextprotocol/ext-apps/app-bridge'
import type {
  CallToolResult,
  ReadResourceResult,
} from '@modelcontextprotocol/sdk/types.js'
import type { ClientContext, ToolResultNode } from '@deepseek-ai/dsh-client-runtime/client'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type {
  McpAppCatalogItem,
  McpAppPresentationMetaV1,
  McpAppView,
} from '../types.js'

const API_PREFIX = '/api/mcp-apps'
const CATALOG_REFRESH_MS = 5_000
const READY_TIMEOUT_MS = 10_000
const MIN_HEIGHT = 120
const MAX_HEIGHT = 800

/** Browser Cordis plugin name used by client diagnostics. */
export const name = 'mcp-apps-client'

/** Required Browser service. */
export const inject = ['slots']

async function api<T>(path: string, body?: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${API_PREFIX}/${path}`, body === undefined
    ? { credentials: 'same-origin' }
    : {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
  const value = await response.json() as { error?: unknown }
  if (!response.ok) {
    throw new Error(typeof value.error === 'string' ? value.error : `MCP Apps request failed (${response.status})`)
  }
  return value as T
}

function presentationMeta(value: unknown): McpAppPresentationMetaV1 | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const meta = value as Partial<McpAppPresentationMetaV1>
  if (meta.kind !== 'dsh/mcp-app'
    || meta.version !== 1
    || typeof meta.viewId !== 'string'
    || typeof meta.publicToolName !== 'string'
    || typeof meta.resourceUri !== 'string'
    || meta.result === null
    || typeof meta.result !== 'object') return undefined
  return meta as McpAppPresentationMetaV1
}

function fallbackText(block: ToolResultNode): string {
  return block.content
    .filter(item => item.type === 'text')
    .map(item => item.text)
    .join('\n') || 'MCP App result unavailable.'
}

function loopbackSandboxOrigin(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'http:' || (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost')) {
    throw new Error('MCP Apps Sandbox Proxy is not a loopback HTTP origin')
  }
  return url.origin
}

function timeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      value => {
        window.clearTimeout(timer)
        resolve(value)
      },
      error => {
        window.clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function waitForSandbox(iframe: HTMLIFrameElement, origin: string): Promise<void> {
  return timeout(new Promise<void>((resolve) => {
    const listener = (event: MessageEvent): void => {
      if (event.source !== iframe.contentWindow
        || event.origin !== origin
        || event.data?.method !== 'ui/notifications/sandbox-proxy-ready') return
      window.removeEventListener('message', listener)
      resolve()
    }
    window.addEventListener('message', listener)
  }), READY_TIMEOUT_MS, 'MCP App Sandbox Proxy did not become ready')
}

function argsOf(block: ToolResultNode): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(block.call?.argsRaw ?? '{}')
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function McpAppRow({
  block,
  descriptor,
}: ToolCallViewProps & { descriptor: McpAppCatalogItem }) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [error, setError] = useState<string>()
  const [ready, setReady] = useState(false)

  const settled: ToolResultNode | undefined = 'kind' in block ? block : undefined
  const meta = presentationMeta(settled?.meta)

  useEffect(() => {
    const iframe = iframeRef.current
    if (iframe === null || settled === undefined || meta === undefined) return
    let disposed = false
    let bridge: AppBridge | undefined

    const run = async (): Promise<void> => {
      const view = await api<McpAppView>('view', { viewId: meta.viewId })
      if (disposed) return
      const sandboxOrigin = loopbackSandboxOrigin(descriptor.sandboxOrigin)
      const sandboxReady = waitForSandbox(iframe, sandboxOrigin)
      const url = new URL('/sandbox.html', `${sandboxOrigin}/`)
      if (view.csp !== undefined) url.searchParams.set('csp', JSON.stringify(view.csp))
      iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin')
      iframe.referrerPolicy = 'origin'
      iframe.src = url.href
      await sandboxReady
      if (disposed || iframe.contentWindow === null) return

      bridge = new AppBridge(
        null,
        { name: 'DeepSeek Harness MCP Apps', version: '0.1.0' },
        { serverTools: {}, serverResources: {} },
        {
          hostContext: {
            theme: window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
            platform: 'web',
            displayMode: 'inline',
            availableDisplayModes: ['inline'],
            containerDimensions: {
              width: Math.round(iframe.getBoundingClientRect().width),
              maxHeight: MAX_HEIGHT,
            },
          },
        },
      )
      bridge.oncalltool = (params, extra) => api<CallToolResult>('tool', {
        viewId: meta.viewId,
        name: params.name,
        arguments: params.arguments ?? {},
      }).then(result => {
        extra.signal.throwIfAborted()
        return result
      })
      bridge.onreadresource = (params, extra) => api<ReadResourceResult>('resource', {
        viewId: meta.viewId,
        uri: params.uri,
      }).then(result => {
        extra.signal.throwIfAborted()
        return result
      })
      bridge.onsizechange = params => {
        if (typeof params.height !== 'number' || !Number.isFinite(params.height)) return
        iframe.style.height = `${String(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(params.height))))}px`
      }
      const initialized = timeout(new Promise<void>((resolve) => {
        if (bridge !== undefined) bridge.oninitialized = () => resolve()
      }), READY_TIMEOUT_MS, 'MCP App did not initialize')

      await bridge.connect(new PostMessageTransport(iframe.contentWindow, iframe.contentWindow))
      bridge.sendSandboxResourceReady({
        html: view.html,
        sandbox: 'allow-scripts allow-same-origin',
      })
      await initialized
      if (disposed) return
      bridge.sendToolInput({ arguments: argsOf(settled) })
      bridge.sendToolResult(meta.result as CallToolResult)
      setReady(true)
    }

    void run().catch(cause => {
      if (!disposed) setError(cause instanceof Error ? cause.message : String(cause))
    })
    return () => {
      disposed = true
      if (bridge !== undefined) {
        void timeout(bridge.teardownResource({}), 1_000, 'MCP App teardown timed out')
          .catch(() => {})
          .finally(() => {
            void (bridge as unknown as { close(): Promise<void> }).close()
          })
      }
      iframe.removeAttribute('src')
    }
  }, [descriptor.sandboxOrigin, meta, settled])

  if (settled === undefined) {
    return <div data-mcp-app-status="running">Running MCP App tool...</div>
  }
  if (meta === undefined) {
    return <pre data-mcp-app-fallback>{fallbackText(settled)}</pre>
  }
  if (error !== undefined) {
    return (
      <div data-mcp-app-error>
        <strong>MCP App unavailable</strong>
        <pre>{fallbackText(settled)}</pre>
        <small>{error}</small>
      </div>
    )
  }
  return (
    <div data-mcp-app-view style={{ width: '100%', minWidth: 0 }}>
      {!ready && <div data-mcp-app-status="loading">Loading MCP App...</div>}
      <iframe
        ref={iframeRef}
        title={`MCP App: ${descriptor.publicToolName}`}
        style={{
          display: ready ? 'block' : 'none',
          width: '100%',
          height: 320,
          border: 0,
          background: 'transparent',
        }}
      />
    </div>
  )
}

function descriptorKey(item: McpAppCatalogItem): string {
  return JSON.stringify(item)
}

/** Register current MCP App tools into the dynamic keyed Tool view slot. */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('tool.call.toolview', () => {
    let stopped = false
    const registered = new Map<string, { key: string; dispose: () => void }>()

    const refresh = async (): Promise<void> => {
      const response = await api<{ items: McpAppCatalogItem[] }>('catalog')
      if (stopped) return
      const next = new Map(response.items.map(item => [item.publicToolName, item]))
      for (const [name, current] of registered) {
        const item = next.get(name)
        if (item !== undefined && descriptorKey(item) === current.key) continue
        current.dispose()
        registered.delete(name)
      }
      for (const [name, item] of next) {
        if (registered.has(name)) continue
        const dispose = ctx.slots.register(
          { name: 'tool.call.toolview', key: name },
          (props: ToolCallViewProps) => <McpAppRow {...props} descriptor={item} />,
        )
        registered.set(name, { key: descriptorKey(item), dispose })
      }
    }

    void refresh().catch(error => { console.warn('mcp-apps: catalog refresh failed', error) })
    const timer = window.setInterval(() => {
      void refresh().catch(error => { console.warn('mcp-apps: catalog refresh failed', error) })
    }, CATALOG_REFRESH_MS)
    return () => {
      stopped = true
      window.clearInterval(timer)
      for (const entry of registered.values()) entry.dispose()
      registered.clear()
    }
  })
}
