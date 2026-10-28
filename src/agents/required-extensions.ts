import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { KnownApi } from "@earendil-works/pi-ai";

/**
 * Pi's built-in streaming APIs. A model whose `api` is not listed here streams
 * only after an extension registers that API, so an `extensions: false` child
 * cannot call it. The Record keeps the list exhaustive against pi-ai's union.
 */
const BUILT_IN_PI_APIS: Readonly<Record<KnownApi, true>> = {
  "openai-completions": true,
  "mistral-conversations": true,
  "openai-responses": true,
  "azure-openai-responses": true,
  "openai-codex-responses": true,
  "anthropic-messages": true,
  "bedrock-converse-stream": true,
  "google-generative-ai": true,
  "google-vertex": true,
  "pi-messages": true,
};

export const isBuiltInPiApi = (api: string): boolean =>
  Object.prototype.hasOwnProperty.call(BUILT_IN_PI_APIS, api);

const packageName = (file: string): string | undefined => {
  let directory = path.dirname(file);
  while (true) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8")) as { name?: unknown };
      if (typeof manifest.name === "string" && manifest.name.trim()) return manifest.name.trim();
    } catch {
      // No readable manifest here; keep walking up.
    }
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
};

/**
 * Pi records each extension's path as configured, which may be relative to the
 * session cwd or start with `~`. Make file paths absolute the way Pi's loader
 * does; drop synthetic `builtin:` and `<inline:...>` entries, which -e cannot load.
 */
export const absoluteExtensionPaths = (paths: readonly string[], cwd: string): string[] =>
  paths.flatMap((entry) => {
    if (!entry || entry.startsWith("<") || entry.startsWith("builtin:")) return [];
    if (entry === "~") return [os.homedir()];
    if (entry.startsWith("~/")) return [path.join(os.homedir(), entry.slice(2))];
    return [path.resolve(cwd, entry)];
  });

const realpath = (file: string): string => {
  try {
    return fs.realpathSync(file);
  } catch {
    return path.resolve(file);
  }
};

/**
 * Map `requiredExtensions` entries to extension paths the parent session itself
 * loaded. An entry is either the exact absolute path of a loaded extension or
 * the package name of one or more loaded extensions. The returned paths always
 * come from `loaded`, never from the caller, so a caller cannot make a child
 * load an arbitrary file. Fabric itself is refused: use `extensions: true`.
 */
export const resolveRequiredExtensions = (
  entries: readonly string[],
  options: {
    loaded: readonly string[] | undefined;
    fabricExtensionPath: string;
  },
): string[] => {
  if (!options.loaded) {
    throw new Error(
      "requiredExtensions: Fabric cannot verify which extensions this session loaded, so it refuses to forward any",
    );
  }
  // Only real files qualify; builtin: and <inline:...> entries are not loadable with -e.
  const loaded = options.loaded
    .filter((entry) => path.isAbsolute(entry))
    .map((entry) => ({ path: entry, real: realpath(entry), name: packageName(entry) }));
  const fabricName = packageName(options.fabricExtensionPath);
  const fabricReal = realpath(options.fabricExtensionPath);
  const selected: string[] = [];
  for (const entry of entries) {
    const trimmed = entry.trim();
    const exact = path.isAbsolute(trimmed)
      ? loaded.filter((candidate) =>
          candidate.path === path.resolve(trimmed) || candidate.real === realpath(trimmed))
      : loaded.filter((candidate) => candidate.name === trimmed);
    // "pi-multi-account" also names "@scope/pi-multi-account" when exactly one loaded package fits.
    const unscoped = exact.length > 0 || path.isAbsolute(trimmed) || trimmed.includes("/")
      ? []
      : loaded.filter((candidate) => candidate.name?.startsWith("@") && candidate.name.split("/")[1] === trimmed);
    if (new Set(unscoped.map((candidate) => candidate.name)).size > 1) {
      throw new Error(
        `requiredExtensions: ${JSON.stringify(entry)} matches more than one loaded package ` +
          `(${[...new Set(unscoped.map((candidate) => candidate.name))].sort().join(", ")}); use the full package name.`,
      );
    }
    const matches = exact.length > 0 ? exact : unscoped;
    if (matches.length === 0) {
      const available = [...new Set(loaded.flatMap((candidate) => candidate.name ? [candidate.name] : []))].sort();
      throw new Error(
        `requiredExtensions: ${JSON.stringify(entry)} is not loaded by this session. ` +
          "Name a package or the absolute path of an extension this session loaded" +
          (available.length ? ` (loaded packages: ${available.join(", ")})` : "") + ".",
      );
    }
    for (const match of matches) {
      if (match.real === fabricReal || (fabricName !== undefined && match.name === fabricName)) {
        throw new Error(
          "requiredExtensions cannot load Fabric itself; use extensions: true or recursive: true for a Fabric child",
        );
      }
      if (!selected.includes(match.path)) selected.push(match.path);
    }
  }
  return selected;
};

/**
 * Refuse, before launch, an `extensions: false` Pi child whose model streams
 * through an API that only an extension registers. Without this the child
 * starts, spends its admission, and fails on its first model call with
 * "No API provider registered for api: ...".
 */
export const assertChildModelReachable = (options: {
  model: string | undefined;
  api: string | undefined;
  extensions: boolean;
  requiredExtensions: readonly string[];
}): void => {
  if (options.extensions || options.requiredExtensions.length > 0) return;
  if (!options.model || !options.api || isBuiltInPiApi(options.api)) return;
  const provider = options.model.split("/", 1)[0] ?? options.model;
  throw new Error(
    `Model ${options.model} uses API "${options.api}", which no built-in Pi provider serves; ` +
      `an extension registers provider "${provider}". A child with extensions: false would fail on its first model call. ` +
      `Add that extension's package name to requiredExtensions, set extensions: true, or choose a model with a built-in API.`,
  );
};
