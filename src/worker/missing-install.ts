import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MISSING_PACKAGE = /Cannot find (?:package|module) '([^']+)'/;
const IMPORTED_FROM = / imported from (\S+)/;

/** The package name of a bare specifier, or undefined for a path or URL. */
const packageName = (specifier: string): string | undefined => {
  if (/^(?:[./\\]|[a-zA-Z]:|[a-z]+:)/.test(specifier)) return undefined;
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
};

/** The directory of the nearest package.json above an entry module. */
const buildRoot = (entryUrl: string): string | undefined => {
  let directory = path.dirname(fileURLToPath(entryUrl));
  for (;;) {
    if (fs.existsSync(path.join(directory, "package.json"))) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
};

/**
 * A worker starts from the parent session's own build. When that build lost
 * its dependencies (a build worktree without node_modules, a half-removed
 * install), every spawn fails with a bare module-resolution error that does
 * not say which build is broken or what to do. Name both; keep the cause.
 */
export const explainMissingInstall = (error: unknown, entryUrl: string): unknown => {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof Error && "code" in error ? (error as { code?: unknown }).code : undefined;
  if (code !== undefined && code !== "ERR_MODULE_NOT_FOUND" && code !== "MODULE_NOT_FOUND") return error;
  const specifier = MISSING_PACKAGE.exec(message)?.[1];
  const name = specifier ? packageName(specifier) : undefined;
  if (!name) return error;
  let root: string | undefined;
  try { root = buildRoot(entryUrl); } catch { return error; }
  if (!root) return error;
  // Only the build's own imports: a package missing for some other importer is not this build's install.
  const importer = IMPORTED_FROM.exec(message)?.[1];
  if (importer) {
    const relative = path.relative(root, importer.startsWith("file:") ? fileURLToPath(importer) : importer);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return error;
  }
  const noModules = !fs.existsSync(path.join(root, "node_modules"));
  return new Error(
    `Fabric build at ${root} cannot start a worker: its dependency "${name}" is not installed${noModules ? " (the build has no node_modules)" : ""}. ` +
    `Workers run from the build this Pi session started with. Reinstall that build's dependencies, or restart Pi so it loads an installed build. ` +
    `Cause: ${message.split("\n")[0]}`,
    { cause: error },
  );
};
