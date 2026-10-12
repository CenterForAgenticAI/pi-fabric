import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

/**
 * Tell a Fabric-owned pi-durable child's session that it is a worker.
 *
 * pi-context-aware reads `sessionRole` from a `context-aware.policy.v1` custom
 * entry on the active branch of the session record; without one it behaves as a
 * session with a user at a terminal (compaction seed sent as a user message,
 * model rewrite, cache listing, mid-reply compaction). pi-delegate writes the
 * same entry for its workers. Neither package imports the other, so the wire
 * shape is restated here as plain JSON. This module reads and writes JSONL with
 * node:fs only: the worker process must not load the Pi SDK.
 */
export const DURABLE_WORKER_POLICY_ENTRY_TYPE = "context-aware.policy.v1";
export const DURABLE_WORKER_DECLARED_BY = "pi-fabric/durable-worker";

/** Directories under a run directory whose files Fabric creates for that run. */
const OWNED_SESSION_DIRECTORIES: ReadonlySet<string> = new Set(["durable-session", "fork-session", "handoff-session"]);

// Pi migrates an older header and rewrites the file; a newer Pi never reads this as newer than itself.
const SESSION_HEADER_VERSION = 3;
const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const DIRECTORY_FLAG = fs.constants.O_DIRECTORY ?? 0;
const TEMP_NAME = /^tmp-[0-9a-f-]{36}\.jsonl$/;

export type DurableWorkerSeedResult = "seeded" | "already-seeded" | "not-owned";

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const currentUid = (): number | undefined => (typeof process.getuid === "function" ? process.getuid() : undefined);

const policyData = () => ({
  schemaVersion: 1,
  layer: "host",
  declaredBy: DURABLE_WORKER_DECLARED_BY,
  values: { sessionRole: "worker" },
});

const policyEntry = (id: string, parentId: string | null, timestamp: string) => ({
  type: "custom",
  customType: DURABLE_WORKER_POLICY_ENTRY_TYPE,
  data: policyData(),
  id,
  parentId,
  timestamp,
});

const sessionHeader = (cwd: string, timestamp: string) => ({
  type: "session", version: SESSION_HEADER_VERSION, id: randomUUID(), timestamp, cwd,
});

const jsonLines = (lines: readonly unknown[]): string => lines.map((line) => JSON.stringify(line)).join("\n") + "\n";

/** True when Fabric's own folder layout puts `file` in this run's session folders (never a caller-supplied path by itself). */
export const isFabricOwnedSessionFile = (file: string, runDirectory: string): boolean => {
  try {
    const parent = fs.realpathSync(path.dirname(path.resolve(file)));
    const base = fs.realpathSync(runDirectory);
    return path.dirname(parent) === base && OWNED_SESSION_DIRECTORIES.has(path.basename(parent));
  } catch {
    return false;
  }
};

/** A real directory (never a link) owned by this user, or an error before anything is written. */
const assertPrivateDirectory = (directory: string): fs.Stats => {
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Durable session folder must be a real directory, not a link: ${directory}`);
  }
  const uid = currentUid();
  if (uid !== undefined && stat.uid !== uid) throw new Error(`Durable session folder is not owned by this user: ${directory}`);
  return stat;
};

/** Create `<run>/<name>` without following a link, or accept an existing real directory owned by this user. */
const ensureSessionFolder = (runDirectory: string, name: string): string => {
  const directory = path.join(runDirectory, name);
  try {
    fs.mkdirSync(directory, { mode: 0o700 }); // not recursive: the run directory must already exist
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = assertPrivateDirectory(directory);
  if (process.platform !== "win32" && (stat.mode & 0o777) !== 0o700) {
    // Through a descriptor opened without following links, so a link swapped in now cannot redirect the chmod.
    const fd = fs.openSync(directory, fs.constants.O_RDONLY | DIRECTORY_FLAG | NO_FOLLOW);
    try {
      const opened = fs.fstatSync(fd);
      if (!opened.isDirectory() || opened.ino !== stat.ino || opened.dev !== stat.dev) {
        throw new Error(`Durable session folder changed while opening: ${directory}`);
      }
      fs.fchmodSync(fd, 0o700);
    } finally {
      fs.closeSync(fd);
    }
  }
  return directory;
};

/** A crash between link and unlink leaves the temp as a second name for session.jsonl; remove only our own temp names. */
const reclaimLeftoverTemps = (folder: string, file: string): void => {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink < 2) return;
  for (const name of fs.readdirSync(folder)) {
    if (!TEMP_NAME.test(name)) continue;
    const candidate = path.join(folder, name);
    try {
      const other = fs.lstatSync(candidate);
      if (other.isFile() && other.ino === stat.ino && other.dev === stat.dev) fs.unlinkSync(candidate);
    } catch { /* another attempt removed it first */ }
  }
};

/**
 * Create the durable child's private session file, or reuse the existing one.
 *
 * The folder is created under the existing run directory without following
 * links. A new file appears already complete (Pi header plus the worker-role
 * entry): the content goes to `tmp-<uuid>.jsonl` in the same folder, is synced,
 * then hard-linked to `session.jsonl`. Exactly one concurrent creator wins the
 * link; the others keep the winner's file. A crash leaves at most a stray
 * `tmp-*.jsonl`, which run retention removes with the run.
 */
export const createDurableSessionFile = (
  runDirectory: string,
  cwd: string,
  hooks: { beforeLink?: () => void } = {},
): string => {
  const folder = ensureSessionFolder(runDirectory, "durable-session");
  const file = path.join(folder, "session.jsonl");
  let exists = true;
  try {
    fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    exists = false;
  }
  if (exists) {
    reclaimLeftoverTemps(folder, file);
    return file;
  }
  const timestamp = new Date().toISOString();
  const temporary = path.join(folder, `tmp-${randomUUID()}.jsonl`);
  try {
    const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW, 0o600);
    try {
      fs.writeSync(fd, jsonLines([sessionHeader(cwd, timestamp), policyEntry(randomUUID().slice(0, 8), null, timestamp)]));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    hooks.beforeLink?.();
    try {
      fs.linkSync(temporary, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; // another attempt created it: keep theirs
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  reclaimLeftoverTemps(folder, file); // a winner that has linked but not yet unlinked its temp
  return file;
};

interface SessionScan {
  header: boolean;
  leafId: string | null;
  entries: Map<string, Record<string, unknown>>;
}

/** Read a session the way Pi's SessionManager does: skip unparsable lines, first entry is the header, the leaf is the last entry. */
const scanSession = (text: string, file: string): SessionScan => {
  const scan: SessionScan = { header: false, leafId: null, entries: new Map() };
  let first = true;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // Pi skips malformed lines too.
    }
    if (parsed === null) continue;
    const entry = record(parsed);
    if (first) {
      first = false;
      if (entry?.type !== "session" || typeof entry.id !== "string") return scan; // Pi refuses the file
      scan.header = true;
      continue;
    }
    if (entry?.type === "session") continue;
    if (!entry || typeof entry.id !== "string") {
      throw new Error(`Durable session file has an entry without an id, so Pi's active leaf cannot be determined: ${file}`);
    }
    scan.entries.set(entry.id, entry);
    scan.leafId = entry.id;
  }
  return scan;
};

/** Is the worker-role entry on the path from `leafId` to the root, the path pi-context-aware reads? */
const hasWorkerRoleOnBranch = (scan: SessionScan): boolean => {
  const seen = new Set<string>();
  let current = scan.leafId === null ? undefined : scan.entries.get(scan.leafId);
  while (current) {
    const id = current.id as string;
    if (seen.has(id)) return false;
    seen.add(id);
    if (current.type === "custom" && current.customType === DURABLE_WORKER_POLICY_ENTRY_TYPE &&
        isDeepStrictEqual(current.data, policyData())) return true;
    current = typeof current.parentId === "string" ? scan.entries.get(current.parentId) : undefined;
  }
  return false;
};

/**
 * Make sure a session file Fabric created has the worker-role entry on the
 * branch Pi will open, appending at most one entry.
 *
 * - Only a file the launcher says Fabric created (`owned`), and that still sits
 *   in one of this run's session folders, is touched. A caller-supplied file is
 *   never edited, wherever it lives.
 * - The file is opened once without following links, and only that descriptor
 *   is read and written. It must be a regular file with one name, owned by this
 *   user, in a folder that is not a link.
 * - Pi opens a session at the last entry in the file. The file counts as seeded
 *   when a valid worker-role entry is on the path from that entry to the root;
 *   otherwise one entry is appended as a child of it.
 * - A non-empty file without a Pi header is refused (an error, not a skip): Pi
 *   would refuse it too, and the bytes are not ours to rewrite.
 */
export const seedDurableWorkerRole = (
  file: string,
  options: { runDirectory: string; cwd: string; owned: boolean },
): DurableWorkerSeedResult => {
  if (!options.owned || !isFabricOwnedSessionFile(file, options.runDirectory)) return "not-owned";
  assertPrivateDirectory(path.dirname(path.resolve(file)));
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_APPEND | NO_FOLLOW);
  } catch (error) {
    throw new Error(`Cannot open durable session file ${file}: ${(error as Error).message}`, { cause: error });
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error(`Durable session file must be a regular file: ${file}`);
    if (stat.nlink !== 1) throw new Error(`Durable session file must have exactly one name (found ${stat.nlink}): ${file}`);
    const uid = currentUid();
    if (uid !== undefined && stat.uid !== uid) throw new Error(`Durable session file is not owned by this user: ${file}`);
    const named = fs.lstatSync(file);
    if (named.ino !== stat.ino || named.dev !== stat.dev) throw new Error(`Durable session file changed while opening: ${file}`);

    const text = stat.size > 0 ? fs.readFileSync(fd, "utf8") : "";
    const timestamp = new Date().toISOString();
    let lines: unknown[];
    if (text.length === 0) {
      // A file not created by createDurableSessionFile (which writes both lines at once): give Pi a header and the entry.
      lines = [sessionHeader(options.cwd, timestamp), policyEntry(randomUUID().slice(0, 8), null, timestamp)];
    } else {
      const scan = scanSession(text, file);
      if (!scan.header) {
        throw new Error(`Durable session file is not a Pi session (no session header); refusing to launch the child: ${file}`);
      }
      if (hasWorkerRoleOnBranch(scan)) return "already-seeded";
      let id = randomUUID().slice(0, 8);
      while (scan.entries.has(id)) id = randomUUID();
      lines = [policyEntry(id, scan.leafId, timestamp)];
    }
    // Pi repairs a missing final newline on open; do it here so the new entry starts on its own line.
    fs.writeSync(fd, (text.length > 0 && !text.endsWith("\n") ? "\n" : "") + jsonLines(lines));
    fs.fsyncSync(fd);
    return "seeded";
  } finally {
    fs.closeSync(fd);
  }
};
