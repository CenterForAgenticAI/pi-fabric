import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agents/manager.js";
import {
  probeWorker,
  readWorkerRecovery,
  WORKER_RECOVERY_FILE,
} from "../src/agents/worker-recovery.js";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";

const managers: AgentManager[] = [];
const roots: string[] = [];
const pids: number[] = [];

const manager = (root: string, durableWorkerRecovery: boolean): AgentManager => {
  const created = new AgentManager(
    process.cwd(),
    {
      ...DEFAULT_FABRIC_CONFIG.agents,
      budgetUsd: 0,
      retainRuns: true,
      transport: "process",
      sessionExport: false,
      durableWorkerRecovery,
    },
    { workerPath: path.resolve("tests/fixtures/fake-worker.mjs"), runRoot: root },
  );
  managers.push(created);
  return created;
};

const until = async (condition: () => boolean, label: string, timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const readStatus = (runDirectory: string): Record<string, unknown> | undefined => {
  try {
    return JSON.parse(fs.readFileSync(path.join(runDirectory, "status.json"), "utf8"));
  } catch {
    return undefined;
  }
};

/** Launch a durable pi-durable REATTACH run and close its host, leaving the worker. */
const orphanedRun = async (durableWorkerRecovery = true) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-worker-recovery-"));
  roots.push(root);
  vi.stubEnv("PI_FABRIC_DEPTH", "0");
  const first = manager(root, durableWorkerRecovery);
  const handle = await first.spawn({
    task: "REATTACH",
    runner: "pi-durable",
    residency: "durable",
    extensions: false,
  });
  const runDirectory = path.join(root, handle.id);
  await until(() => readStatus(runDirectory)?.status === "running", "the first attempt to start");
  const recovery = readWorkerRecovery(runDirectory);
  if (recovery) pids.push(recovery.pid);
  await first.close();
  return { root, id: handle.id, runDirectory, pid: recovery?.pid };
};

afterEach(async () => {
  await Promise.allSettled(managers.splice(0).map((created) => created.close()));
  for (const pid of pids.splice(0)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("pi-durable worker recovery after a host restart (#314)", () => {
  it("leaves an opted-in durable worker running when its host closes, and a new host re-attaches it", async () => {
    const { root, id, runDirectory, pid } = await orphanedRun();
    expect(pid).toBeTypeOf("number");
    // The closing host did not stop the worker and kept its recovery file.
    expect(alive(pid!)).toBe(true);
    expect(fs.existsSync(path.join(runDirectory, WORKER_RECOVERY_FILE))).toBe(true);
    expect(readStatus(runDirectory)?.status).toBe("running");

    const second = manager(root, true);
    expect(await second.recoverWorkerRuns()).toEqual([id]);
    fs.writeFileSync(path.join(runDirectory, "release"), "");
    const result = await second.wait(id);

    expect(result.status).toBe("completed");
    // The original attempt finished: it was adopted, not relaunched.
    expect(result.text).toBe("reattach attempt 1");
    expect(fs.readFileSync(path.join(runDirectory, "reattach-attempts"), "utf8")).toBe("1");
    expect(fs.existsSync(path.join(runDirectory, WORKER_RECOVERY_FILE))).toBe(false);
  }, 30_000);

  it("relaunches a dead durable worker on the same run directory with its progress carried over", async () => {
    const { root, id, runDirectory, pid } = await orphanedRun();
    process.kill(-pid!, "SIGKILL");
    await until(() => !alive(pid!), "the worker to die");

    const second = manager(root, true);
    expect(await second.recoverWorkerRuns()).toEqual([id]);
    const relaunched = readWorkerRecovery(runDirectory);
    expect(relaunched?.pid).not.toBe(pid);
    pids.push(relaunched!.pid);
    fs.writeFileSync(path.join(runDirectory, "release"), "");
    const result = await second.wait(id);

    expect(result.status).toBe("completed");
    expect(result.text).toBe("reattach attempt 2");
    // The durable runner keeps its prompt identity across the relaunch.
    expect(result.task).toBe("REATTACH");
    // Attempt 1 recorded 2 turns and 1 tool call; attempt 2 starts from that prefix.
    expect(result.turns).toBe(4);
    expect(result.toolCalls).toBe(2);
  }, 30_000);

  it("settles a run whose deadline passed while no host owned it as indeterminate", async () => {
    const { root, id, runDirectory, pid } = await orphanedRun();
    process.kill(-pid!, "SIGKILL");
    await until(() => !alive(pid!), "the worker to die");
    const file = path.join(runDirectory, WORKER_RECOVERY_FILE);
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), deadlineAt: Date.now() - 1 }));

    const second = manager(root, true);
    expect(await second.recoverWorkerRuns()).toEqual([]);
    const status = readStatus(runDirectory);
    expect(status?.id).toBe(id);
    expect(status?.status).toBe("failed");
    expect(status?.outcome).toBe("indeterminate");
    expect(status?.error).toBe(
      "The durable worker run passed its deadline while no resident host owned it; the run outcome is indeterminate",
    );
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(path.join(runDirectory, "reattach-attempts"))).toBe(true);
    expect(fs.readFileSync(path.join(runDirectory, "reattach-attempts"), "utf8")).toBe("1");
  }, 30_000);

  it("does not recover a run Fabric stopped on request", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-worker-recovery-"));
    roots.push(root);
    vi.stubEnv("PI_FABRIC_DEPTH", "0");
    const first = manager(root, true);
    const handle = await first.spawn({ task: "REATTACH", runner: "pi-durable", residency: "durable", extensions: false });
    const runDirectory = path.join(root, handle.id);
    await until(() => readStatus(runDirectory)?.status === "running", "the worker to start");
    expect(fs.existsSync(path.join(runDirectory, WORKER_RECOVERY_FILE))).toBe(true);
    await first.stop(handle.id);
    expect(fs.existsSync(path.join(runDirectory, WORKER_RECOVERY_FILE))).toBe(false);

    const second = manager(root, true);
    expect(await second.recoverWorkerRuns()).toEqual([]);
    expect(readStatus(runDirectory)?.status).toBe("stopped");
  }, 30_000);

  it("keeps today's behaviour when agents.durableWorkerRecovery is off", async () => {
    const { root, runDirectory } = await orphanedRun(false);
    expect(fs.existsSync(path.join(runDirectory, WORKER_RECOVERY_FILE))).toBe(false);
    // The closing host stopped the worker as before.
    expect(readStatus(runDirectory)?.status).not.toBe("running");
    const second = manager(root, true);
    expect(await second.recoverWorkerRuns()).toEqual([]);
  }, 30_000);
});

describe("probeWorker", () => {
  const id = "a".repeat(32);
  it("accepts a live process whose command line carries the run id", () => {
    expect(probeWorker(4242, id, {
      signal: () => "exists",
      commandLine: () => `/usr/bin/node /x/worker.js --id ${id} --name n`,
    })).toBe("alive");
  });
  it("treats a reused PID running something else as a dead worker", () => {
    expect(probeWorker(4242, id, {
      signal: () => "exists",
      commandLine: () => `/usr/bin/node /x/worker.js --id ${"c".repeat(32)}`,
    })).toBe("dead");
  });
  it("refuses to guess when the PID belongs to another user or its command line is unreadable", () => {
    expect(probeWorker(4242, id, { signal: () => "unknown", commandLine: () => `--id ${id}` })).toBe("unknown");
    expect(probeWorker(4242, id, { signal: () => "exists", commandLine: () => undefined })).toBe("unknown");
  });
  it("reports a missing PID as dead", () => {
    expect(probeWorker(4242, id, { signal: () => "missing", commandLine: () => `--id ${id}` })).toBe("dead");
  });
  it("sees this process's own command line through the default probes", () => {
    expect(probeWorker(process.pid, id)).toBe("dead");
  });
});
