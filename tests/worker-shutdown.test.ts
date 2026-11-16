import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agents/manager.js";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";

const managers: AgentManager[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.close()));
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const setup = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-shutdown-"));
  roots.push(root);
  vi.stubEnv("HOME", root);
  vi.stubEnv("PI_CODING_AGENT_DIR", path.join(root, "agent"));
  vi.stubEnv("FABRIC_SHUTDOWN_ROOT", root);
  const manager = new AgentManager(root, {
    ...DEFAULT_FABRIC_CONFIG.agents, runner: "pi", timeoutMs: 30_000, maxConcurrent: 1,
  }, {
    workerPath: path.resolve("src/worker.ts"),
    piBinary: path.resolve("tests/fixtures/pi-rpc-shutdown.mjs"),
    runRoot: path.join(root, "runs"), fullCodeMode: false,
  });
  managers.push(manager);
  return { root, manager };
};

// Seam: AgentManager.stop -> real worker -> real Pi RPC extension lifecycle.
describe("Pi child graceful stop", () => {
  it("finishes session_shutdown handlers when stopped with an open question", async () => {
    const { root, manager } = setup();
    const handle = await manager.spawn({ task: "wait", model: "shutdown/probe", transport: "process" });
    await vi.waitFor(() => {
      const status = manager.status(handle.id);
      expect(status.status, JSON.stringify(status)).toBe("running");
      expect(fs.existsSync(path.join(root, "ready"))).toBe(true);
    }, { timeout: 15_000 });
    const pid = Number(fs.readFileSync(path.join(root, "ready"), "utf8"));
    const result = await manager.stop(handle.id);
    expect(result.status).toBe("stopped");
    expect(fs.existsSync(path.join(root, "shutdown-finished"))).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow();
  }, 25_000);

  it("kills a child whose session_shutdown handler never returns within the stop bound", async () => {
    const { root, manager } = setup();
    fs.writeFileSync(path.join(root, "hang"), "hang");
    const handle = await manager.spawn({ task: "wait", model: "shutdown/probe", transport: "process" });
    await vi.waitFor(() => expect(fs.existsSync(path.join(root, "ready"))).toBe(true), { timeout: 15_000 });
    const pid = Number(fs.readFileSync(path.join(root, "ready"), "utf8"));
    const started = performance.now();
    const result = await manager.stop(handle.id);
    expect(performance.now() - started).toBeLessThan(7_000);
    expect(result.status).toBe("stopped");
    expect(fs.existsSync(path.join(root, "shutdown-started"))).toBe(true);
    expect(fs.existsSync(path.join(root, "shutdown-finished"))).toBe(false);
    expect(() => process.kill(pid, 0)).toThrow();
  }, 25_000);
});
