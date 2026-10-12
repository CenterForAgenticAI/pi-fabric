import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Tell a Fabric-owned pi-durable child's session that it is a worker.
 *
 * pi-context-aware reads `sessionRole` from a `context-aware.policy.v1` custom
 * entry in the session record; without one it behaves as a session with a user
 * at a terminal (compaction seed sent as a user message, model rewrite, cache
 * listing, mid-reply compaction). pi-delegate writes the same entry for its
 * workers. Neither package imports the other, so the wire shape is restated
 * here as plain JSON. This module reads and writes JSONL with node:fs only: the
 * worker process must not load the Pi SDK.
 */
export const DURABLE_WORKER_POLICY_ENTRY_TYPE = "context-aware.policy.v1";
export const DURABLE_WORKER_DECLARED_BY = "pi-fabric/durable-worker";

/** Directories under a run directory whose files Fabric creates for that run. */
const OWNED_SESSION_DIRECTORIES: ReadonlySet<string> = new Set(["durable-session", "fork-session", "handoff-session"]);

// Pi migrates an older header and rewrites the file; a newer Pi never reads this as newer than itself.
const SESSION_HEADER_VERSION = 3;

export type DurableWorkerSeedResult = "seeded" | "already-seeded" | "not-owned" | "unreadable";

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/** True when Fabric created `file` for the run in `runDirectory` (never a caller-supplied path). */
export const isFabricOwnedSessionFile = (file: string, runDirectory: string): boolean => {
  try {
    const parent = fs.realpathSync(path.dirname(path.resolve(file)));
    const base = fs.realpathSync(runDirectory);
    return path.dirname(parent) === base && OWNED_SESSION_DIRECTORIES.has(path.basename(parent));
  } catch {
    return false;
  }
};

const policyData = () => ({
  schemaVersion: 1,
  layer: "host",
  declaredBy: DURABLE_WORKER_DECLARED_BY,
  values: { sessionRole: "worker" },
});

/**
 * Append the worker-role entry to a Fabric-created session file, once.
 *
 * - A file outside this run's session folders is never touched.
 * - An empty file (the durable-session file) gets a Pi session header and the
 *   entry in one write, so Pi opens it as an existing session and appends to
 *   it. Pi itself defers writing a new session file until a message exists.
 * - A seeded file keeps every existing byte; the entry is appended as a child of
 *   the current leaf.
 * - An entry already declared by pi-fabric/durable-worker is left alone, so a
 *   relaunched attempt never adds a second.
 */
export const seedDurableWorkerRole = (
  file: string,
  options: { runDirectory: string; cwd: string },
): DurableWorkerSeedResult => {
  if (!isFabricOwnedSessionFile(file, options.runDirectory)) return "not-owned";
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    // Fabric's writers always leave a file; a missing one is left for Pi to create.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "unreadable";
    throw error;
  }
  if (!stat.isFile()) throw new Error(`Durable session file must be a regular file: ${file}`);

  let header = false;
  let leafId: string | null = null;
  const ids = new Set<string>();
  let endsWithNewline = true;
  if (stat.size > 0) {
    const text = fs.readFileSync(file, "utf8");
    endsWithNewline = text.endsWith("\n");
    for (const line of text.split("\n")) {
      let entry: Record<string, unknown> | undefined;
      try {
        entry = record(JSON.parse(line));
      } catch {
        continue; // Pi skips malformed lines too.
      }
      if (!entry) continue;
      if (entry.type === "session") {
        header = true;
        continue;
      }
      if (typeof entry.id === "string") {
        ids.add(entry.id);
        leafId = entry.id;
      }
      if (entry.type === "custom" && entry.customType === DURABLE_WORKER_POLICY_ENTRY_TYPE &&
          record(entry.data)?.declaredBy === DURABLE_WORKER_DECLARED_BY) return "already-seeded";
    }
    // Non-empty without a Pi header: Pi refuses it; do not rewrite someone's bytes.
    if (!header) return "unreadable";
  }

  let id = randomUUID().slice(0, 8);
  while (ids.has(id)) id = randomUUID();
  const timestamp = new Date().toISOString();
  const lines: unknown[] = [];
  if (stat.size === 0) {
    lines.push({ type: "session", version: SESSION_HEADER_VERSION, id: randomUUID(), timestamp, cwd: options.cwd });
  }
  lines.push({
    type: "custom",
    customType: DURABLE_WORKER_POLICY_ENTRY_TYPE,
    data: policyData(),
    id,
    parentId: leafId,
    timestamp,
  });
  const payload = (endsWithNewline ? "" : "\n") + lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
  fs.appendFileSync(file, payload, { encoding: "utf8" });
  return "seeded";
};
