import { readFile } from 'node:fs/promises'
import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from '@modelcontextprotocol/ext-apps/server'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type {
  CallToolResult,
  ReadResourceResult,
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

const RESOURCE_URI = 'ui://counter/app'
let count = 0

function result(message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: `${message}: ${String(count)}` }],
    structuredContent: { count },
    _meta: { updatedAt: Date.now() },
  }
}

function viewHtml(script: string): string {
  return `<!doctype html>
<html data-theme="light">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>DSH Counter</title>
  <style>
    :root{font-family:ui-sans-serif,system-ui,sans-serif;color:#171717;background:#fff}
    :root[data-theme=dark]{color:#f5f5f5;background:#171717}
    *{box-sizing:border-box}
    body{margin:0;padding:16px}
    main{display:grid;grid-template-columns:1fr auto;align-items:center;gap:16px;min-height:112px}
    .label{margin:0 0 4px;font-size:12px;color:#737373}
    .count{font-size:42px;line-height:1;font-weight:650;font-variant-numeric:tabular-nums}
    .status{margin:8px 0 0;font-size:12px;color:#737373}
    button{width:44px;height:44px;border:1px solid #a3a3a3;border-radius:6px;background:#171717;color:#fff;font:24px/1 system-ui;cursor:pointer}
    button:hover{background:#404040}
    button:disabled{cursor:wait;opacity:.55}
    :root[data-theme=dark] button{background:#fafafa;color:#171717}
  </style>
</head>
<body>
  <main>
    <section>
      <p class="label">Server counter</p>
      <output class="count" data-count>0</output>
      <p class="status" data-status>Connecting</p>
    </section>
    <button type="button" data-increment aria-label="Increment counter" title="Increment counter">+</button>
  </main>
  <script>${script.replaceAll('</script', '<\\/script')}</script>
</body>
</html>`
}

function createServer(): McpServer {
  const server = new McpServer({ name: 'DSH Uni Editor counter demo', version: '1.0.0' })

  registerAppTool(server, 'show_counter', {
    title: 'Show counter',
    description: 'Returns the current server-side counter.',
    inputSchema: {},
    outputSchema: z.object({ count: z.number() }),
    _meta: { ui: { resourceUri: RESOURCE_URI } },
  }, async () => result('Current counter'))

  registerAppTool(server, 'increment_counter', {
    title: 'Increment counter',
    description: 'Increments the server-side counter by one.',
    inputSchema: {},
    outputSchema: z.object({ count: z.number() }),
    _meta: { ui: { visibility: ['app'] } },
  }, async () => {
    count += 1
    return result('Counter incremented')
  })

  registerAppResource(server, 'counter-view', RESOURCE_URI, {
    mimeType: RESOURCE_MIME_TYPE,
    _meta: {
      ui: {
        csp: {
          connectDomains: [],
          resourceDomains: [],
          frameDomains: [],
          baseUriDomains: [],
        },
      },
    },
  }, async (): Promise<ReadResourceResult> => {
    const script = await readFile(new URL('./view.js', import.meta.url), 'utf8')
    return {
      contents: [{
        uri: RESOURCE_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: viewHtml(script),
        _meta: {
          ui: {
            csp: {
              connectDomains: [],
              resourceDomains: [],
              frameDomains: [],
              baseUriDomains: [],
            },
          },
        },
      }],
    }
  })

  return server
}

await createServer().connect(new StdioServerTransport())
