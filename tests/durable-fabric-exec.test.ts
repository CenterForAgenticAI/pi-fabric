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

// A full-code durable child built from dist: Main's AgentManager -> compiled
// parent worker -> compiled durable host -> this package's Fabric extension.
// Only inference is offline; the faux model sends DURABLE_TEST_FABRIC_CODE.
function setup(prefix: string, fabricCode: string) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); roots.push(cwd);
  const agentDir = path.join(cwd, "agent"); fs.mkdirSync(agentDir);
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
    extensions: [path.resolve("tests/fixtures/durable-pi-extension.ts")],
    defaultProvider: "durable-offline", defaultModel: "test",
    compaction: { enabled: false }, retry: { enabled: false },
  }));
  fs.writeFileSync(path.join(agentDir, "fabric.json"), JSON.stringify({
    fullCodeMode: true, mesh: { enabled: false }, mcp: { enabled: false },
    agents: { runner: "pi-durable", maxDepth: 3, timeoutMs: 30000 },
  }));
  for (const key of ["PI_FABRIC_DEPTH", "PI_FABRIC_BUDGET", "PI_FABRIC_BUDGET_FILE", "PI_FABRIC_BUDGET_ID", "PI_FABRIC_WRITE_POLICY", "PI_FABRIC_TOOL_ALLOWLIST", "PI_FABRIC_SCOPE", "PI_FABRIC_LINEAGE", "PI_FABRIC_PARENT_RUN", "PI_FABRIC_ACTOR_ID", "PI_SESSION_ID", "PI_PACKAGE_DIR"]) vi.stubEnv(key, undefined);
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  vi.stubEnv("PI_OFFLINE", "1");
  vi.stubEnv("DURABLE_TEST_FAUX_MODULE", import.meta.resolve("@earendil-works/pi-ai/providers/faux"));
  vi.stubEnv("DURABLE_TEST_FABRIC_CODE", fabricCode);
  const manager = new AgentManager(cwd, { ...DEFAULT_FABRIC_CONFIG.agents, maxDepth: 3, timeoutMs: 30000 }, {
    workerPath: path.resolve("dist/worker.js"), fabricExtensionPath: path.resolve("dist/index.js"),
    fullCodeMode: true, runRoot: path.join(cwd, "runs"), piBinary: path.join(cwd, "forbidden-native-fallback"),
  }); managers.push(manager);
  return { cwd, manager };
}

const sessionIdOf = (sessionFile: string): string => {
  const header = JSON.parse(fs.readFileSync(sessionFile, "utf8").split("\n")[0]!) as { type: string; id: string };
  expect(header.type).toBe("session");
  return header.id;
};

describe("built durable Fabric host", () => {
  it("executes fabric_exec with the TypeScript kernel and successfully runs a recursive durable child", async () => {
    const { manager } = setup("fabric-durable-recursive-", 'const child = await agents.run({ task: "recursive leaf", tools: [], extensions: true, thinking: "off" }); return { runner: child.runner, status: child.status, text: child.text };');
    const result = await manager.run({ task: "fabric fixture", model: "durable-offline/test", recursive: true, kernel: "typescript", transport: "process" });
    expect(result.status, `${result.error}\n${result.stderr}\n${result.text}`).toBe("completed");
    expect(result.runner).toBe("pi-durable");
    expect(result.stderr ?? "").not.toContain("could not resolve the persisted assistant entry ID");
    expect(result.text).toContain("recursive leaf");
    expect(result.text).toContain("pi-durable");
    expect(result.text).toContain("completed");
    const events = fs.readFileSync(result.logFile!, "utf8");
    expect(events).toContain('"toolName":"fabric_exec"');
  }, 60000);

  // The durable host's extension runner must be the one Fabric's tool
  // capture observes, or every mutating pi.* call fails closed forever.
  it("runs pi.bash and pi.write in a durable child, with the child's session id in the shell", async () => {
    const { cwd, manager } = setup("fabric-durable-core-tools-", [
      'const shell = await pi.bash({ command: \'printf "sid=%s;" "$PI_SESSION_ID"\' });',
      'await pi.write({ path: "written-by-child.txt", text: "durable write" });',
      'return shell;',
    ].join("\n"));
    const sessionFile = path.join(cwd, "child-session.jsonl");
    const result = await manager.run({ task: "fabric fixture", model: "durable-offline/test", tools: ["read", "bash", "write"], kernel: "typescript", transport: "process", sessionFile });
    expect(result.status, `${result.error}\n${result.stderr}\n${result.text}`).toBe("completed");
    expect(result.runner).toBe("pi-durable");
    expect(result.text).not.toContain("unavailable until extension tool hooks initialize");
    expect(fs.readFileSync(path.join(cwd, "written-by-child.txt"), "utf8")).toBe("durable write");
    expect(result.text).toContain(`sid=${sessionIdOf(sessionFile)};`);
  }, 60000);

  // A careless or hostile child must not reach a tool its spawn request left
  // out once the durable host's hooks are live: not a core tool, and not an
  // extension tool that capture now exposes.
  it("keeps tools excluded by the spawn request unavailable in a durable child", async () => {
    const { cwd, manager } = setup("fabric-durable-excluded-tools-", [
      'const attempt = async (call) => { try { await call(); return "ran"; } catch (error) { return String(error?.message ?? error); } };',
      'const bash = await attempt(() => pi.bash({ command: "touch bash-marker.txt" }));',
      'const effect = await attempt(() => tools.call({ ref: "extensions.hold_effect", args: {} }));',
      'const capturedBash = await attempt(() => tools.call({ ref: "extensions.bash", args: { command: "touch bash-marker.txt" } }));',
      'await pi.write({ path: "allowed-write.txt", text: "allowed" });',
      'return { bash, effect, capturedBash };',
    ].join("\n"));
    const effectFile = path.join(cwd, "effect.log");
    vi.stubEnv("DURABLE_TEST_EFFECT", effectFile);
    const result = await manager.run({ task: "fabric fixture", model: "durable-offline/test", tools: ["read", "write"], kernel: "typescript", transport: "process" });
    expect(result.status, `${result.error}\n${result.stderr}\n${result.text}`).toBe("completed");
    // The allowed mutating tool works, so the denials below are the allowlist.
    expect(fs.readFileSync(path.join(cwd, "allowed-write.txt"), "utf8")).toBe("allowed");
    // Neither excluded tool is even an action the child can name.
    expect(result.text).toContain('bash: "Unknown Fabric action: pi.bash"');
    expect(result.text).toContain('effect: "Unknown Fabric action: extensions.hold_effect"');
    expect(result.text).toContain('capturedBash: "Unknown Fabric action: extensions.bash"');
    expect(fs.existsSync(path.join(cwd, "bash-marker.txt"))).toBe(false);
    expect(fs.existsSync(effectFile)).toBe(false);
  }, 60000);
});
