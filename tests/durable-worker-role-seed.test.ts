import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createDurableSessionFile, seedDurableWorkerRole } from "../src/durable/worker-role-seed.js";

// The literal payload pi-context-aware reads as the host-declared worker role.
// Written out here on purpose: never imported from the code under test.
const workerPolicy = {
  schemaVersion: 1, layer: "host", declaredBy: "pi-fabric/durable-worker", values: { sessionRole: "worker" },
};
const roots: string[] = [];
const temporary = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-role-seed-"));
  roots.push(root);
  return root;
};
afterAll(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

const header = { type: "session", version: 3, id: "hdr", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/work" };
const custom = (id: string, parentId: string | null, customType: string, data: unknown) =>
  ({ type: "custom", customType, data, id, parentId, timestamp: "2026-01-01T00:00:01.000Z" });
const text = (entries: unknown[]) => entries.map(entry => JSON.stringify(entry)).join("\n") + "\n";
const parse = (file: string) => fs.readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
const policies = (entries: any[]) => entries.filter(entry => entry.type === "custom" && entry.customType === "context-aware.policy.v1");
/** The entries Pi itself puts on the active branch when it opens the file. */
const piBranch = (file: string, cwd: string) => SessionManager.open(file, path.dirname(file), cwd).getBranch() as any[];
const ownedFile = (entries: unknown[] | string) => {
  const run = temporary();
  const folder = path.join(run, "durable-session");
  fs.mkdirSync(folder, { mode: 0o700 });
  const file = path.join(folder, "session.jsonl");
  fs.writeFileSync(file, typeof entries === "string" ? entries : text(entries), { mode: 0o600 });
  return { run, file };
};

describe("durable worker-role seed: folder safety", () => {
  it.skipIf(process.platform === "win32")("fails the launch when durable-session is a link, touching nothing behind it", () => {
    const run = temporary();
    const target = temporary();
    fs.chmodSync(target, 0o755);
    fs.symlinkSync(target, path.join(run, "durable-session"), "dir");
    expect(() => createDurableSessionFile(run, run)).toThrow(/real directory, not a link/);
    expect(fs.readdirSync(target)).toEqual([]);
    expect(fs.statSync(target).mode & 0o777).toBe(0o755);
  });

  it("creates the folder 0700 under an existing run directory, and never creates the run directory", () => {
    const run = temporary();
    const file = createDurableSessionFile(run, run);
    expect(file).toBe(path.join(run, "durable-session", "session.jsonl"));
    if (process.platform !== "win32") {
      expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
    expect(() => createDurableSessionFile(path.join(run, "missing", "run"), run)).toThrow();
    expect(fs.existsSync(path.join(run, "missing"))).toBe(false);
  });
});

describe("durable worker-role seed: provenance", () => {
  it.each(["durable-session", "fork-session", "handoff-session"])("never edits a file the launcher did not mark as created by Fabric, even in %s/", folder => {
    const run = temporary();
    fs.mkdirSync(path.join(run, folder), { mode: 0o700 });
    const file = path.join(run, folder, "caller.jsonl");
    fs.writeFileSync(file, text([header]));
    const before = fs.readFileSync(file, "utf8");
    expect(seedDurableWorkerRole(file, { runDirectory: run, cwd: "/work", owned: false })).toBe("not-owned");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it("does not touch an owned-flagged file outside the run's session folders", () => {
    const run = temporary();
    const file = path.join(run, "elsewhere.jsonl");
    fs.writeFileSync(file, text([header]));
    expect(seedDurableWorkerRole(file, { runDirectory: run, cwd: "/work", owned: true })).toBe("not-owned");
    expect(fs.readFileSync(file, "utf8")).toBe(text([header]));
  });

  it.skipIf(process.platform === "win32")("refuses a hardlinked file and leaves the other name unchanged", () => {
    const { run, file } = ownedFile([header]);
    const other = path.join(run, "other-name.jsonl");
    fs.linkSync(file, other);
    const before = fs.readFileSync(other, "utf8");
    expect(() => seedDurableWorkerRole(file, { runDirectory: run, cwd: "/work", owned: true })).toThrow(/exactly one name/);
    expect(fs.readFileSync(other, "utf8")).toBe(before);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it.skipIf(process.platform === "win32")("refuses a session file that is itself a link", () => {
    const { run, file } = ownedFile([header]);
    const real = path.join(run, "real.jsonl");
    fs.renameSync(file, real);
    fs.symlinkSync(real, file);
    expect(() => seedDurableWorkerRole(file, { runDirectory: run, cwd: "/work", owned: true })).toThrow();
    expect(fs.readFileSync(real, "utf8")).toBe(text([header]));
  });
});

describe("durable worker-role seed: the branch Pi opens", () => {
  it("appends a policy on the active branch when the only valid entry is on another branch", () => {
    // header, A (root), P (policy, child of A), B (sibling of P, child of A). Pi opens at B, the last entry.
    const { run, file } = ownedFile([
      header,
      custom("A", null, "test.root", {}),
      custom("P", "A", "context-aware.policy.v1", workerPolicy),
      custom("B", "A", "test.sibling", {}),
    ]);
    const before = fs.readFileSync(file, "utf8");
    expect(piBranch(file, "/work").map(entry => entry.id)).toEqual(["A", "B"]); // Pi's own leaf rule, not ours
    expect(seedDurableWorkerRole(file, { runDirectory: run, cwd: "/work", owned: true })).toBe("seeded");
    const after = fs.readFileSync(file, "utf8");
    expect(after.startsWith(before)).toBe(true);
    const added = parse(file).at(-1);
    expect(added).toMatchObject({ type: "custom", customType: "context-aware.policy.v1", parentId: "B" });
    expect(added.data).toEqual(workerPolicy);
    const branch = piBranch(file, "/work");
    expect(branch.map(entry => entry.id)).toEqual(["A", "B", added.id]);
    expect(policies(branch)).toHaveLength(1);
    expect(seedDurableWorkerRole(file, { runDirectory: run, cwd: "/work", owned: true })).toBe("already-seeded");
    expect(fs.readFileSync(file, "utf8")).toBe(after);
  });

  it.each([
    ["wrong role", { ...workerPolicy, values: { sessionRole: "user" } }],
    ["extra field", { ...workerPolicy, extra: true }],
    ["missing layer", { schemaVersion: 1, declaredBy: "pi-fabric/durable-worker", values: { sessionRole: "worker" } }],
    ["not an object", "pi-fabric/durable-worker"],
  ])("appends a valid policy when a matching-declaredBy entry has an invalid payload: %s", (_name, data) => {
    const { run, file } = ownedFile([header, custom("A", null, "context-aware.policy.v1", data)]);
    expect(seedDurableWorkerRole(file, { runDirectory: run, cwd: "/work", owned: true })).toBe("seeded");
    const added = parse(file).at(-1);
    expect(added).toMatchObject({ parentId: "A" });
    expect(added.data).toEqual(workerPolicy);
    expect(policies(piBranch(file, "/work")).filter(entry => JSON.stringify(entry.data) === JSON.stringify(workerPolicy))).toHaveLength(1);
  });

  it("leaves a file alone when a valid entry is on the active branch below later history", () => {
    const { run, file } = ownedFile([
      header,
      custom("A", null, "context-aware.policy.v1", workerPolicy),
      custom("B", "A", "test.turn", {}),
    ]);
    const before = fs.readFileSync(file, "utf8");
    expect(seedDurableWorkerRole(file, { runDirectory: run, cwd: "/work", owned: true })).toBe("already-seeded");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it("starts a new line when a crash left an unterminated last line", () => {
    const { run, file } = ownedFile(text([header, custom("A", null, "test.root", {})]) + '{"type":"custom","cust');
    expect(seedDurableWorkerRole(file, { runDirectory: run, cwd: "/work", owned: true })).toBe("seeded");
    expect(policies(piBranch(file, "/work"))).toHaveLength(1);
  });
});

describe("durable worker-role seed: unreadable files fail the launch", () => {
  it.each([
    ["a partial header", '{"type":"sess'],
    ["no session header", text([custom("A", null, "test.root", {})])],
    ["a header that is not first", text([custom("A", null, "test.root", {}), header])],
  ])("throws a clear error and leaves the file unchanged: %s", (_name, content) => {
    const { run, file } = ownedFile(content);
    expect(() => seedDurableWorkerRole(file, { runDirectory: run, cwd: "/work", owned: true }))
      .toThrow(/not a Pi session \(no session header\); refusing to launch/);
    expect(fs.readFileSync(file, "utf8")).toBe(content);
  });
});

describe("durable-session creation is atomic", () => {
  const leftovers = (folder: string) => fs.readdirSync(folder).filter(name => name !== "session.jsonl");

  it("writes the header and exactly one policy entry in a file that never exists half-written", () => {
    const run = temporary();
    let seenAtLink: string[] = [];
    const file = createDurableSessionFile(run, "/work", {
      beforeLink: () => {
        const folder = path.join(run, "durable-session");
        seenAtLink = fs.readdirSync(folder);
      },
    });
    expect(seenAtLink.some(name => /^tmp-.*\.jsonl$/.test(name))).toBe(true);
    expect(seenAtLink).not.toContain("session.jsonl"); // session.jsonl appears only complete, by link
    const entries = parse(file);
    expect(entries.map(entry => entry.type)).toEqual(["session", "custom"]);
    expect(entries[0]).toMatchObject({ version: 3, cwd: "/work" });
    expect(entries[1]).toMatchObject({ customType: "context-aware.policy.v1", parentId: null });
    expect(entries[1].data).toEqual(workerPolicy);
    expect(leftovers(path.dirname(file))).toEqual([]);
    expect(fs.statSync(file).nlink).toBe(1);
  });

  it("lets exactly one of two racing creators win, and the loser keeps the winner's file", () => {
    const run = temporary();
    const folder = path.join(run, "durable-session");
    let winnerBytes = "";
    // Creator A pauses just before its link; creator B runs to completion in that gap.
    const fileA = createDurableSessionFile(run, "/work-a", {
      beforeLink: () => {
        const fileB = createDurableSessionFile(run, "/work-b");
        winnerBytes = fs.readFileSync(fileB, "utf8");
      },
    });
    expect(winnerBytes).not.toBe("");
    expect(fs.readFileSync(fileA, "utf8")).toBe(winnerBytes); // A did not overwrite or append to B's file
    const entries = parse(fileA);
    expect(entries.filter(entry => entry.type === "session")).toHaveLength(1);
    expect(policies(entries)).toHaveLength(1);
    expect(entries[0].cwd).toBe("/work-b");
    expect(leftovers(folder)).toEqual([]);
    expect(seedDurableWorkerRole(fileA, { runDirectory: run, cwd: "/work-a", owned: true })).toBe("already-seeded");
  });

  it.skipIf(process.platform === "win32")("removes its own temp name when a crash left it linked next to session.jsonl", () => {
    const run = temporary();
    const file = createDurableSessionFile(run, "/work");
    const stray = path.join(path.dirname(file), "tmp-00000000-0000-4000-8000-000000000000.jsonl");
    fs.linkSync(file, stray); // crash between link and unlink
    expect(fs.statSync(file).nlink).toBe(2);
    createDurableSessionFile(run, "/work"); // the relaunch
    expect(fs.existsSync(stray)).toBe(false);
    expect(fs.statSync(file).nlink).toBe(1);
    expect(seedDurableWorkerRole(file, { runDirectory: run, cwd: "/work", owned: true })).toBe("already-seeded");
  });

  it("reuses an existing session file byte for byte", () => {
    const run = temporary();
    const file = createDurableSessionFile(run, "/work");
    fs.appendFileSync(file, JSON.stringify(custom("zz", parse(file).at(-1).id, "test.turn", {})) + "\n");
    const before = fs.readFileSync(file, "utf8");
    expect(createDurableSessionFile(run, "/work")).toBe(file);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });
});
