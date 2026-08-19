import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({
  name: 'workspace-context-test',
  version: '0.0.0',
})

server.registerTool('show_context', {
  inputSchema: {},
  outputSchema: {
    cwd: z.string().nullable(),
  },
}, async (_args, extra) => {
  const value = extra._meta?.['ai.deepseek.dsh/workspace']
  const cwd = value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof value.cwd === 'string'
    ? value.cwd
    : null
  return {
    content: [{ type: 'text', text: cwd === null ? 'No workspace' : 'Workspace received' }],
    structuredContent: { cwd },
  }
})

await server.connect(new StdioServerTransport())
