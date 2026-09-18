import { Value } from "typebox/value";
import type { FabricComponentDefinition, FabricComponentEntry } from "./types.js";

export const COMPONENT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

/** Strict at the live-control boundary: malformed edits must never become removals. */
export function componentEntries(value: unknown): FabricComponentEntry[] {
  if (!Array.isArray(value) || value.length > 256) {
    throw new Error("Fabric components must be an array of at most 256 entries");
  }
  const ids = new Set<string>();
  return value.map(raw => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid Fabric component entry");
    const entry = raw as Record<string, unknown>;
    if (typeof entry.id !== "string" || !COMPONENT_ID_PATTERN.test(entry.id)) throw new Error("Invalid Fabric component id");
    if (typeof entry.component !== "string" || !COMPONENT_ID_PATTERN.test(entry.component)) throw new Error(`Invalid component definition name for ${entry.id}`);
    if (entry.disabled !== undefined && typeof entry.disabled !== "boolean") throw new Error(`Invalid disabled flag for ${entry.id}`);
    if (Object.keys(entry).some(key => !["id", "component", "config", "disabled"].includes(key))) throw new Error(`Unknown component entry field for ${entry.id}`);
    if (ids.has(entry.id)) throw new Error(`Duplicate Fabric component entry id: ${entry.id}`);
    ids.add(entry.id);
    return structuredClone(entry) as unknown as FabricComponentEntry;
  });
}

export function validateComponentConfig(entry: FabricComponentEntry, definition: FabricComponentDefinition): void {
  if (entry.disabled || !definition.configSchema) return;
  let detail: string;
  try {
    if (Value.Check(definition.configSchema, entry.config)) return;
    detail = [...Value.Errors(definition.configSchema, entry.config)].slice(0, 5)
      .map(error => `${(error as { path?: string }).path || "/"}: ${error.message}`).join("; ").slice(0, 2000);
  } catch {
    detail = "configuration schema validation failed";
  }
  throw new Error(`Invalid config for component ${entry.id} (${entry.component}): ${detail}`);
}
