import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agents/manager.js";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";

const managers: AgentManager[] = [];
const roots: string[] = [];

const setup = (runRoot: string, workerPath = "tests/fixtures/fake-worker.mjs") => {
  vi.stubEnv("PI_FABRIC_DEPTH", "0");
  for (const key of ["PI_FABRIC_RUN_ROOT", "PI_FABRIC_BUDGET", "PI_FABRIC_BUDGET_FILE", "PI_FABRIC_BUDGET_ID"]) {
    vi.stubEnv(key, undefined);
  }
  const manager = new AgentManager(
    process.cwd(),
    { ...DEFAULT_FABRIC_CONFIG.agents, budgetUsd: 0, maxConcurrent: 1, transport: "process", sessionExport: false },
    { workerPath: path.resolve(workerPath), runRoot },
  );
  managers.push(manager);
  return manager;
};

const tempRoot = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-lifecycle-leaks-"));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.allSettled(managers.splice(0).map((manager) => manager.close()));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("AgentManager lifecycle leaks", () => {
  it("releases the concurrency slot when the run directory cannot be created", async () => {
    const root = tempRoot();
    // A file where the run root should be: creating <runRoot>/<id> fails
    // after admission and before any child exists.
    const runRoot = path.join(root, "runs");
    fs.writeFileSync(runRoot, "not a directory");
    const manager = setup(runRoot);

    await expect(manager.spawn({ task: "first", extensions: false })).rejects.toThrow();

    fs.rmSync(runRoot);
    fs.mkdirSync(runRoot);
    // maxConcurrent is 1: a leaked slot makes this run wait forever.
    const result = await manager.run({ task: "second", extensions: false });
    expect(result.status).toBe("completed");
  });
});
