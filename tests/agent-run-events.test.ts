import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agents/manager.js";
import { CapturedToolCatalog } from "../src/capture/catalog.js";
import { DEFAULT_FABRIC_CONFIG, normalizeFabricConfig } from "../src/config.js";
import { FabricRuntimeState } from "../src/fabric-runtime-state.js";
import { FABRIC_AGENT_RUN_EVENT, type FabricAgentRunEventV1 } from "../src/protocol.js";
import { rmTempSync } from "./fixtures/temp-cleanup.js";

const SECRET = "sk-agent-run-event-secret-7f3a";
const TERMINAL = new Set(["completed", "failed", "stopped", "timed_out"]);

const managers: AgentManager[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.allSettled(managers.splice(0).map((manager) => manager.close()));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  delete process.env.FAKE_PI_QUESTION_LOG;
  delete process.env.FAKE_PI_QUESTION_COUNT;
  for (const root of roots.splice(0)) rmTempSync(root);
});

const tempRoot = (prefix: string): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
};

const setup = (
  options: ConstructorParameters<typeof AgentManager>[2] = {},
  agents: Partial<typeof DEFAULT_FABRIC_CONFIG.agents> = {},
) => {
  vi.stubEnv("PI_FABRIC_DEPTH", "0");
  for (const key of ["PI_FABRIC_RUN_ROOT", "PI_FABRIC_BUDGET", "PI_FABRIC_BUDGET_FILE", "PI_FABRIC_BUDGET_ID"]) {
    vi.stubEnv(key, undefined);
  }
  const events: FabricAgentRunEventV1[] = [];
  const manager = new AgentManager(
    process.cwd(),
    { ...DEFAULT_FABRIC_CONFIG.agents, budgetUsd: 0, maxConcurrent: 1, transport: "process", sessionExport: false, ...agents },
    {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: tempRoot("agent-run-events-"),
      sessionId: () => "parent-session",
      onRunEvent: (event) => events.push(event),
      ...options,
    },
  );
  managers.push(manager);
  return { manager, events };
};

const transitions = (events: FabricAgentRunEventV1[], runId: string) =>
  events.filter((event) => event.runId === runId).map(({ from, to }) => [from, to]);

// Resolves on the first event that matches; the manager emits synchronously, so no polling.
const nextEvent = (
  events: FabricAgentRunEventV1[],
  match: (event: FabricAgentRunEventV1) => boolean,
): Promise<FabricAgentRunEventV1> =>
  new Promise((resolve) => {
    const found = events.find(match);
    if (found) return resolve(found);
    const push = events.push.bind(events);
    events.push = (...items: FabricAgentRunEventV1[]) => {
      const length = push(...items);
      const hit = items.find(match);
      if (hit) {
        events.push = push;
        resolve(hit);
      }
      return length;
    };
  });

describe("agent run events", () => {
  it("reports queued and running before the handle returns, then exactly one terminal status per run", async () => {
    const { manager, events } = setup();
    const blocker = await manager.spawn({ task: "HANG blocker", name: "Blocker", extensions: false });
    // Running is reported by the time spawn returns, before the child's first turn.
    expect(transitions(events, blocker.id)).toEqual([[undefined, "running"]]);

    const queued = await manager.spawn({ task: "queued later", name: "Queued", extensions: false, queue: true });
    expect(queued.status).toBe("queued");
    expect(transitions(events, queued.id)).toEqual([[undefined, "queued"]]);

    await manager.stop(blocker.id);
    const result = await manager.wait(queued.id);
    expect(result.status).toBe("completed");

    expect(transitions(events, blocker.id)).toEqual([[undefined, "running"], ["running", "stopped"]]);
    expect(transitions(events, queued.id)).toEqual([
      [undefined, "queued"],
      ["queued", "running"],
      ["running", "completed"],
    ]);
    for (const event of events) {
      expect(event).toMatchObject({ version: 1, parentSessionId: "parent-session" });
      expect(typeof event.at).toBe("number");
    }
    expect(events.filter((event) => event.runId === blocker.id).every((event) => event.label === "Blocker")).toBe(true);
    expect(events.filter((event) => event.runId === queued.id).every((event) => event.label === "Queued")).toBe(true);
  });

  it("reports failed and cancelled runs with their terminal status", async () => {
    const { manager, events } = setup();
    const failed = await manager.run({ task: "FAIL_DIRECTIVE", extensions: false });
    expect(failed.status).toBe("failed");
    expect(transitions(events, failed.id)).toEqual([[undefined, "running"], ["running", "failed"]]);

    // A queued run whose launch fails after admission never runs.
    const broken = setup({ preparePiModel: async () => { throw new Error("model is no longer available"); } });
    const badLaunch = await broken.manager.spawn({ task: "bad model", runner: "pi", extensions: false, queue: true });
    expect((await broken.manager.wait(badLaunch.id)).status).toBe("failed");
    expect(transitions(broken.events, badLaunch.id)).toEqual([[undefined, "queued"], ["queued", "failed"]]);

    // A queued run stopped before it starts is cancelled without running.
    const blocker = await manager.spawn({ task: "HANG blocker", extensions: false });
    const cancelled = await manager.spawn({ task: "never starts", extensions: false, queue: true });
    expect((await manager.stop(cancelled.id)).status).toBe("stopped");
    expect(transitions(events, cancelled.id)).toEqual([[undefined, "queued"], ["queued", "stopped"]]);
    await manager.stop(blocker.id);

    for (const all of [events, broken.events]) {
      for (const runId of new Set(all.map((event) => event.runId))) {
        expect(all.filter((event) => event.runId === runId && TERMINAL.has(event.to))).toHaveLength(1);
      }
    }
  });

  it("keeps a resumed run running and still reports one terminal status", async () => {
    const { manager, events } = setup({}, { maxConcurrent: 4 });
    const result = await manager.run({ task: "RESUME_AFTER_CRASH", transport: "process" });
    expect(result.status).toBe("completed");
    expect(result.text).toBe("resumed attempt 2");
    expect(transitions(events, result.id)).toEqual([[undefined, "running"], ["running", "completed"]]);
  }, 30_000);

  it("carries ids, the caller's name and status only, never task or result text", async () => {
    const { manager, events } = setup();
    // No name: the run's display name falls back to the task's first line, which must not leak.
    const unnamed = await manager.run({ task: `${SECRET} first line\nmore`, extensions: false, traceOrigin: { parentToolCallId: "call-outer", nestedToolCallId: "call-nested" } });
    expect(unnamed.name).toContain(SECRET);
    const named = await manager.run({ task: `use ${SECRET}`, name: "Reviewer", extensions: false });

    const own = events.filter((event) => event.runId === unnamed.id);
    expect(own.map((event) => event.label)).toEqual([undefined, undefined]);
    expect(own.map((event) => event.invocationId)).toEqual(["call-outer", "call-outer"]);
    expect(events.filter((event) => event.runId === named.id).map((event) => event.label)).toEqual(["Reviewer", "Reviewer"]);
    for (const event of events) {
      expect(Object.keys(event).every((key) =>
        ["version", "runId", "parentSessionId", "invocationId", "label", "from", "to", "at"].includes(key))).toBe(true);
    }
    expect(JSON.stringify(events)).not.toContain(SECRET);
    expect(JSON.stringify(events)).not.toContain("fake worker complete");
  });

  it("isolates a throwing listener from the run", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { manager } = setup({ onRunEvent: () => { throw new Error("listener broke"); } });
    const result = await manager.run({ task: "plain", extensions: false });
    expect(result.status).toBe("completed");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("listener broke"));
  });

  it("reports waiting while a routed child question is open, once for several open questions", async () => {
    const root = tempRoot("agent-run-events-question-");
    const fakePi = path.resolve("tests/fixtures/fake-pi-rpc-question.mjs");
    fs.chmodSync(fakePi, 0o755);
    process.env.FAKE_PI_QUESTION_LOG = path.join(root, "responses.jsonl");
    process.env.FAKE_PI_QUESTION_COUNT = "2";
    const answers: Array<() => void> = [];
    const events: FabricAgentRunEventV1[] = [];
    const manager = new AgentManager(
      process.cwd(),
      { ...DEFAULT_FABRIC_CONFIG.agents, runner: "pi", childQuestions: "route", childQuestionTimeoutMs: 30_000 },
      {
        workerPath: path.resolve("src/worker.ts"),
        piBinary: fakePi,
        runRoot: root,
        fullCodeMode: false,
        onRunEvent: (event) => events.push(event),
        onChildQuestion: () => new Promise((resolve) => answers.push(() => resolve({ value: "A" }))),
      },
    );
    managers.push(manager);
    const handle = await manager.spawn({ task: "ASK", transport: "process" });
    await nextEvent(events, (event) => event.runId === handle.id && event.to === "waiting");
    // Settle the second question only after both are open, so waiting is entered once.
    // Each routed question notifies UI subscribers when it opens.
    await new Promise<void>((resolve) => {
      if (answers.length === 2) return resolve();
      const unsubscribe = manager.subscribeUi(() => {
        if (answers.length !== 2) return;
        unsubscribe();
        resolve();
      });
    });
    answers[0]!();
    answers[1]!();
    const result = await manager.wait(handle.id);
    expect(result.status).toBe("completed");
    expect(transitions(events, handle.id)).toEqual([
      [undefined, "running"],
      ["running", "waiting"],
      ["waiting", "running"],
      ["running", "completed"],
    ]);
  }, 30_000);
});

it("emits agent run events on pi.events from the session runtime", async () => {
  const cwd = tempRoot("pi-fabric-agent-run-runtime-");
  vi.stubEnv("PI_CODING_AGENT_DIR", path.join(cwd, "agent"));
  vi.stubEnv("PI_FABRIC_PROJECT_ROOT", cwd);
  const emitted: Array<[string, unknown]> = [];
  const pi = {
    events: { emit: (channel: string, data: unknown) => emitted.push([channel, data]) },
    getThinkingLevel: () => "off",
    sendMessage: vi.fn(),
  } as unknown as ExtensionAPI;
  const models = [{ provider: "dest", id: "worker", name: "Worker" }];
  const context = {
    cwd, hasUI: false, isProjectTrusted: () => true, isIdle: () => true, hasPendingMessages: () => false,
    model: models[0],
    modelRegistry: { getAvailable: () => models, find: () => models[0], getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test" }) },
    sessionManager: { getSessionId: () => "runtime-session", getSessionFile: () => undefined, getBranch: () => [], getLeafId: () => null },
    ui: { setStatus: vi.fn(), notify: vi.fn() },
  } as unknown as ExtensionContext;
  const runtime = new FabricRuntimeState(pi, new CapturedToolCatalog(), { paths: {
    extension: path.resolve("dist/index.js"), worker: path.resolve("tests/fixtures/fake-worker.mjs"), residentHost: path.join(cwd, "unused.mjs"), skills: cwd,
  } });
  try {
    await runtime.initialize(context, normalizeFabricConfig({
      fullCodeMode: false,
      agents: { enabled: true, budgetUsd: 0 },
      mcp: { enabled: false }, memory: { enabled: false }, residency: { enabled: false }, mesh: { enabled: false },
      prewalk: { enabled: false, alwaysRearm: false },
    }));
    const result = await runtime.agents.run({ task: "plain", name: "Runtime run", extensions: false, transport: "process" });
    const runEvents = emitted
      .filter(([channel]) => channel === FABRIC_AGENT_RUN_EVENT)
      .map(([, data]) => data as FabricAgentRunEventV1);
    expect(runEvents.map(({ runId, from, to, label, parentSessionId }) => ({ runId, from, to, label, parentSessionId }))).toEqual([
      { runId: result.id, from: undefined, to: "running", label: "Runtime run", parentSessionId: "runtime-session" },
      { runId: result.id, from: "running", to: "completed", label: "Runtime run", parentSessionId: "runtime-session" },
    ]);
  } finally {
    await runtime.shutdown();
  }
}, 20_000);
