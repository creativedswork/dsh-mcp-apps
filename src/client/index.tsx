import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AppBridge,
  PostMessageTransport,
} from '@modelcontextprotocol/ext-apps/app-bridge'
import type {
  CallToolResult,
  ReadResourceResult,
} from '@modelcontextprotocol/sdk/types.js'
import type {
  ClientContext,
  ISessions,
  ToolResultNode,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type {
  McpAppCatalogItem,
  McpAppPresentationMetaV1,
  McpAppView,
} from '../types.js'
import { ActiveAppAction } from './active-app-action.js'
import {
  appRegistry,
  type AppInstanceController,
  type AppSurface,
} from './app-registry.js'

const API_PREFIX = '/api/mcp-apps'
const CATALOG_REFRESH_MS = 5_000
const READY_TIMEOUT_MS = 10_000
const MIN_HEIGHT = 120
const MAX_HEIGHT = 800
const MAX_MESSAGE_CHARS = 16_384
const MAX_DOWNLOAD_BYTES = 4 * 1024 * 1024
const FULLSCREEN_CHROME_HEIGHT = 44

type AppMessageParams = Parameters<NonNullable<AppBridge['onmessage']>>[0]
type AppMessageResult = Awaited<ReturnType<NonNullable<AppBridge['onmessage']>>>
type AppDownloadParams = Parameters<NonNullable<AppBridge['ondownloadfile']>>[0]
type AppDownloadResult = Awaited<ReturnType<NonNullable<AppBridge['ondownloadfile']>>>
type AppHostContext = NonNullable<
  NonNullable<ConstructorParameters<typeof AppBridge>[3]>['hostContext']
>
type DisplayMode = 'inline' | 'fullscreen'

interface McpAppRowInjected {
  sendMessage: (params: AppMessageParams) => Promise<AppMessageResult>
}

/** Browser Cordis plugin name used by client diagnostics. */
export const name = 'mcp-apps-client'

/** Required Browser service. */
export const inject = ['slots', 'sessions']

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

function textPrompt(params: AppMessageParams): Array<{ type: 'text'; text: string }> | undefined {
  if (params.role !== 'user' || params.content.length === 0) return undefined
  let chars = 0
  const content: Array<{ type: 'text'; text: string }> = []
  for (const block of params.content) {
    if (block.type !== 'text') return undefined
    chars += block.text.length
    if (chars > MAX_MESSAGE_CHARS) return undefined
    content.push({ type: 'text', text: block.text })
  }
  return content.some(block => block.text.trim() !== '') ? content : undefined
}

function downloadEmbedded(params: AppDownloadParams): AppDownloadResult {
  if (params.contents.length !== 1) return { isError: true }
  const content = params.contents[0]
  if (content?.type !== 'resource' || !('text' in content.resource)) return { isError: true }
  const resource = content.resource
  const uri = new URL(resource.uri)
  const filename = decodeURIComponent(uri.pathname.split('/').pop() ?? '')
  if (uri.protocol !== 'file:'
    || resource.mimeType !== 'application/json'
    || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(filename)) {
    return { isError: true }
  }
  const blob = new Blob([resource.text], { type: resource.mimeType })
  if (blob.size > MAX_DOWNLOAD_BYTES) return { isError: true }
  const href = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = href
  anchor.download = filename
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(href), 0)
  return {}
}

function appHostContext(
  iframe: HTMLIFrameElement,
  displayMode: DisplayMode,
  inlineContainer?: HTMLElement | null,
): AppHostContext {
  const bounds = iframe.getBoundingClientRect()
  const inlineBounds = inlineContainer?.getBoundingClientRect() ?? bounds
  return {
    theme: window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    locale: navigator.language,
    platform: 'web',
    displayMode,
    availableDisplayModes: ['inline', 'fullscreen'],
    containerDimensions: displayMode === 'fullscreen'
      ? {
          width: Math.max(1, Math.round(window.innerWidth)),
          height: Math.max(1, Math.round(window.innerHeight - FULLSCREEN_CHROME_HEIGHT)),
        }
      : {
          width: Math.max(1, Math.round(inlineBounds.width)),
          maxHeight: MAX_HEIGHT,
        },
  }
}

function McpAppRow({
  block,
  callId,
  descriptor,
  sendMessage,
  sessionId,
}: ToolCallViewProps & McpAppRowInjected & { descriptor: McpAppCatalogItem }) {
  const rootRef = useRef<HTMLDivElement>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const bridgeRef = useRef<AppBridge>()
  const displayModeRef = useRef<DisplayMode>('inline')
  const inlineHeightRef = useRef(320)
  const requestSurfaceRef = useRef<(surface: AppSurface) => void>(() => {})
  const locateRef = useRef<() => void>(() => {})
  const locateFrameRef = useRef<number>()
  const locateTimerRef = useRef<number>()
  const scrollPositionRef = useRef<{ element: HTMLElement; top: number }>()
  const scrollRestoreFrameRef = useRef<number>()
  const sendMessageRef = useRef(sendMessage)
  const [error, setError] = useState<string>()
  const [ready, setReady] = useState(false)
  const [displayMode, setDisplayMode] = useState<DisplayMode>('inline')
  const [frameHeight, setFrameHeight] = useState(320)
  const [located, setLocated] = useState(false)
  sendMessageRef.current = sendMessage

  const settled: ToolResultNode | undefined = 'kind' in block ? block : undefined
  const meta = presentationMeta(settled?.meta)
  const sessionKey = String(sessionId)
  const controller = useMemo<AppInstanceController>(() => ({
    sessionId: sessionKey,
    callId,
    publicToolName: descriptor.publicToolName,
    ready: false,
    surface: 'inline',
    requestSurface: surface => { requestSurfaceRef.current(surface) },
    locate: () => { locateRef.current() },
  }), [callId, descriptor.publicToolName, sessionKey])

  requestSurfaceRef.current = surface => {
    const iframe = iframeRef.current
    const previousSurface = displayModeRef.current
    if (surface === 'fullscreen' && previousSurface === 'inline') {
      const scrollport = rootRef.current?.closest<HTMLElement>('[data-conversation-scroll]')
      if (scrollport !== undefined && scrollport !== null) {
        scrollPositionRef.current = { element: scrollport, top: scrollport.scrollTop }
      }
    }
    const scrollPosition = scrollPositionRef.current
    displayModeRef.current = surface
    controller.surface = surface
    if (iframe !== null) {
      iframe.style.height = surface === 'fullscreen'
        ? '100%'
        : `${String(inlineHeightRef.current)}px`
    }
    setDisplayMode(surface)
    if (iframe !== null) {
      bridgeRef.current?.setHostContext(appHostContext(iframe, surface, rootRef.current))
    }
    if (scrollPosition !== undefined && previousSurface !== surface) {
      if (scrollRestoreFrameRef.current !== undefined) {
        window.cancelAnimationFrame(scrollRestoreFrameRef.current)
      }
      scrollRestoreFrameRef.current = window.requestAnimationFrame(() => {
        if (scrollPosition.element.isConnected) {
          scrollPosition.element.scrollTop = scrollPosition.top
        }
      })
      if (surface === 'inline') scrollPositionRef.current = undefined
    }
  }
  locateRef.current = () => {
    requestSurfaceRef.current('inline')
    locateFrameRef.current = window.requestAnimationFrame(() => {
      const target = rootRef.current?.closest<HTMLElement>('[data-chat-anchor-key]')
        ?? rootRef.current
      const scrollport = target?.closest<HTMLElement>('[data-conversation-scroll]')
      if (target !== null && target !== undefined && scrollport !== null && scrollport !== undefined) {
        scrollport.scrollTo({
          behavior: 'auto',
          top: scrollport.scrollTop
            + target.getBoundingClientRect().top
            - scrollport.getBoundingClientRect().top,
        })
      } else {
        target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
      setLocated(true)
      if (locateTimerRef.current !== undefined) window.clearTimeout(locateTimerRef.current)
      locateTimerRef.current = window.setTimeout(() => { setLocated(false) }, 1_800)
    })
  }

  useEffect(() => {
    if (settled === undefined || meta === undefined) return
    const dispose = appRegistry.register(controller)
    return () => {
      controller.ready = false
      dispose()
      if (locateFrameRef.current !== undefined) window.cancelAnimationFrame(locateFrameRef.current)
      if (locateTimerRef.current !== undefined) window.clearTimeout(locateTimerRef.current)
      if (scrollRestoreFrameRef.current !== undefined) {
        window.cancelAnimationFrame(scrollRestoreFrameRef.current)
      }
    }
  }, [controller, meta, settled])

  useEffect(() => {
    const iframe = iframeRef.current
    if (iframe === null || settled === undefined || meta === undefined) return
    let disposed = false
    let bridge: AppBridge | undefined
    controller.ready = false
    appRegistry.changed(controller)
    requestSurfaceRef.current('inline')
    setError(undefined)
    setReady(false)

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
        { name: 'DSH Uni Editor', version: '0.3.0' },
        {
          serverTools: {},
          serverResources: {},
          downloadFile: {},
          message: { text: {} },
        },
        {
          hostContext: appHostContext(iframe, displayModeRef.current, rootRef.current),
        },
      )
      bridgeRef.current = bridge
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
      bridge.onmessage = (params, extra) => {
        extra.signal.throwIfAborted()
        return sendMessageRef.current(params)
      }
      bridge.ondownloadfile = (params, extra) => {
        extra.signal.throwIfAborted()
        return downloadEmbedded(params)
      }
      bridge.onrequestdisplaymode = async ({ mode }, extra) => {
        extra.signal.throwIfAborted()
        if (mode !== 'inline' && mode !== 'fullscreen') return { mode: displayModeRef.current }
        return appRegistry.requestSurface(sessionKey, callId, mode)
          ? { mode }
          : { mode: displayModeRef.current }
      }
      bridge.onsizechange = params => {
        if (displayModeRef.current === 'fullscreen') return
        if (typeof params.height !== 'number' || !Number.isFinite(params.height)) return
        inlineHeightRef.current = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(params.height)))
        setFrameHeight(inlineHeightRef.current)
        iframe.style.height = `${String(inlineHeightRef.current)}px`
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
      controller.ready = true
      appRegistry.changed(controller)
      appRegistry.activate(sessionKey, callId)
      setReady(true)
    }

    void run().catch(cause => {
      if (!disposed) {
        controller.ready = false
        appRegistry.changed(controller)
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    })
    return () => {
      disposed = true
      controller.ready = false
      appRegistry.changed(controller)
      if (bridge !== undefined) {
        void timeout(bridge.teardownResource({}), 1_000, 'MCP App teardown timed out')
          .catch(() => {})
          .finally(() => {
            void (bridge as unknown as { close(): Promise<void> }).close()
          })
      }
      if (bridgeRef.current === bridge) bridgeRef.current = undefined
      iframe.removeAttribute('src')
    }
  }, [callId, controller, descriptor.sandboxOrigin, meta, sessionKey, settled])

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
  const fullscreen = displayMode === 'fullscreen'
  return (
    <div
      ref={rootRef}
      data-mcp-app-view
      data-display-mode={displayMode}
      data-mcp-app-located={located || undefined}
      onFocusCapture={() => { appRegistry.activate(sessionKey, callId) }}
      onPointerDownCapture={() => { appRegistry.activate(sessionKey, callId) }}
      style={{
        position: 'relative',
        width: '100%',
        minWidth: 0,
        height: fullscreen ? frameHeight : undefined,
        outline: located ? '2px solid var(--dsw-alias-state-business-primary)' : undefined,
        outlineOffset: located ? 4 : undefined,
      }}
    >
      <div
        data-mcp-app-surface
        style={{
          position: fullscreen ? 'fixed' : 'relative',
          width: '100%',
          minWidth: 0,
          ...(fullscreen
            ? {
                display: 'grid',
                gridTemplateRows: `${String(FULLSCREEN_CHROME_HEIGHT)}px minmax(0, 1fr)`,
                inset: 0,
                zIndex: 2147483000,
                height: '100vh',
                background: '#0b0d10',
              }
            : {}),
        }}
      >
        {!ready && <div data-mcp-app-status="loading">Loading MCP App...</div>}
        {fullscreen && (
          <div
            data-mcp-app-fullscreen-actions
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              gap: 6,
              boxSizing: 'border-box',
              padding: '6px 12px',
              borderBottom: '1px solid var(--dsw-alias-border-l2)',
              background: 'var(--dsw-alias-bg-base)',
            }}
          >
            <button
              type="button"
              onClick={() => { appRegistry.locate(sessionKey, callId) }}
              style={{
                padding: '6px 10px',
                border: '1px solid var(--dsw-alias-border-l2)',
                borderRadius: 6,
                background: 'var(--dsw-alias-bg-base)',
                color: 'var(--dsw-alias-label-primary)',
                cursor: 'pointer',
              }}
            >
              Locate in Chat
            </button>
            <button
              type="button"
              aria-label="Exit fullscreen"
              title="Exit fullscreen"
              onClick={() => { appRegistry.requestSurface(sessionKey, callId, 'inline') }}
              style={{
                width: 32,
                border: '1px solid var(--dsw-alias-border-l2)',
                borderRadius: 6,
                background: 'var(--dsw-alias-bg-base)',
                color: 'var(--dsw-alias-label-primary)',
                cursor: 'pointer',
              }}
            >
              X
            </button>
          </div>
        )}
        <iframe
          ref={iframeRef}
          title={`MCP App: ${descriptor.publicToolName}`}
          style={{
            display: ready ? 'block' : 'none',
            width: '100%',
            height: fullscreen ? '100%' : frameHeight,
            border: 0,
            background: 'transparent',
          }}
        />
      </div>
    </div>
  )
}

function descriptorKey(item: McpAppCatalogItem): string {
  return JSON.stringify(item)
}

/** Register current MCP App tools into the dynamic keyed Tool view slot. */
export function apply(ctx: ClientContext): void {
  const sessions = ctx.sessions as unknown as ISessions
  ctx.effect(() => () => { appRegistry.clear() }, 'mcp-apps: clear app registry')
  ctx.slots.inject(
    'conversation.session.header.actions',
    () => ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'mcp-apps-active',
      order: 30,
      label: 'MCP Apps',
    }, ActiveAppAction),
  )
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
          {
            name: 'tool.call.toolview',
            key: name,
            inject: sessionId => ({
              sendMessage: async (params: AppMessageParams): Promise<AppMessageResult> => {
                const content = textPrompt(params)
                const session = sessions.binding(sessionId)?.session
                if (content === undefined || session === undefined) return { isError: true }
                const result = await session.prompt(content, 'queue')
                return result.ok ? {} : { isError: true }
              },
            }),
          },
          (props: ToolCallViewProps & McpAppRowInjected) => (
            <McpAppRow {...props} descriptor={item} />
          ),
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
