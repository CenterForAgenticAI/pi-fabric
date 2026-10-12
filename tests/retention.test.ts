import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { writeForkSession } from "../src/agents/handoff.js";
import {
  FABRIC_RUN_ROOT_PREFIX,
  markRunRootActive,
  markRunRootClosed,
  pruneActorRunArchives,
  RUN_ROOT_HEARTBEAT_TTL_MS,
  sweepTempRunRoots,
} from "../src/storage/retention.js";

const roots: string[] = [];
const HOUR = 60 * 60 * 1_000;
const DAY = 24 * HOUR;

const temporaryDirectory = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-retention-test-"));
  roots.push(root);
  return root;
};

const writeStatus = (
  directory: string,
  record: Record<string, unknown>,
): void => {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "status.json"), JSON.stringify(record));
};

const sweepAt = (tempRoot: string, now: number) =>
  sweepTempRunRoots({ tempRoot, now, orphanedTempRunRetentionMs: 6 * HOUR, oneShotRunRetentionMs: DAY });

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("safe run roots", () => {
  const sweep = (tempRoot: string, now = 100 * DAY) => sweepTempRunRoots({ tempRoot, now, orphanedTempRunRetentionMs: 6 * HOUR, oneShotRunRetentionMs: DAY });

  it("preserves malformed/unmarked ownership and unknown root contents", () => {
    const tempRoot = temporaryDirectory();
    for (const [suffix, owner] of [["bad", {}], ["pid", { pid: "gone", startedAt: 1, heartbeatAt: 1, orphanedAt: 1 }], ["time", { pid: 2147483647, startedAt: 1, heartbeatAt: "old", orphanedAt: 1 }]] as const) {
      const root = path.join(tempRoot, FABRIC_RUN_ROOT_PREFIX + suffix);
      fs.mkdirSync(root);
      fs.writeFileSync(path.join(root, ".fabric-owner.json"), JSON.stringify(owner));
    }
    const unknown = path.join(tempRoot, FABRIC_RUN_ROOT_PREFIX + "unknown");
    markRunRootActive(unknown, 1);
    fs.writeFileSync(path.join(unknown, ".fabric-owner.json"), JSON.stringify({ pid: 2147483647, startedAt: 1, heartbeatAt: 1, orphanedAt: 1 }));
    fs.writeFileSync(path.join(unknown, "mine"), "do not delete");
    const unmarked = path.join(tempRoot, FABRIC_RUN_ROOT_PREFIX + "unmarked");
    fs.mkdirSync(unmarked);
    expect(sweep(tempRoot).removedRoots).toEqual([]);
    expect(fs.readdirSync(tempRoot)).toHaveLength(5);
  });

  it("rejects symlink roots and status markers without touching targets", () => {
    const tempRoot = temporaryDirectory();
    const target = temporaryDirectory();
    markRunRootActive(target, 1);
    const run = path.join(target, "run");
    writeStatus(run, { status: "completed", finishedAt: 1 });
    markRunRootClosed(target, 1);
    fs.symlinkSync(target, path.join(tempRoot, FABRIC_RUN_ROOT_PREFIX + "link"), "junction");
    const root = path.join(tempRoot, FABRIC_RUN_ROOT_PREFIX + "status-link");
    markRunRootActive(root, 1);
    fs.mkdirSync(path.join(root, "run"));
    fs.symlinkSync(path.join(run, "status.json"), path.join(root, "run", "status.json"));
    markRunRootClosed(root, 1, true);
    expect(sweep(tempRoot).removedRuns).toEqual([]);
    expect(fs.existsSync(run)).toBe(true);
  });

  it("expires shutdown-confirmed incomplete runs, but never a live descendant", () => {
    const tempRoot = temporaryDirectory();
    const root = path.join(tempRoot, FABRIC_RUN_ROOT_PREFIX + "closed-incomplete");
    markRunRootActive(root, 1);
    const incomplete = path.join(root, "incomplete");
    fs.mkdirSync(incomplete);
    fs.writeFileSync(path.join(incomplete, "task.txt"), "incomplete launch");
    const active = path.join(root, "active");
    writeStatus(active, { status: "running", transport: "process", sessionId: String(process.pid) });
    fs.writeFileSync(path.join(active, "task.txt"), "still live");
    markRunRootClosed(root, 1, true);
    expect(sweep(tempRoot, 5 * HOUR).removedRuns).toEqual([]);
    expect(sweep(tempRoot, 6 * HOUR + 1).removedRuns).toEqual([incomplete]);
    expect(fs.existsSync(active)).toBe(true);
  });

  it("keeps unknown incomplete runs and live nested work under dead owners", () => {
    const tempRoot = temporaryDirectory();
    const root = path.join(tempRoot, FABRIC_RUN_ROOT_PREFIX + "dead-nested");
    markRunRootActive(root, 1);
    fs.writeFileSync(path.join(root, ".fabric-owner.json"), JSON.stringify({ pid: 2147483647, startedAt: 1, heartbeatAt: 1, orphanedAt: 1 }));
    const run = path.join(root, "outer");
    writeStatus(run, { status: "completed", finishedAt: 1 });
    const nested = path.join(run, "nested", "live");
    writeStatus(nested, { status: "running", transport: "process", sessionId: String(process.pid) });
    expect(sweep(tempRoot).removedRoots).toEqual([]);
    expect(fs.existsSync(nested)).toBe(true);
  });
});

describe("run-root owner identity", () => {
  const sweep = (tempRoot: string, now: number) => sweepTempRunRoots({ tempRoot, now, orphanedTempRunRetentionMs: 6 * HOUR, oneShotRunRetentionMs: DAY });
  // A PID namespace this process is not in: the signal probe means nothing for it.
  const foreignIdentity = { hostname: os.hostname(), pidNamespace: "pid:[4026599999]", startedAt: 1 };
  const writeOwner = (root: string, owner: Record<string, unknown>): void => {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, ".fabric-owner.json"), JSON.stringify(owner));
  };
  const readOwner = (root: string): Record<string, unknown> =>
    JSON.parse(fs.readFileSync(path.join(root, ".fabric-owner.json"), "utf8")) as Record<string, unknown>;

  it("records this process's identity on the owner marker", () => {
    const root = path.join(temporaryDirectory(), FABRIC_RUN_ROOT_PREFIX + "self");
    markRunRootActive(root, 5);
    expect(readOwner(root)).toMatchObject({ pid: process.pid, heartbeatAt: 5, identity: { hostname: os.hostname() } });
    markRunRootClosed(root, 6, true);
    expect(readOwner(root)).toMatchObject({ pid: process.pid, heartbeatAt: 6, closedAt: 6, identity: { hostname: os.hostname() } });
  });

  it("treats a foreign-namespace owner with a stale heartbeat as dead, even when its PID is live here", () => {
    const tempRoot = temporaryDirectory();
    const root = path.join(tempRoot, FABRIC_RUN_ROOT_PREFIX + "foreign-stale");
    // process.pid answers the signal probe here, but it is not the foreign owner.
    writeOwner(root, { pid: process.pid, startedAt: 1, heartbeatAt: 1, identity: foreignIdentity });
    const detectedAt = 1 + RUN_ROOT_HEARTBEAT_TTL_MS + 1;
    expect(sweep(tempRoot, detectedAt).removedRoots).toEqual([]);
    expect(readOwner(root).orphanedAt).toBe(detectedAt);
    expect(sweep(tempRoot, detectedAt + 6 * HOUR).removedRoots).toEqual([root]);
  });

  it("keeps a foreign-namespace owner with a fresh heartbeat, even when its PID is absent here", () => {
    const tempRoot = temporaryDirectory();
    const root = path.join(tempRoot, FABRIC_RUN_ROOT_PREFIX + "foreign-fresh");
    writeOwner(root, { pid: 2_147_483_647, startedAt: 1, heartbeatAt: DAY, identity: foreignIdentity });
    expect(sweep(tempRoot, DAY + RUN_ROOT_HEARTBEAT_TTL_MS).removedRoots).toEqual([]);
    expect(readOwner(root).orphanedAt).toBeUndefined();
  });

  it("keeps a child run whose PID lives in the dead owner's foreign namespace", () => {
    const tempRoot = temporaryDirectory();
    const root = path.join(tempRoot, FABRIC_RUN_ROOT_PREFIX + "foreign-child");
    writeOwner(root, { pid: 2_147_483_647, startedAt: 1, heartbeatAt: 1, orphanedAt: 1, identity: foreignIdentity });
    const child = path.join(root, "child");
    // Absent from this namespace, so a bare signal probe would call it dead.
    writeStatus(child, { status: "running", transport: "process", sessionId: "2147483647" });
    fs.writeFileSync(path.join(child, "task.txt"), "foreign worker");
    expect(sweep(tempRoot, 100 * DAY).removedRoots).toEqual([]);
    expect(fs.existsSync(child)).toBe(true);
  });
});

describe("temporal retention", () => {
  it("removes dead temporary run roots after six hours", () => {
    const tempRoot = temporaryDirectory();
    const runRoot = path.join(tempRoot, FABRIC_RUN_ROOT_PREFIX + "dead");
    fs.mkdirSync(runRoot);
    fs.writeFileSync(
      path.join(runRoot, ".fabric-owner.json"),
      JSON.stringify({ pid: 2_147_483_647, startedAt: 1, heartbeatAt: 1 }),
    );

    const detected = sweepTempRunRoots({
      tempRoot,
      orphanedTempRunRetentionMs: 6 * HOUR,
      oneShotRunRetentionMs: DAY,
      now: 2,
    });
    expect(detected.removedRoots).toEqual([]);

    const result = sweepTempRunRoots({
      tempRoot,
      orphanedTempRunRetentionMs: 6 * HOUR,
      oneShotRunRetentionMs: DAY,
      now: 6 * HOUR + 2,
    });

    expect(result.removedRoots).toEqual([runRoot]);
    expect(fs.existsSync(runRoot)).toBe(false);
  });

  it("keeps live roots and the current root out of orphan cleanup", () => {
    const tempRoot = temporaryDirectory();
    const liveRoot = path.join(tempRoot, FABRIC_RUN_ROOT_PREFIX + "live");
    markRunRootActive(liveRoot, 1);

    const result = sweepTempRunRoots({
      tempRoot,
      currentRoot: liveRoot,
      orphanedTempRunRetentionMs: 6 * HOUR,
      oneShotRunRetentionMs: DAY,
      now: 30 * DAY,
    });

    expect(result.removedRoots).toEqual([]);
    expect(fs.existsSync(liveRoot)).toBe(true);
  });

  it("expires terminal one-shot runs from gracefully retained roots after 24 hours", () => {
    const tempRoot = temporaryDirectory();
    const runRoot = path.join(tempRoot, FABRIC_RUN_ROOT_PREFIX + "closed");
    markRunRootActive(runRoot, 1);
    const expired = path.join(runRoot, "expired");
    const fresh = path.join(runRoot, "fresh");
    const actorTemp = path.join(runRoot, "actor-temp");
    writeStatus(expired, { status: "completed", finishedAt: DAY });
    writeStatus(fresh, { status: "completed", finishedAt: 2 * DAY });
    writeStatus(actorTemp, { status: "failed", actorId: "actor-1", finishedAt: DAY });
    markRunRootClosed(runRoot, 2 * DAY);

    const result = sweepTempRunRoots({
      tempRoot,
      orphanedTempRunRetentionMs: 6 * HOUR,
      oneShotRunRetentionMs: DAY,
      now: 2 * DAY + 1,
    });

    expect(result.removedRuns.sort()).toEqual([actorTemp, expired].sort());
    expect(fs.existsSync(expired)).toBe(false);
    expect(fs.existsSync(actorTemp)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it("reclaims pi-durable journals with their run, but keeps unknown or linked journal contents (#229)", () => {
    const tempRoot = temporaryDirectory();
    const journal = (run: string, key = "initial") => {
      const store = path.join(run, "durable", key, "store");
      fs.mkdirSync(store, { recursive: true });
      fs.writeFileSync(path.join(store, "..", "lease.sqlite"), "");
      for (const name of ["main.jsonl", "doc-0.jsonl", "task-12.jsonl", "doc-3.jsonl.reclaim"]) fs.writeFileSync(path.join(store, name), "{}\n");
      return store;
    };
    const runRoot = path.join(tempRoot, FABRIC_RUN_ROOT_PREFIX + "durable");
    markRunRootActive(runRoot, 1);
    const plain = path.join(runRoot, "plain");
    writeStatus(plain, { status: "completed", finishedAt: DAY });
    journal(plain);
    journal(plain, "a".repeat(64));
    const nested = path.join(runRoot, "parent");
    writeStatus(nested, { status: "completed", finishedAt: DAY });
    journal(nested);
    writeStatus(path.join(nested, "nested", "child"), { status: "completed", finishedAt: DAY });
    journal(path.join(nested, "nested", "child"));
    const unknown = path.join(runRoot, "unknown");
    writeStatus(unknown, { status: "completed", finishedAt: DAY });
    fs.writeFileSync(path.join(journal(unknown), "notes.txt"), "not Fabric's");
    const badKey = path.join(runRoot, "bad-key");
    writeStatus(badKey, { status: "completed", finishedAt: DAY });
    journal(badKey, "other");
    const outside = path.join(temporaryDirectory(), "outside.jsonl");
    fs.writeFileSync(outside, "keep");
    const linked = path.join(runRoot, "linked");
    writeStatus(linked, { status: "completed", finishedAt: DAY });
    fs.symlinkSync(outside, path.join(journal(linked), "doc-1.jsonl"));
    markRunRootClosed(runRoot, DAY, true);

    const result = sweepAt(tempRoot, 2 * DAY + 1);
    expect(result.removedRuns.sort()).toEqual([nested, plain].sort());
    for (const kept of [unknown, badKey, linked]) expect(fs.existsSync(kept)).toBe(true);
    expect(fs.readFileSync(outside, "utf8")).toBe("keep");
  });

  const forkEntries = (): SessionEntry[] => [
    { type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "hello", timestamp: 1 } },
    { type: "message", id: "a1", parentId: "u1", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 2 } },
  ] as unknown as SessionEntry[];
  // The real writer, into the directory the manager gives it, so the layout is not guessed.
  const forkRun = (runRoot: string, name: string): { run: string; fork: string } => {
    const run = path.join(runRoot, name);
    writeStatus(run, { status: "completed", finishedAt: DAY });
    const fork = path.join(run, "fork-session");
    writeForkSession({ sourceSessionId: "caller", sourceBranch: forkEntries() }, run, fork);
    return { run, fork };
  };

  it("reclaims a forked run's fork-session with its run, but keeps unknown, linked, hard-linked, or nested contents", () => {
    const tempRoot = temporaryDirectory();
    const runRoot = path.join(tempRoot, FABRIC_RUN_ROOT_PREFIX + "fork");
    markRunRootActive(runRoot, 1);
    const plain = forkRun(runRoot, "plain");
    expect(fs.readdirSync(plain.fork)).toHaveLength(1);
    const unknown = forkRun(runRoot, "unknown");
    fs.writeFileSync(path.join(unknown.fork, "notes.txt"), "not Fabric's");
    const wrongName = forkRun(runRoot, "wrong-name");
    fs.writeFileSync(path.join(wrongName.fork, "other.jsonl"), "{}\n");
    const outside = path.join(temporaryDirectory(), "outside.jsonl");
    fs.writeFileSync(outside, "keep");
    const linked = forkRun(runRoot, "linked");
    fs.symlinkSync(outside, path.join(linked.fork, "handoff-00000000-0000-4000-8000-000000000000.jsonl"));
    const hardLinked = forkRun(runRoot, "hard-linked");
    fs.linkSync(path.join(hardLinked.fork, fs.readdirSync(hardLinked.fork)[0]!), path.join(temporaryDirectory(), "alias.jsonl"));
    const nested = forkRun(runRoot, "nested-dir");
    fs.mkdirSync(path.join(nested.fork, "sub"));
    const linkedDirectory = forkRun(runRoot, "linked-dir");
    fs.rmSync(linkedDirectory.fork, { recursive: true });
    const outsideDirectory = temporaryDirectory();
    fs.symlinkSync(outsideDirectory, linkedDirectory.fork);
    markRunRootClosed(runRoot, DAY, true);

    const result = sweepAt(tempRoot, 2 * DAY + 1);
    expect(result.removedRuns).toEqual([plain.run]);
    for (const kept of [unknown, wrongName, linked, hardLinked, nested, linkedDirectory]) expect(fs.existsSync(kept.run)).toBe(true);
    expect(fs.readFileSync(outside, "utf8")).toBe("keep");
    expect(fs.existsSync(outsideDirectory)).toBe(true);
  });

  it("reclaims a forked run whose owner died, once the orphan grace passes", () => {
    const tempRoot = temporaryDirectory();
    const runRoot = path.join(tempRoot, FABRIC_RUN_ROOT_PREFIX + "fork-orphan");
    fs.mkdirSync(runRoot);
    fs.writeFileSync(path.join(runRoot, ".fabric-owner.json"), JSON.stringify({ pid: 2_147_483_647, startedAt: 1, heartbeatAt: 1 }));
    forkRun(runRoot, "run");
    expect(sweepAt(tempRoot, 2).removedRoots).toEqual([]);
    expect(sweepAt(tempRoot, 6 * HOUR + 2).removedRoots).toEqual([runRoot]);
  });

  it("reclaims the oversized-event artifact and record temp files a crash leaves, but not lookalikes or links", () => {
    const tempRoot = temporaryDirectory();
    const runRoot = path.join(tempRoot, FABRIC_RUN_ROOT_PREFIX + "artifacts");
    markRunRootActive(runRoot, 1);
    const uuid = "123e4567-e89b-42d3-a456-426614174000";
    const run = (name: string, files: Record<string, string>): string => {
      const directory = path.join(runRoot, name);
      writeStatus(directory, { status: "failed", finishedAt: DAY });
      for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(directory, file), text);
      return directory;
    };
    const artifacts = run("artifacts", {
      "oversized-event-prefix.txt": "x".repeat(64),
      "status.json.4242.tmp": "{",
      [`status.json.4242.${uuid}.tmp`]: "{",
      [`hosted.json.4242.${uuid}.tmp`]: "{",
    });
    const lookalikes = ["status.json.bak", "status.json.4242.tmp.old", "task.txt.4242.tmp", "oversized-event-prefix.txt.bak", "events.jsonl.4242.tmp"]
      .map((file) => run(`look-${file}`, { [file]: "mine" }));
    const outside = path.join(temporaryDirectory(), "outside.txt");
    fs.writeFileSync(outside, "keep");
    const linked = run("linked", {});
    fs.symlinkSync(outside, path.join(linked, "oversized-event-prefix.txt"));
    const linkedTemp = run("linked-temp", {});
    fs.symlinkSync(outside, path.join(linkedTemp, "status.json.4242.tmp"));
    const directoryNamed = run("directory-named", {});
    fs.mkdirSync(path.join(directoryNamed, "oversized-event-prefix.txt"));
    markRunRootClosed(runRoot, DAY, true);

    const result = sweepAt(tempRoot, 2 * DAY + 1);
    expect(result.removedRuns).toEqual([artifacts]);
    for (const kept of [...lookalikes, linked, linkedTemp, directoryNamed]) expect(fs.existsSync(kept)).toBe(true);
    expect(fs.readFileSync(outside, "utf8")).toBe("keep");
  });

  it("reclaims a settled hosted run's hosted.json, but keeps it while the run could still be re-attached", () => {
    const tempRoot = temporaryDirectory();
    const runRoot = path.join(tempRoot, FABRIC_RUN_ROOT_PREFIX + "hosted");
    markRunRootActive(runRoot, 1);
    const hosted = (name: string, record: Record<string, unknown>): string => {
      const directory = path.join(runRoot, name);
      writeStatus(directory, { transport: "hosted", ...record });
      fs.writeFileSync(path.join(directory, "task.txt"), "task");
      fs.writeFileSync(path.join(directory, "hosted.json"), "{}");
      return directory;
    };
    const settled = hosted("settled", { status: "completed", finishedAt: DAY });
    const running = hosted("running", { status: "running", updatedAt: DAY });
    const outside = path.join(temporaryDirectory(), "locator.json");
    fs.writeFileSync(outside, "keep");
    const linked = path.join(runRoot, "linked");
    writeStatus(linked, { transport: "hosted", status: "completed", finishedAt: DAY });
    fs.symlinkSync(outside, path.join(linked, "hosted.json"));
    markRunRootClosed(runRoot, DAY, true);

    const result = sweepAt(tempRoot, 3 * DAY);
    expect(result.removedRuns).toEqual([settled]);
    expect(fs.existsSync(running)).toBe(true);
    expect(fs.existsSync(linked)).toBe(true);
    expect(fs.readFileSync(outside, "utf8")).toBe("keep");
  });

  it("removes a dead owner's root holding pi-durable journals after the orphan grace (#229)", () => {
    const tempRoot = temporaryDirectory();
    const runRoot = path.join(tempRoot, FABRIC_RUN_ROOT_PREFIX + "durable-orphan");
    fs.mkdirSync(runRoot);
    fs.writeFileSync(path.join(runRoot, ".fabric-owner.json"), JSON.stringify({ pid: 2_147_483_647, startedAt: 1, heartbeatAt: 1 }));
    const run = path.join(runRoot, "run");
    writeStatus(run, { status: "completed", finishedAt: 1 });
    fs.mkdirSync(path.join(run, "durable", "initial", "store"), { recursive: true });
    fs.writeFileSync(path.join(run, "durable", "initial", "lease.sqlite"), "");
    fs.writeFileSync(path.join(run, "durable", "initial", "store", "main.jsonl"), "{}\n");
    expect(sweepAt(tempRoot, 2).removedRoots).toEqual([]);
    expect(sweepAt(tempRoot, 6 * HOUR + 2).removedRoots).toEqual([runRoot]);
  });

  it("expires actor archives after seven days while preserving the latest run", () => {
    const root = temporaryDirectory();
    const runsDirectory = path.join(root, "runs");
    const expired = path.join(runsDirectory, "expired");
    const latest = path.join(runsDirectory, "latest");
    const fresh = path.join(runsDirectory, "fresh");
    writeStatus(expired, { status: "completed", finishedAt: DAY });
    writeStatus(latest, { status: "completed", finishedAt: DAY });
    writeStatus(fresh, { status: "completed", finishedAt: 8 * DAY });

    const removed = pruneActorRunArchives({
      runsDirectory,
      latestRunId: "latest",
      retentionMs: 7 * DAY,
      now: 8 * DAY + 1,
    });

    expect(removed).toEqual([expired]);
    expect(fs.existsSync(expired)).toBe(false);
    expect(fs.existsSync(latest)).toBe(true);
    expect(fs.existsSync(fresh)).toBe(true);
  });
});
