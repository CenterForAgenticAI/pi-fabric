import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agents/manager.js";
import {
  MODEL_PIN_ENV, MODEL_PIN_EXIT_CODE, MODEL_PIN_MARKER, modelPinFailure, parseModelPinViolation,
} from "../src/agents/model-pin.js";
import fabricModelPinGuard from "../src/agents/model-pin-guard.js";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import { parseWorkerOptions } from "../src/worker/options.js";
import { rmTempSync } from "./fixtures/temp-cleanup.js";

const EVENTS = ["context", "context_with_system", "before_provider_request"] as const;

describe("model pin guard (child-side extension)", () => {
  const handlers = new Map<string, (event: unknown, context: unknown) => void>();
  let writes: string[];
  beforeEach(() => {
    handlers.clear();
    writes = [];
    vi.stubEnv(MODEL_PIN_ENV, "lab/pinned");
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => { throw new Error(`exit:${code}`); }) as never);
    vi.spyOn(fs, "writeSync").mockImplementation(((_fd: number, text: string) => { writes.push(String(text)); return 0; }) as never);
    fabricModelPinGuard({ on: (event: string, handler: (event: unknown, context: unknown) => void) => handlers.set(event, handler) } as unknown as ExtensionAPI);
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it("guards every point before a model call", () => {
    expect([...handlers.keys()].sort()).toEqual([...EVENTS].sort());
  });

  it.each(EVENTS)("lets the pinned model through at %s", (event) => {
    expect(() => handlers.get(event)!({}, { model: { provider: "lab", id: "pinned" } })).not.toThrow();
    expect(process.exit).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it.each(EVENTS)("ends the child before the call when another model is current at %s", (event) => {
    expect(() => handlers.get(event)!({}, { model: { provider: "lab", id: "other" } })).toThrow(`exit:${MODEL_PIN_EXIT_CODE}`);
    expect(parseModelPinViolation(writes.join(""))).toEqual({ pinned: "lab/pinned", actual: "lab/other" });
  });

  it("compares provider and id case-sensitively, because the pin is the registry's own spelling", () => {
    expect(() => handlers.get("context")!({}, { model: { provider: "lab", id: "Pinned" } })).toThrow(`exit:${MODEL_PIN_EXIT_CODE}`);
  });

  it.each([
    ["no model", { model: undefined }],
    ["a model without an id", { model: { provider: "lab" } }],
    ["a stale context whose model getter throws", { get model(): never { throw new Error("stale"); } }],
  ])("fails closed on %s", (_label, context) => {
    expect(() => handlers.get("context")!({}, context)).toThrow(`exit:${MODEL_PIN_EXIT_CODE}`);
    expect(parseModelPinViolation(writes.join(""))).toEqual({ pinned: "lab/pinned", actual: "none" });
  });

  it("fails closed when the pin is missing from the environment", () => {
    vi.stubEnv(MODEL_PIN_ENV, "");
    handlers.clear();
    fabricModelPinGuard({ on: (event: string, handler: (event: unknown, context: unknown) => void) => handlers.set(event, handler) } as unknown as ExtensionAPI);
    expect(() => handlers.get("context")!({}, { model: { provider: "lab", id: "pinned" } })).toThrow(`exit:${MODEL_PIN_EXIT_CODE}`);
  });
});

describe("model pin marker", () => {
  it("round-trips through a noisy stderr and builds the fixed run error", () => {
    const violation = { pinned: "a/b", actual: "c/d" };
    const stderr = `warn\n${MODEL_PIN_MARKER}${JSON.stringify(violation)}\ntrailing`;
    expect(parseModelPinViolation(stderr)).toEqual(violation);
    expect(modelPinFailure(violation)).toBe(
      "Fabric exact model pin violated: only a/b may run, but c/d was about to run. The provider call was stopped before any request was sent.",
    );
  });

  it.each(["", "nothing here", `${MODEL_PIN_MARKER}not json`, `${MODEL_PIN_MARKER}{"pinned":1}`])("ignores %j", (stderr) => {
    expect(parseModelPinViolation(stderr)).toBeUndefined();
  });
});

describe("worker option --model-match", () => {
  const base = ["node", "worker", "--id", "a", "--name", "n", "--runner", "pi", "--task-file", "t", "--status-file", "s", "--lifecycle-file", "l", "--log-file", "f", "--cwd", "/", "--pi-binary", "pi", "--claude-binary", "c", "--veda-binary", "v", "--veda-backend", "b", "--veda-persona", "p", "--timeout-ms", "1", "--depth", "1", "--full-code-mode", "false", "--extensions", "true", "--tools", "[]", "--granted-risks", "[]", "--transport", "process"];
  it("accepts only exact", () => {
    expect(parseWorkerOptions([...base, "--model-match", "exact"]).modelMatch).toBe("exact");
    expect(parseWorkerOptions(base).modelMatch).toBeUndefined();
    expect(() => parseWorkerOptions([...base, "--model-match", "fuzzy"])).toThrow(/model-match/);
  });
});

// Real Pi child, offline provider. The fixture extension logs every entry into the provider's
// stream function, so the log counts the model calls each model received.
const workerPath = path.resolve("dist/worker.js");
const piCli = path.resolve("node_modules/@earendil-works/pi-coding-agent/dist/cli.js");

describe.skipIf(!fs.existsSync(workerPath) || !fs.existsSync(path.resolve("dist/agents/model-pin-guard.js")))("exact model pin against a real Pi child", () => {
  const roots: string[] = [];
  const managers: AgentManager[] = [];
  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.close()));
    vi.unstubAllEnvs();
    for (const root of roots.splice(0)) rmTempSync(root);
  });

  const launch = async (
    runner: "pi" | "pi-durable",
    extension: string,
    env: Record<string, string>,
    model: string,
    exact: boolean,
  ) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-model-pin-"));
    roots.push(directory);
    const agentDir = path.join(directory, "agent");
    fs.mkdirSync(agentDir);
    fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ extensions: [path.resolve(extension)], enableInstallTelemetry: false }));
    const callLog = path.join(directory, "calls.jsonl");
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.stubEnv("PI_OFFLINE", "1");
    vi.stubEnv("MODEL_SWITCH_CALL_LOG", callLog);
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    // Permissive on purpose: the pin must hold without relying on admission.
    const manager = new AgentManager(directory, { ...DEFAULT_FABRIC_CONFIG.agents, runner, timeoutMs: 60_000, modelAdmission: "permissive", budgetUsd: 0 }, {
      workerPath, piBinary: piCli, fullCodeMode: false, fabricExtensionPath: path.resolve("dist/index.js"),
      runRoot: path.join(directory, "runs"), preparePiModel: async (selected) => selected,
    });
    managers.push(manager);
    const result = await manager.run({
      task: "pinned request", model, ...(exact ? { modelMatch: "exact" as const } : {}), thinking: "high",
      extensions: true, tools: ["switch_probe_noop"], transport: "process",
    });
    const entries = fs.existsSync(callLog)
      ? fs.readFileSync(callLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { provider?: string; id?: string; switched?: string })
      : [];
    const calls: Record<string, number> = {};
    for (const entry of entries) if (entry.id) calls[`${entry.provider}/${entry.id}`] = (calls[`${entry.provider}/${entry.id}`] ?? 0) + 1;
    return { result, calls, switched: entries.some((entry) => entry.switched) };
  };

  const fixture = "tests/fixtures/model-switch-extension.ts";
  const pinnedModel = "switch-probe/requested";

  describe.each(["pi", "pi-durable"] as const)("%s", (runner) => {
    it.each(["before-start", "between-turns", "context"])("sends no request to another model when an extension switches it: %s", async (phase) => {
      const { result, calls, switched } = await launch(runner, fixture, { MODEL_SWITCH_PHASE: phase }, pinnedModel, true);
      expect(switched).toBe(true);
      expect(calls["switch-probe/other"]).toBeUndefined();
      expect(result.status).toBe("failed");
      expect(result.error).toBe(modelPinFailure({ pinned: pinnedModel, actual: "switch-probe/other" }));
    }, 120_000);

    it("lets a default request reach the other model, so the switch above is real", async () => {
      const { result, calls } = await launch(runner, fixture, { MODEL_SWITCH_PHASE: "before-start" }, pinnedModel, false);
      expect(result.status).toBe("completed");
      expect(calls["switch-probe/other"]).toBe(1);
    }, 120_000);

    it("completes an exact run on the pinned model when nothing switches it", async () => {
      const { result, calls } = await launch(runner, fixture, { MODEL_SWITCH_PHASE: "none" }, pinnedModel, true);
      expect(result).toMatchObject({ status: "completed", model: pinnedModel });
      expect(calls).toEqual({ [pinnedModel]: 1 });
    }, 120_000);

    it("still completes an exact run after a startup hijack that Pi's model selection is asked to undo", async () => {
      const { result } = await launch(runner, "tests/fixtures/model-hijack-extension.ts", {}, "model-probe/requested", true);
      expect(result).toMatchObject({ status: "completed", model: "model-probe/requested" });
    }, 120_000);
  });
});
