import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { availablePythonBackends } from "./fixtures/python-backends.js";
import { DEFAULT_FABRIC_CONFIG, normalizeFabricConfig, type FabricConfig } from "../src/config.js";
import { ActionRegistry } from "../src/core/action-registry.js";
import { FabricExecutionService } from "../src/execution-service.js";
import { HumanWaitDeadlinePause } from "../src/runtime/deadline-pause.js";

/** Fake `extensions` provider: every action settles after `delayMs`, or rejects on abort. */
const fixture = (configure: (config: FabricConfig) => void, delayMs = 400) => {
  const registry = new ActionRegistry();
  const aborted: string[] = [];
  const descriptor = {
    name: "ask",
    description: "human question stub",
    inputSchema: { type: "object", properties: {}, additionalProperties: true },
    risk: "read" as const,
  };
  registry.register({
    name: "extensions",
    description: "fake extensions",
    async list() { return [descriptor, { ...descriptor, name: "slow" }]; },
    async describe(name) {
      return name === "ask" || name === "slow" ? { ...descriptor, name } : undefined;
    },
    async invoke(name, _args, context) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({ answer: name }), delayMs);
        context.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          aborted.push(name);
          reject(new Error("aborted"));
        }, { once: true });
      });
    },
  });
  const config = structuredClone(DEFAULT_FABRIC_CONFIG);
  config.fullCodeMode = true;
  config.approvals.read = "allow";
  configure(config);
  const service = new FabricExecutionService(registry, config);
  let sequence = 0;
  const run = (code: string, signal?: AbortSignal) => service.execute({
    code,
    signal,
    parentToolCallId: `human-wait-${++sequence}`,
    context: { cwd: process.cwd(), hasUI: false, sessionManager: {
      getSessionId: () => "human-wait-test", getSessionFile: () => undefined,
    } } as unknown as ExtensionContext,
    onPartial() {},
  });
  return { run, aborted };
};

describe("HumanWaitDeadlinePause", () => {
  it("suspends once, resumes once with the saved budget, and applies raised floors", () => {
    const calls: string[] = [];
    let remaining = 300;
    const pause = new HumanWaitDeadlinePause({
      remainingMs: () => remaining,
      suspend: () => calls.push("suspend"),
      resume: (ms) => calls.push(`resume:${ms}`),
    });
    pause.leave();
    expect(calls).toEqual([]);
    pause.enter();
    remaining = 5;
    pause.enter();
    expect(pause.paused).toBe(true);
    pause.leave();
    expect(calls).toEqual(["suspend"]);
    pause.raise(100);
    pause.leave();
    expect(pause.paused).toBe(false);
    expect(calls).toEqual(["suspend", "resume:300"]);
    pause.enter();
    pause.raise(1_000.7);
    pause.leave();
    expect(calls.at(-1)).toBe("resume:1000");
  });
});

describe("executor.humanWaitRefs config", () => {
  it("defaults to extensions.ask and normalizes exact refs", () => {
    expect(normalizeFabricConfig({}).executor.humanWaitRefs).toEqual(["extensions.ask"]);
    expect(normalizeFabricConfig({ executor: { humanWaitRefs: [] } }).executor.humanWaitRefs).toEqual([]);
    expect(normalizeFabricConfig({
      executor: { humanWaitRefs: [" extensions.ask ", "extensions.ask", "", 7, "mcp.q.ask"] },
    }).executor.humanWaitRefs).toEqual(["extensions.ask", "mcp.q.ask"]);
    expect(normalizeFabricConfig({ executor: { humanWaitRefs: "extensions.ask" } }).executor.humanWaitRefs)
      .toEqual(["extensions.ask"]);
  });
});

const typescriptRuntimes = ["quickjs", "node-process"] as const;

describe.each(typescriptRuntimes)("%s runtime human-wait deadline pause", (runtime) => {
  const configure = (config: FabricConfig): void => {
    config.executor.runtime = runtime;
    config.executor.timeoutMs = 150;
    if (runtime === "node-process") config.executor.memoryLimitBytes = 128 * 1024 * 1024;
  };

  it("waits past the program deadline for a human-wait ref", async () => {
    const { run } = fixture(configure);
    const direct = await run("return await extensions.ask({});");
    expect(direct.success, direct.error).toBe(true);
    expect(direct.value).toEqual({ answer: "ask" });
    const generic = await run('return await tools.call({ ref: "extensions.ask", args: {} });');
    expect(generic.success, generic.error).toBe(true);
  });

  it("keeps the normal deadline for refs that are not configured", async () => {
    const { run } = fixture(configure);
    const result = await run("return await extensions.slow({});");
    expect(result.success).toBe(false);
    expect(result.error).toContain("timed out");
  });

  it("keeps the normal deadline when humanWaitRefs is empty", async () => {
    const { run } = fixture((config) => { configure(config); config.executor.humanWaitRefs = []; });
    const result = await run("return await extensions.ask({});");
    expect(result.success).toBe(false);
    expect(result.error).toContain("timed out");
  });

  it("still counts guest work after the wait against the remaining budget", async () => {
    const { run } = fixture(configure);
    const result = await run("await extensions.ask({}); return await extensions.slow({});");
    expect(result.success).toBe(false);
    expect(result.error).toContain("timed out");
  });

  it("cancels a pending human-wait call when the program is aborted", async () => {
    const { run, aborted } = fixture(configure, 10_000);
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("user cancelled")), 300);
    const startedAt = Date.now();
    const result = await run("return await extensions.ask({});", controller.signal);
    expect(result.success).toBe(false);
    expect(result.error).toContain("cancelled");
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(aborted).toContain("ask");
  });
});

const pythonBackends = ["monty", "cpython"] as const;

describe.each(pythonBackends)("%s Python kernel human-wait deadline pause", (pythonRuntime) => {
  const runTest = it.skipIf(!availablePythonBackends[pythonRuntime]);
  const configure = (config: FabricConfig): void => {
    const python = normalizeFabricConfig({ executor: {
      kernel: "python",
      ...(pythonRuntime === "cpython" ? { pythonRuntime } : { cpython: { binary: "/nonexistent/python3" } }),
      memoryLimitBytes: 256 * 1024 * 1024,
    } }).executor;
    config.executor = { ...python, timeoutMs: 1_000 };
  };

  runTest("waits past the program deadline for a human-wait ref", async () => {
    const { run } = fixture(configure, 2_000);
    const result = await run('return await tools.call(ref="extensions.ask", args={})');
    expect(result.success, result.error).toBe(true);
    expect(result.value).toEqual({ answer: "ask" });
  });

  runTest("keeps the normal deadline for refs that are not configured", async () => {
    const { run } = fixture(configure, 2_000);
    const result = await run('return await tools.call(ref="extensions.slow", args={})');
    expect(result.success).toBe(false);
    expect(result.error).toContain("timed out");
  });
});
