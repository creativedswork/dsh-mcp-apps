import { App } from '@modelcontextprotocol/ext-apps'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector)
  if (element === null) throw new Error(`counter view is missing ${selector}`)
  return element
}

const count = required<HTMLElement>('[data-count]')
const button = required<HTMLButtonElement>('[data-increment]')
const status = required<HTMLElement>('[data-status]')

function countOf(result: CallToolResult): number | undefined {
  const structured = result.structuredContent
  if (structured === null || typeof structured !== 'object') return undefined
  const value = (structured as Record<string, unknown>).count
  return typeof value === 'number' ? value : undefined
}

function render(result: CallToolResult): void {
  const value = countOf(result)
  if (value !== undefined) count.textContent = String(value)
  status.textContent = 'Synced with server'
}

const app = new App({ name: 'DSH Counter', version: '1.0.0' })
app.ontoolinput = () => {
  status.textContent = 'Loading counter'
}
app.ontoolresult = render
app.ontoolcancelled = params => {
  status.textContent = params.reason ?? 'Tool call cancelled'
}
app.onhostcontextchanged = context => {
  if (context.theme !== undefined) document.documentElement.dataset.theme = context.theme
}
app.onteardown = async () => ({})

button.addEventListener('click', () => {
  button.disabled = true
  status.textContent = 'Updating'
  void app.callServerTool({ name: 'increment_counter', arguments: {} })
    .then(render)
    .catch(error => {
      status.textContent = error instanceof Error ? error.message : String(error)
    })
    .finally(() => {
      button.disabled = false
    })
})

void app.connect().then(() => {
  const theme = app.getHostContext()?.theme
  if (theme !== undefined) document.documentElement.dataset.theme = theme
  app.sendSizeChanged({
    width: Math.ceil(document.documentElement.scrollWidth),
    height: Math.ceil(document.documentElement.scrollHeight),
  })
}).catch(error => {
  status.textContent = error instanceof Error ? error.message : String(error)
})
