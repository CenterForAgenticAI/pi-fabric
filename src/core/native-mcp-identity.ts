import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/** Pi 0.99 preserves raw MCP identity in namespace/label, not its hashed tool name. */
export function nativeMcpIdentity(
  definition: Pick<ToolDefinition, "name" | "label" | "namespace">,
): { server: string; tool: string } | undefined {
  const namespace = definition.namespace?.name;
  if (!namespace?.startsWith("mcp__") || !definition.name.startsWith("mcp__")) return undefined;
  const server = namespace.slice(5);
  const prefix = `${server}/`;
  if (!server || !definition.label.startsWith(prefix)) return undefined;
  const tool = definition.label.slice(prefix.length);
  return tool ? { server, tool } : undefined;
}

export function isSelectedNativeMcpTool(
  definition: Pick<ToolDefinition, "name" | "label" | "namespace">,
  servers: readonly string[] = [],
): boolean {
  const identity = nativeMcpIdentity(definition);
  return identity !== undefined && servers.includes(identity.server);
}
// Pi's MCP extension registers these while any connected server offers
// resources and re-registers them hidden when none does (syncResourceTools in
// Pi's extensions/mcp). Mirrors the resource half of Pi's isMcpToolName, which
// Pi does not export from its package entry.
const PI_MCP_RESOURCE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource",
]);

/** Whether a tool is one of Pi's MCP resource tools, whose registration follows server state. */
export function isPiMcpResourceToolName(name: string): boolean {
  return PI_MCP_RESOURCE_TOOL_NAMES.has(name);
}
