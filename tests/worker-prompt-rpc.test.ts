import fs from "node:fs";
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
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

// Process-level network denial is required for these actual installed Pi probes.
// Other platforms still run the deterministic fake-RPC and timer regressions.
describe.skipIf(process.platform !== "linux" || !fs.existsSync("/usr/bin/bwrap"))("installed Pi public RPC task boundary (network denied)", () => {
  it.each(["handled", "continue", "throw"])("observes %s input disposition with no real accounts", async scenario => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-prompt-rpc-"));
    roots.push(root);
    fs.mkdirSync(path.join(root, "agent"));
    fs.mkdirSync(path.join(root, "tmp"));
    fs.writeFileSync(path.join(root, "scenario"), scenario);
    fs.writeFileSync(path.join(root, "agent", "settings.json"), JSON.stringify({ enableInstallTelemetry: false }));
    vi.stubEnv("HOME", root);
    vi.stubEnv("PI_CODING_AGENT_DIR", path.join(root, "agent"));
    vi.stubEnv("PROMPT_PROBE_ROOT", root);
    const manager = new AgentManager(root, { ...DEFAULT_FABRIC_CONFIG.agents, timeoutMs: 15_000 }, {
      workerPath: path.resolve("dist/worker.js"), piBinary: path.resolve("tests/fixtures/prompt-probe-pi.mjs"),
      runRoot: path.join(root, "runs"),
    });
    managers.push(manager);
    const result = await manager.run({ task: "synthetic task", model: "prompt-probe/offline", extensions: false, transport: "process" });
    const log = fs.readFileSync(path.join(root, "runs", result.id, "events.jsonl"), "utf8");
    expect(() => process.kill(Number(fs.readFileSync(path.join(root, "host-pid"), "utf8")), 0)).toThrow();
    if (scenario === "handled") {
      expect(result, log).toMatchObject({ status: "failed", turns: 0,
        error: "Pi handled the task without starting a turn; terminating child" });
      expect(log).toContain('"disposition":"handled"');
      expect(log).not.toContain('"type":"agent_start"');
      // Zero invocations at the public provider stream boundary proves no send.
      expect(fs.readFileSync(path.join(root, "provider-sends"), "utf8")).toBe("0");
    } else {
      expect(result, log).toMatchObject({ status: "completed", text: "offline accepted", turns: 1 });
      expect(log).toContain('"disposition":"started"');
      expect(fs.readFileSync(path.join(root, "provider-sends"), "utf8")).toBe("1");
      if (scenario === "throw") expect(log).toContain("synthetic input hook error");
    }
  }, 25_000);
});
