import fs from "node:fs";
import { isolatedSpawn } from "./fixtures/prompt-probe-sandbox.mjs";
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

// Probe the exact fail-closed sandbox used by the installed public Pi fixture.
// Socket denial needs no loopback setup / CAP_NET_ADMIN on hosted Linux runners.
const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-rpc-capability-"));
let isolation: { status: number | null; stderr?: string; error?: Error } | undefined;
try {
  if (process.platform === "linux" && process.arch === "x64")
    isolation = isolatedSpawn(probeRoot, "/bin/true", []);
} finally { fs.rmSync(probeRoot, { recursive: true, force: true }); }
const isolated = isolation?.status === 0;
const required = process.env.PI_FABRIC_REQUIRE_RPC_ISOLATION === "1";
it.skipIf(!required)("requires usable credential-isolated socket-denied sandbox for Linux CI public RPC proof", () => {
  expect(isolated, isolation?.stderr || isolation?.error?.message || "Linux isolation unavailable").toBe(true);
});
// Unsupported local platforms select no real-RPC proof. The required Linux CI
// capability assertion above fails instead of pretending these skipped tests ran.
describe.skipIf(!isolated)("installed Pi public RPC task boundary (network denied)", () => {
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
    const manager = new AgentManager(root, { ...DEFAULT_FABRIC_CONFIG.agents, runner: "pi", timeoutMs: 15_000 }, {
      workerPath: path.resolve("dist/worker.js"), piBinary: path.resolve("tests/fixtures/prompt-probe-pi.mjs"),
      runRoot: path.join(root, "runs"),
    });
    managers.push(manager);
    const result = await manager.run({ task: "synthetic task", model: "prompt-probe/offline", extensions: false, transport: "process" });
    const log = fs.readFileSync(path.join(root, "runs", result.id, "events.jsonl"), "utf8");
    // bwrap reports the real host PID; Pi process.pid is namespace-local.
    const sandboxPid = JSON.parse(fs.readFileSync(path.join(root, "sandbox-info.json"), "utf8"))["child-pid"];
    expect(Number.isSafeInteger(sandboxPid) && sandboxPid > 0).toBe(true);
    expect(() => process.kill(sandboxPid, 0)).toThrow();
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
