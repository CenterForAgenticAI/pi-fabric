import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FABRIC_RUN_ROOT_PREFIX } from "./retention.js";

/** Environment override for `agents.runRootParent`. */
export const RUN_ROOT_PARENT_ENV = "PI_FABRIC_RUN_ROOT_PARENT";

const expandHome = (value: string): string =>
  value === "~" ? os.homedir() : value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;

const insideRunRoot = (directory: string): boolean =>
  directory.split(path.sep).some((segment) => segment.startsWith(FABRIC_RUN_ROOT_PREFIX));

/**
 * Directory that holds each session's managed run root
 * (`<parent>/pi-fabric-runs-XXXXXX`): PI_FABRIC_RUN_ROOT_PARENT, then
 * `agents.runRootParent`, then os.tmpdir(). The parent is shared; the root
 * inside it is still created per session by mkdtemp and owned by that session.
 *
 * A setting that cannot be used safely falls back to os.tmpdir(): a relative
 * path (it would follow the session's working directory into a project), a
 * path inside a Fabric run root (that root's owner would treat the nested
 * root as its own contents), or a path that cannot be created as a directory.
 */
export const resolveRunRootParent = (configured: string | undefined): string => {
  const fallback = os.tmpdir();
  const raw = process.env[RUN_ROOT_PARENT_ENV]?.trim() || configured?.trim();
  if (!raw) return fallback;
  const expanded = expandHome(raw);
  if (!path.isAbsolute(expanded)) return fallback;
  const parent = path.resolve(expanded);
  if (insideRunRoot(parent)) return fallback;
  try {
    // A symlink must not lead into a run root either; check before creating anything.
    let existing = parent;
    while (!fs.existsSync(existing)) existing = path.dirname(existing);
    if (insideRunRoot(fs.realpathSync(existing))) return fallback;
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    return fs.statSync(parent).isDirectory() && !insideRunRoot(fs.realpathSync(parent)) ? parent : fallback;
  } catch {
    return fallback;
  }
};
