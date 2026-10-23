/** Inherited optional-tool authority: exact tool names and `*` patterns. */
export interface ChildToolAllowlist {
  readonly entries: readonly string[];
  has(name: string): boolean;
}

// Same semantics as Pi's `--tools`: `*` matches any characters and every
// other character is literal. A grandchild entry that is itself a pattern
// passes only when an inherited pattern covers its whole language, because a
// `*` in the candidate can only be absorbed by a wildcard here.
const toolPattern = (pattern: string): RegExp =>
  new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "s");

const allowlist = (entries: readonly string[]): ChildToolAllowlist => {
  const names = new Set(entries.filter((entry) => !entry.includes("*")));
  const patterns = entries.filter((entry) => entry.includes("*")).map(toolPattern);
  return {
    entries,
    // fabric_exec is never inherited, whatever pattern would cover it.
    has: (name) => name !== "fabric_exec" && (names.has(name) || patterns.some((pattern) => pattern.test(name))),
  };
};

/** Worker-owned optional-tool allowlist; absence leaves the host unrestricted. */
export function readChildToolAllowlist(raw = process.env.PI_FABRIC_TOOL_ALLOWLIST): ChildToolAllowlist | undefined {
  if (raw === undefined) return undefined;
  try {
    const names: unknown = JSON.parse(raw);
    if (Array.isArray(names) && names.every((name) => typeof name === "string")) {
      return allowlist(names.filter((name) => name !== "fabric_exec"));
    }
  } catch {
    // Malformed inherited authority must fail closed, never widen the surface.
  }
  return allowlist([]);
}
