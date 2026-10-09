import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agents/manager.js";
import { DEFAULT_FABRIC_CONFIG, normalizeFabricConfig } from "../src/config.js";

// A managed run root may live under a configured parent instead of os.tmpdir()
// (a quota-limited tmpfs on some hosts). Every session still gets its own root.
const managers: AgentManager[] = [];
const dirs: string[] = [];
const scratch = (prefix: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
const rootsIn = (dir: string): string[] =>
  fs.readdirSync(dir).filter((name) => name.startsWith("pi-fabric-runs-")).map((name) => path.join(dir, name));
let tempRoot = "";
const manager = (retainRuns: boolean, runRootParent?: string): AgentManager => {
  const created = new AgentManager(process.cwd(), {
    ...DEFAULT_FABRIC_CONFIG.agents, budgetUsd: 0, maxConcurrent: 2, retainRuns, transport: "process", sessionExport: false,
    ...(runRootParent === undefined ? {} : { runRootParent }),
  }, { workerPath: path.resolve("tests/fixtures/fake-worker.mjs") });
  managers.push(created);
  return created;
};
const setup = () => {
  tempRoot = scratch("run-root-tmp-");
  vi.spyOn(os, "tmpdir").mockReturnValue(tempRoot);
  vi.stubEnv("PI_FABRIC_RUN_ROOT", undefined);
  vi.stubEnv("PI_FABRIC_RUN_ROOT_PARENT", undefined);
  vi.stubEnv("PI_FABRIC_DEPTH", "0");
  for (const key of ["PI_FABRIC_BUDGET", "PI_FABRIC_BUDGET_FILE", "PI_FABRIC_BUDGET_ID"]) vi.stubEnv(key, undefined);
};
afterEach(async () => {
  await Promise.allSettled(managers.splice(0).map((created) => created.close()));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("AgentManager run root parent", () => {
  it("reads agents.runRootParent from Fabric config", () => {
    expect(normalizeFabricConfig({ agents: { runRootParent: "/var/tmp/fabric" } }).agents.runRootParent).toBe("/var/tmp/fabric");
    expect(normalizeFabricConfig({ agents: { runRootParent: 42 } }).agents.runRootParent).toBeUndefined();
  });

  it("gives two sessions with the same parent separate roots, and one session's close never deletes the other's", async () => {
    setup();
    const parent = path.join(scratch("run-root-parent-"), "not-yet-created");
    const first = manager(false, parent);
    const second = manager(false, parent);
    const roots = rootsIn(parent);
    expect(roots).toHaveLength(2);
    expect(rootsIn(tempRoot)).toEqual([]);
    const live = await second.spawn({ task: "HANG", runner: "pi", extensions: false });
    await first.spawn({ task: "HANG", runner: "pi", extensions: false });
    const secondRoot = roots.find((root) => fs.existsSync(path.join(root, live.id)))!;
    expect(secondRoot).toBeDefined();
    // retainRuns:false asks the closing session to delete its own root, not the shared parent.
    await first.close();
    expect(rootsIn(parent)).toEqual([secondRoot]);
    expect(fs.existsSync(path.join(secondRoot, live.id, "task.txt"))).toBe(true);
    await second.close();
    expect(fs.existsSync(parent)).toBe(true);
  });

  it("lets PI_FABRIC_RUN_ROOT_PARENT override the configured parent", () => {
    setup();
    const configured = scratch("run-root-config-");
    const fromEnv = scratch("run-root-env-");
    vi.stubEnv("PI_FABRIC_RUN_ROOT_PARENT", fromEnv);
    manager(true, configured);
    expect(rootsIn(fromEnv)).toHaveLength(1);
    expect(rootsIn(configured)).toEqual([]);
  });

  it("ignores a relative parent instead of creating run roots in the working directory", () => {
    setup();
    const cwd = scratch("run-root-cwd-");
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
    manager(true, "fabric-runs");
    expect(fs.existsSync(path.join(cwd, "fabric-runs"))).toBe(false);
    expect(fs.readdirSync(cwd)).toEqual([]);
    expect(rootsIn(tempRoot)).toHaveLength(1);
  });

  it("ignores a parent inside another session's run root, so that session's cleanup cannot reach it", async () => {
    setup();
    const owner = manager(false);
    const [ownerRoot] = rootsIn(tempRoot);
    const nested = manager(false, ownerRoot);
    expect(rootsIn(ownerRoot!)).toEqual([]);
    expect(rootsIn(tempRoot)).toHaveLength(2);
    await owner.close();
    expect(rootsIn(tempRoot)).toHaveLength(1);
    await nested.close();
  });

  it("ignores a symlinked parent that leads into another session's run root", async () => {
    setup();
    const owner = manager(false);
    const [ownerRoot] = rootsIn(tempRoot);
    const link = path.join(scratch("run-root-link-"), "parent");
    fs.symlinkSync(ownerRoot!, link);
    manager(false, link);
    manager(false, path.join(link, "child"));
    // Nothing at all may be created inside the other session's root.
    expect(fs.readdirSync(ownerRoot!)).toEqual([".fabric-owner.json"]);
    expect(rootsIn(tempRoot)).toHaveLength(3);
    await owner.close();
  });

  it("sweeps dead sessions' roots in the configured parent and in the old temporary directory", async () => {
    setup();
    const parent = scratch("run-root-parent-");
    const dead = { pid: 2147483647, startedAt: 1, heartbeatAt: 1, orphanedAt: 1 };
    const orphans = [path.join(parent, "pi-fabric-runs-deadA1"), path.join(tempRoot, "pi-fabric-runs-deadB2")];
    for (const orphan of orphans) {
      fs.mkdirSync(orphan);
      fs.writeFileSync(path.join(orphan, ".fabric-owner.json"), JSON.stringify(dead));
    }
    const created = manager(true, parent);
    await created.close();
    expect(orphans.filter((orphan) => fs.existsSync(orphan))).toEqual([]);
  });
});
