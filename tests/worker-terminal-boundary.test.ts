import fs from "node:fs";
import { spawn } from "node:child_process";
import { ProcessTransport } from "../src/agents/transports/process-transport.js";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agents/manager.js";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";

const roots: string[] = [];
const managers: AgentManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.close()));
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
async function run(scenario: string, runner: "pi" | "claude" = "pi", cooperative = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pr2-boundary-"));
  roots.push(root);
  fs.writeFileSync(path.join(root, "scenario"), scenario);
  vi.stubEnv("HOME", root);
  vi.stubEnv("PI_CODING_AGENT_DIR", path.join(root, "agent"));
  vi.stubEnv("TERMINAL_PROBE_ROOT", root);
  vi.stubEnv("PI_FABRIC_AGENT_DIR", path.join(root, "export"));
  if (cooperative) {
    vi.stubEnv("TERMINAL_PROBE_COOPERATIVE", "1");
    // Public transport seam: real compiled worker and child, synthetic delivery
    // only. Native POSIX signal coverage remains a separate platform test.
    vi.spyOn(ProcessTransport.prototype, "launch").mockImplementation(async request => {
      const child = spawn(process.execPath, [request.workerPath, ...request.workerArguments], {
        cwd: request.cwd, stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      if (!child.pid) throw new Error("Failed to launch cooperative worker fixture");
      let alive = true;
      child.once("exit", () => { alive = false; });
      return { kind: "process", sessionId: String(child.pid),
        isAlive: async () => alive,
        stop: async () => { if (alive && child.connected) child.send("stop"); },
      };
    });
  }
  const completed = vi.fn();
  const lifecycle = vi.fn();
  const manager = new AgentManager(root, { ...DEFAULT_FABRIC_CONFIG.agents,
    timeoutMs: scenario.startsWith("timeout") ? 1500 : 10000,
    sessionExport: true, sessionExportDir: path.join(root, "export") }, {
    workerPath: path.resolve(cooperative ? "tests/fixtures/terminal-worker-cooperative.mjs" : "dist/worker.js"),
    piBinary: path.resolve("tests/fixtures/worker-terminal-boundary.mjs"),
    claudeBinary: path.resolve("tests/fixtures/worker-terminal-boundary.mjs"),
    runRoot: path.join(root, "runs"), onBackgroundComplete: completed, onLifecycle: lifecycle,
  });
  managers.push(manager);
  const sessionFile = path.join(root, "session.jsonl");
  const handle = await manager.spawn({ task: "synthetic review task", runner, extensions: false,
    transport: "process", ...(runner === "claude" ? { sessionFile } : {}) });
  manager.detachSignal(handle.id);
  if (scenario.startsWith("cancelled")) {
    await vi.waitFor(() => expect(fs.existsSync(path.join(root, "active"))).toBe(true), { timeout: 3000 });
    await manager.stop(handle.id);
  }
  if (!scenario.startsWith("cancelled")) await vi.waitFor(() => expect(completed).toHaveBeenCalledTimes(1), { timeout: 5000 });
  const result = await manager.wait(handle.id);
  expect(await manager.wait(handle.id)).toEqual(result);
  if (scenario.startsWith("cancelled")) expect(completed).not.toHaveBeenCalled();
  else expect(completed).toHaveBeenCalledExactlyOnceWith(result);
  expect(fs.readFileSync(path.join(root, "prompts"), "utf8")).toBe("1");
  const page = manager.readLog(result.id);
  const prefix = path.join(root, "runs", result.id, "oversized-event-prefix.txt");
  const exports = path.join(root, "export", "sessions");
  const exportFiles = fs.existsSync(exports) ? fs.readdirSync(exports, { recursive: true }).map(String)
    .map(file => path.join(exports, file)).filter(file => fs.statSync(file).isFile()) : [];
  const exportText = exportFiles.map(file => fs.readFileSync(file, "utf8")).join("");
  const retained = JSON.stringify(result) + fs.readFileSync(result.logFile!, "utf8") + exportText +
    (fs.existsSync(prefix) ? fs.readFileSync(prefix, "utf8") : "");
  const usageEvents = lifecycle.mock.calls.map(call => call[0]).filter(event => event.event === "tokens.usage");
  return { result, page, exportText, retained, root, sessionFile, usageEvents };
}

describe("compiled worker terminal boundaries (PR2-001/002/003/005)", () => {
  it.each(["oversized-handled", "oversized-handled-split-tail"])("does not persist private metadata in %s", async scenario => {
    const { result, retained } = await run(scenario);
    expect(result.status).toBe("failed");
    expect(result.error).toBe("Agent emitted an oversized event line");
    expect(retained).not.toContain("REVIEW_PRIVATE_MARKER_");
  });
  it.each(["handled-late-oversized", "handled-late-oversized-split-tail"])("preserves terminal reason before framing %s", async scenario => {
    const { result, retained } = await run(scenario);
    expect(result.error).toBe("Pi handled the task without starting a turn; terminating child");
    expect(result).toMatchObject({ status: "failed", text: "", turns: 0 });
    expect(retained).not.toContain("REVIEW_PRIVATE_MARKER_");
  });
  it.each(["native-reject-late", "native-reject-started-tail", "native-reject-noid-tail"])("keeps native task rejection terminal: %s", async scenario => {
    const { result } = await run(scenario);
    expect(result).toMatchObject({ status: "failed", error: "synthetic native rejection", text: "", turns: 0 });
  });
  it("fences all post-rejection accounting as well as private text", async () => {
    const { result, retained, exportText, usageEvents } = await run("handled-late-usage");
    expect(result).toMatchObject({ status: "failed", text: "", usage: { input: 0, output: 0, cost: 0 } });
    expect(exportText).toBe("");
    expect(usageEvents).toHaveLength(0);
    expect(retained).not.toContain("REVIEW_PRIVATE_MARKER_");
  });
  it("does not fail an unrelated operator prompt rejection", async () => {
    expect((await run("unmatched-reject")).result).toMatchObject({ status: "completed", text: "synthetic completed" });
  });
  it.each(["pi", "claude"] as const)("preserves non-JSON %s public diagnostics and Claude session", async runner => {
    const { result, page, sessionFile } = await run(`${runner}-diagnostic`, runner);
    expect(result.status).toBe("completed");
    expect(page.events.some(event => event.raw === "REVIEW_DIAGNOSTIC_LINE")).toBe(true);
    expect(page.events.some(event => event.raw === "null")).toBe(true);
    if (runner === "claude") expect(fs.readFileSync(sessionFile, "utf8")).toContain("REVIEW_DIAGNOSTIC_LINE");
  });
  // Node process.kill cannot deliver a SIGTERM handler on Windows. Exercise
  // every guard via an explicit protocol there, keeping native POSIX coverage.
  for (const cooperative of [true, false]) {
    it.skipIf(!cooperative && process.platform === "win32").each(["cancelled-usage", "cancelled-usage-duplicate", "cancelled-usage-tail", "timeout-usage-tail", "cancelled-usage-already", "cancelled-usage-oversized"])(`retains final completed-work accounting exactly once (${cooperative ? "cooperative protocol" : "POSIX signal"}): %s`, async scenario => {
      const { result, root, exportText, retained, usageEvents } = await run(scenario, "pi", cooperative);
      // Prove the child flushed before checking accounting; no zero-work false pass.
      expect(fs.existsSync(path.join(root, "usage-flushed"))).toBe(true);
      expect(result.status).toBe(scenario.startsWith("timeout") ? "timed_out" : "stopped");
      expect(result.error).toBe(scenario.startsWith("timeout") ? "Agent timed out after 1500ms" : "Agent stopped");
      expect(result.text).toBe(scenario.includes("already") ? "completed work" : "");
      expect(result.usage).toMatchObject({ input: 100, output: 40, cost: 0.7 });
      expect(usageEvents).toHaveLength(1);
      expect(usageEvents[0].data).toMatchObject({ input: 100, output: 40, cost: 0.7 });
      const entries = exportText.trim().split("\n").map(line => JSON.parse(line)).filter(event => event.type === "message");
      expect(entries).toHaveLength(1);
      expect(entries[0].message.usage).toMatchObject({ input: 100, output: 40, cost: { total: 0.7 } });
      if (!scenario.includes("already")) expect(retained).not.toContain("REVIEW_PRIVATE_MARKER_");
    });
    it.skipIf(!cooperative && process.platform === "win32")(`rejects malformed shutdown numbers and all untrusted attribution/content (${cooperative ? "cooperative protocol" : "POSIX signal"})`, async () => {
      const { result, root, exportText, retained } = await run("cancelled-usage-invalid", "pi", cooperative);
      expect(fs.existsSync(path.join(root, "usage-flushed"))).toBe(true);
      expect(result).toMatchObject({ status: "stopped", error: "Agent stopped", text: "",
        usage: { input: 0, output: 40, cacheRead: 0, cacheWrite: 0, cost: 0 } });
      expect(exportText).toContain('"output":40');
      expect(retained).not.toContain("REVIEW_PRIVATE_MARKER_");
      expect(retained).not.toContain('"input":900');
    });
  }
});
