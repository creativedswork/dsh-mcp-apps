import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { McpAppView } from './types.js'

type Csp = NonNullable<McpAppView['csp']>

const FORBIDDEN_CSP_CHARS = /[\u0000-\u0020"'`;]/
const WILDCARD_ORIGIN = /^(https?):\/\/\*\.([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)(?::([1-9]\d{0,4}))?$/

function cspOrigin(value: string, protocols: readonly string[]): string {
  if (FORBIDDEN_CSP_CHARS.test(value)) throw new Error(`unsafe CSP source ${JSON.stringify(value)}`)
  const wildcard = WILDCARD_ORIGIN.exec(value)
  if (wildcard !== null) {
    const [, protocol, host, port] = wildcard
    return `${protocol}://*.${host}${port === undefined ? '' : `:${port}`}`
  }
  const parsed = new URL(value)
  if (!protocols.includes(parsed.protocol)) throw new Error(`unsupported CSP protocol ${parsed.protocol}`)
  if (parsed.username !== '' || parsed.password !== '') throw new Error('CSP sources cannot contain credentials')
  if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
    throw new Error('CSP sources must be origins without paths, queries, or fragments')
  }
  return parsed.origin
}

function sources(values: unknown, protocols: readonly string[]): string[] {
  if (values === undefined) return []
  if (!Array.isArray(values) || values.some(value => typeof value !== 'string')) {
    throw new Error('CSP domain lists must contain strings')
  }
  return values.map(value => cspOrigin(value, protocols))
}

/** Parse and normalize untrusted MCP resource CSP metadata. */
export function normalizeCsp(value: unknown): Csp | undefined {
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('MCP App CSP must be an object')
  }
  const input = value as Record<string, unknown>
  const known = new Set(['connectDomains', 'resourceDomains', 'frameDomains', 'baseUriDomains'])
  for (const key of Object.keys(input)) {
    if (!known.has(key)) throw new Error(`unknown MCP App CSP field ${JSON.stringify(key)}`)
  }
  return {
    ...input.connectDomains === undefined
      ? {}
      : { connectDomains: sources(input.connectDomains, ['http:', 'https:', 'ws:', 'wss:']) },
    ...input.resourceDomains === undefined
      ? {}
      : { resourceDomains: sources(input.resourceDomains, ['http:', 'https:']) },
    ...input.frameDomains === undefined
      ? {}
      : { frameDomains: sources(input.frameDomains, ['http:', 'https:']) },
    ...input.baseUriDomains === undefined
      ? {}
      : { baseUriDomains: sources(input.baseUriDomains, ['http:', 'https:']) },
  }
}

/** Build the enforced CSP header for the isolated Sandbox Proxy. */
export function buildCspHeader(csp: Csp | undefined): string {
  const resources = csp?.resourceDomains?.join(' ') ?? ''
  const connects = csp?.connectDomains?.join(' ') ?? ''
  const frames = csp?.frameDomains?.join(' ')
  const bases = csp?.baseUriDomains?.join(' ')
  return [
    "default-src 'none'",
    `script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: ${resources}`.trim(),
    `style-src 'self' 'unsafe-inline' ${resources}`.trim(),
    `img-src 'self' data: blob: ${resources}`.trim(),
    `font-src 'self' data: blob: ${resources}`.trim(),
    `media-src 'self' data: blob: ${resources}`.trim(),
    `connect-src 'self' ${connects}`.trim(),
    `worker-src 'self' blob: ${resources}`.trim(),
    frames === undefined || frames === '' ? "frame-src 'none'" : `frame-src ${frames}`,
    bases === undefined || bases === '' ? "base-uri 'none'" : `base-uri ${bases}`,
    "object-src 'none'",
  ].join('; ')
}

const SANDBOX_HTML = String.raw`<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>html,body{margin:0;min-height:100%;background:transparent}iframe{display:block;width:100%;height:100%;border:0}</style>
</head>
<body>
<script>
(() => {
  if (window.self === window.top) throw new Error('sandbox proxy must run in an iframe')
  if (!document.referrer) throw new Error('sandbox proxy requires an embedding referrer')
  const expectedHostOrigin = new URL(document.referrer).origin
  if (!/^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(expectedHostOrigin)) {
    throw new Error('sandbox proxy accepts only loopback hosts')
  }
  const ownOrigin = location.origin
  try {
    window.top.location.href
    throw new Error('sandbox proxy is not cross-origin isolated')
  } catch (error) {
    if (error instanceof Error && error.message === 'sandbox proxy is not cross-origin isolated') throw error
  }

  const inner = document.createElement('iframe')
  inner.setAttribute('sandbox', 'allow-scripts allow-same-origin')
  document.body.append(inner)

  const resourceReady = 'ui/notifications/sandbox-resource-ready'
  window.addEventListener('message', (event) => {
    if (event.source === window.parent) {
      if (event.origin !== expectedHostOrigin) return
      if (event.data && event.data.method === resourceReady) {
        const html = event.data.params && event.data.params.html
        if (typeof html !== 'string') return
        const doc = inner.contentDocument || (inner.contentWindow && inner.contentWindow.document)
        if (!doc) return
        doc.open()
        doc.write(html)
        doc.close()
        return
      }
      if (inner.contentWindow) inner.contentWindow.postMessage(event.data, ownOrigin)
      return
    }
    if (event.source === inner.contentWindow && event.origin === ownOrigin) {
      window.parent.postMessage(event.data, expectedHostOrigin)
    }
  })

  window.parent.postMessage({
    jsonrpc: '2.0',
    method: 'ui/notifications/sandbox-proxy-ready',
    params: {},
  }, expectedHostOrigin)
})()
</script>
</body>
</html>`

/** Running isolated Sandbox Proxy server. */
export interface SandboxServer {
  origin: string
  close(): Promise<void>
}

/** Start the loopback-only Sandbox Proxy on an OS-assigned port. */
export async function startSandboxServer(): Promise<SandboxServer> {
  const server = createServer((req, res) => {
    let url: URL
    try {
      url = new URL(req.url ?? '/', 'http://sandbox.invalid')
    } catch {
      res.writeHead(400).end()
      return
    }
    if (req.method !== 'GET' || (url.pathname !== '/' && url.pathname !== '/sandbox.html')) {
      res.writeHead(404).end()
      return
    }
    try {
      const encoded = url.searchParams.get('csp')
      if (encoded !== null && encoded.length > 8_192) throw new Error('CSP query is too large')
      const csp = encoded === null ? undefined : normalizeCsp(JSON.parse(encoded) as unknown)
      res.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Security-Policy': buildCspHeader(csp),
        'Content-Type': 'text/html; charset=utf-8',
        'Referrer-Policy': 'origin',
        'X-Content-Type-Options': 'nosniff',
      })
      res.end(SANDBOX_HTML)
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(error instanceof Error ? error.message : 'invalid CSP')
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address() as AddressInfo
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error === undefined ? resolve() : reject(error))
      server.closeAllConnections()
    }),
  }
}
