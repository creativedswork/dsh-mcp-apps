import type {
  McpAppCatalogItem,
  McpAppPresentationMetaV1,
} from '../types.js'

/** Rebind a persisted App result to the current MCP Server process. */
export function currentViewId(
  meta: McpAppPresentationMetaV1,
  descriptor: McpAppCatalogItem,
): string {
  if (meta.publicToolName !== descriptor.publicToolName
    || meta.resourceUri !== descriptor.resourceUri) {
    throw new Error('MCP App definition no longer matches this tool result')
  }
  return descriptor.viewId
}
