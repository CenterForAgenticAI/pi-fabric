import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEventBus, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HerdrAgentStatus } from "../src/agents/herdr-status.js";
import { AgentManager } from "../src/agents/manager.js";
import type { AgentRunRecord } from "../src/agents/types.js";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import { routeChildQuestion } from "../src/decisions/host.js";
import { DecisionStore } from "../src/decisions/store.js";
import type { FabricQuestionRenderers } from "../src/fabric-state.js";
import piFabric from "../src/index.js";
import { MeshStore, type MeshIdentity } from "../src/mesh/store.js";
import {
  FABRIC_CHILD_QUESTION_ROUTE_EVENT,
  FABRIC_CHILD_QUESTION_STATUS_KEY,
  type FabricQuestionRenderInputV1,
} from "../src/protocol.js";
import { CHILD_QUESTION_STATUS_KEY, ChildQuestionRelay } from "../src/worker/questions.js";
import { rmTempSync } from "./fixtures/temp-cleanup.js";

const fakePi = path.resolve("tests/fixtures/fake-pi-rpc-question-withdraw.mjs");
const roots: string[] = [];
const managers: AgentManager[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  for (const root of roots.splice(0)) rmTempSync(root);
  vi.unstubAllEnvs();
  delete process.env.FAKE_PI_MODE;
  delete process.env.FAKE_PI_QUESTION_LOG;
  delete process.env.FAKE_PI_SESSION_ID;
  delete process.env.FAKE_PI_EXTERNAL_ID;
});

const waitFor = async (predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

const registry = (
  render: (input: FabricQuestionRenderInputV1) => unknown,
): { renderers: FabricQuestionRenderers; seen: FabricQuestionRenderInputV1[] } => {
  const seen: FabricQuestionRenderInputV1[] = [];
  const renderers = {
    size: 1,
    list: () => [{ name: "test-renderer", render: (input: FabricQuestionRenderInputV1) => { seen.push(input); return render(input); } }],
  } as unknown as FabricQuestionRenderers;
  return { renderers, seen };
};

describe("F-097: held child question withdrawal and external-record routing", () => {
  it("clears manager.activity(), blockedOn, the Fabric decision, and herdr:blocked when a child withdraws a held dialog", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-f097-"));
    roots.push(root);
    const meshRoot = path.join(root, "mesh");
    const mainIdentity: MeshIdentity = { id: "session:main", name: "main", kind: "main", sessionId: "main-sess" };
    const store = new DecisionStore(new MeshStore(meshRoot, 64 * 1024, 500), mainIdentity);
    const notify = vi.fn();
    const context = { hasUI: true, ui: { notify } } as unknown as ExtensionContext;

    const herdrEvents: Array<[string, unknown]> = [];
    const manager = new AgentManager(
      process.cwd(),
      { ...DEFAULT_FABRIC_CONFIG.agents, runner: "pi", childQuestions: "route", childQuestionTimeoutMs: 30_000 },
      {
        workerPath: path.resolve("src/worker.ts"),
        piBinary: fakePi,
        runRoot: path.join(root, "runs"),
        fullCodeMode: false,
        onChildQuestion: (request) => routeChildQuestion(request, { context, store }),
      },
    );
    managers.push(manager);

    const herdr = new HerdrAgentStatus({
      events: { emit: (event, data) => void herdrEvents.push([event, data]) },
      activity: () => manager.activity(),
      environment: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: "/run/fake-herdr.sock" },
      request: async () => ({ result: { type: "ok" } }),
    });
    const unsubUi = manager.subscribeUi(() => herdr.sync());

    try {
      const handle = await manager.spawn({ name: "worker", task: "ASK", transport: "process", holdQuestions: true });

      await waitFor(async () => {
        const status = manager.status(handle.id) as AgentRunRecord;
        const open = await store.list({ status: "open" });
        return Boolean(status.blockedOn?.decisionId) && open.length === 1 && manager.activity()[0]?.question === "Pick";
      });

      const [openDecision] = await store.list({ status: "open" });
      expect(openDecision).toBeDefined();
      expect(herdrEvents.some(([e, d]) => e === "herdr:blocked" && (d as { active?: boolean }).active === true)).toBe(true);

      await manager.steer(handle.id, "WITHDRAW");

      await waitFor(async () => {
        const status = manager.status(handle.id) as AgentRunRecord;
        const rec = await store.get(openDecision!.id);
        const act = manager.activity()[0];
        const blockedCleared = herdrEvents.some(([e, d]) => e === "herdr:blocked" && (d as { active?: boolean }).active === false);
        return !status.blockedOn && rec?.status === "cancelled" && act?.question === undefined && blockedCleared;
      }, 4_000);

      const finalDecision = await store.get(openDecision!.id);
      expect(finalDecision?.status).toBe("cancelled");
      expect(finalDecision?.answer?.via).toBe("withdrawn");
      expect(manager.activity()).toEqual([{ id: handle.id, name: "worker" }]);

      await manager.steer(handle.id, "FINISH");
      const result = await manager.wait(handle.id);
      expect(result.status).toBe("completed");
    } finally {
      unsubUi();
      await herdr.close();
    }
  }, 20_000);

  it("routes an external-record ask with zero Fabric decision copies, surfaces childSessionId, and clears blocked state on child withdrawal", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-f097-ext-"));
    roots.push(root);
    const log = path.join(root, "responses.jsonl");
    process.env.FAKE_PI_MODE = "external";
    process.env.FAKE_PI_SESSION_ID = "child-pi-sess-99";
    process.env.FAKE_PI_EXTERNAL_ID = "pi-dec-abc123";
    process.env.FAKE_PI_QUESTION_LOG = log;

    const store = new DecisionStore(
      new MeshStore(path.join(root, "mesh"), 64 * 1024, 500),
      { id: "session:main", name: "main", kind: "main", sessionId: "main-sess" },
    );
    const notify = vi.fn();
    const context = { hasUI: true, ui: { notify } } as unknown as ExtensionContext;

    // Renderer dismisses so the ask stays waiting until the child withdraws it (e.g. answered in focus).
    const { renderers, seen } = registry((input) => ({ status: "dismissed", decisionId: input.decision.id }));

    const herdrEvents: Array<[string, unknown]> = [];
    const manager = new AgentManager(
      process.cwd(),
      { ...DEFAULT_FABRIC_CONFIG.agents, runner: "pi", childQuestions: "route", childQuestionTimeoutMs: 30_000 },
      {
        workerPath: path.resolve("src/worker.ts"),
        piBinary: fakePi,
        runRoot: path.join(root, "runs"),
        fullCodeMode: false,
        onChildQuestion: (request) => routeChildQuestion(request, { context, store, renderers }),
      },
    );
    managers.push(manager);

    const herdr = new HerdrAgentStatus({
      events: { emit: (event, data) => void herdrEvents.push([event, data]) },
      activity: () => manager.activity(),
      environment: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: "/run/fake-herdr.sock" },
      request: async () => ({ result: { type: "ok" } }),
    });
    const unsubUi = manager.subscribeUi(() => herdr.sync());

    try {
      const handle = await manager.spawn({ name: "worker", task: "ASK", transport: "process", holdQuestions: true });

      await waitFor(() => seen.length === 1 && Boolean((manager.status(handle.id) as AgentRunRecord).blockedOn));
      // Zero Fabric decisions created — one record per ask.
      expect(await store.list()).toEqual([]);
      expect(seen[0]!.decision.externalRecord).toEqual({ system: "pi-decision", id: "pi-dec-abc123" });
      expect(seen[0]!.decision.raisedBy.sessionId).toBe("child-pi-sess-99");
      const statusBeforeWithdraw = manager.status(handle.id) as AgentRunRecord;
      expect(statusBeforeWithdraw.blockedOn).toBeDefined();
      expect(herdrEvents.some(([e, d]) => e === "herdr:blocked" && (d as { active?: boolean }).active === true)).toBe(true);
      expect(notify).toHaveBeenCalledWith(expect.stringContaining("pi-dec-abc123"), "info");

      // Child withdraws after external record settles elsewhere.
      await manager.steer(handle.id, "WITHDRAW");
      await waitFor(() => {
        const status = manager.status(handle.id) as AgentRunRecord;
        const act = manager.activity()[0];
        const cleared = herdrEvents.some(([e, d]) => e === "herdr:blocked" && (d as { active?: boolean }).active === false);
        return !status.blockedOn && act?.question === undefined && cleared;
      }, 4_000);

      // No extension_ui_response is ever sent on stdin for an external-record question.
      expect(fs.existsSync(log)).toBe(false);

      await manager.steer(handle.id, "FINISH");
      const result = await manager.wait(handle.id);
      expect(result.status).toBe("completed");
      expect(result.runnerSessionId).toBe("child-pi-sess-99");
    } finally {
      unsubUi();
      await herdr.close();
    }
  }, 20_000);

  it("clears parent blocked state immediately when a renderer settles an external-record question", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-f097-ext-settle-"));
    roots.push(root);
    const log = path.join(root, "responses.jsonl");
    process.env.FAKE_PI_MODE = "external";
    process.env.FAKE_PI_SESSION_ID = "child-pi-sess-100";
    process.env.FAKE_PI_EXTERNAL_ID = "pi-dec-settle";
    process.env.FAKE_PI_QUESTION_LOG = log;

    const store = new DecisionStore(
      new MeshStore(path.join(root, "mesh"), 64 * 1024, 500),
      { id: "session:main", name: "main", kind: "main", sessionId: "main-sess" },
    );
    const notify = vi.fn();
    const context = { hasUI: true, ui: { notify } } as unknown as ExtensionContext;

    let finishRender: ((result: unknown) => void) | undefined;
    const { renderers, seen } = registry(
      () => new Promise((resolve) => { finishRender = resolve; }),
    );

    const manager = new AgentManager(
      process.cwd(),
      { ...DEFAULT_FABRIC_CONFIG.agents, runner: "pi", childQuestions: "route", childQuestionTimeoutMs: 30_000 },
      {
        workerPath: path.resolve("src/worker.ts"),
        piBinary: fakePi,
        runRoot: path.join(root, "runs"),
        fullCodeMode: false,
        onChildQuestion: (request) => routeChildQuestion(request, { context, store, renderers }),
      },
    );
    managers.push(manager);

    const handle = await manager.spawn({ name: "worker", task: "ASK", transport: "process", holdQuestions: true });
    await waitFor(() => seen.length === 1 && Boolean((manager.status(handle.id) as AgentRunRecord).blockedOn));
    expect(await store.list()).toEqual([]);

    finishRender!({ status: "answered", decisionId: seen[0]!.decision.id, answer: { text: "done" } });

    await waitFor(() => {
      const status = manager.status(handle.id) as AgentRunRecord;
      return !status.blockedOn && manager.activity()[0]?.question === undefined;
    }, 4_000);
    expect(fs.existsSync(log)).toBe(false);

    await manager.steer(handle.id, "FINISH");
    const result = await manager.wait(handle.id);
    expect(result.status).toBe("completed");
  }, 20_000);
});

describe("F-097: ChildQuestionRelay structured control frames and withdrawal", () => {
  it("handles open/withdraw controlStatus frames, ignores malformed/hostile payloads, and sends no stdin response for external records", () => {
    const io = { emit: vi.fn(), cancel: vi.fn(), send: vi.fn(), blocked: vi.fn() };
    const relay = new ChildQuestionRelay(60_000, io, () => 100);

    // Unrelated status key is not claimed.
    expect(relay.controlStatus({ method: "setStatus", statusKey: "other", statusText: "hi" })).toBe(false);

    // Hostile/malformed frames on our key are claimed and safely ignored.
    for (const bad of [
      "{not json",
      JSON.stringify({ v: 2, action: "open", requestId: "r1", title: "t", externalRecord: { system: "pi-decision", id: "d1" } }),
      JSON.stringify({ v: 1, action: "open", requestId: "bad\nid", title: "t", externalRecord: { system: "pi-decision", id: "d1" } }),
      JSON.stringify({ v: 1, action: "open", requestId: "r1", title: "t", externalRecord: { system: "../bad", id: "d1" } }),
      JSON.stringify({ v: 1, action: "open", requestId: "r1", title: "t", externalRecord: { system: "pi-decision", id: "bad\x1b[31m" } }),
      JSON.stringify({ v: 1, action: "open", requestId: "r1", title: "t", externalRecord: { system: "pi-decision", id: "x".repeat(129) } }),
    ]) {
      expect(relay.controlStatus({ method: "setStatus", statusKey: CHILD_QUESTION_STATUS_KEY, statusText: bad })).toBe(true);
    }
    expect(relay.pending).toBe(0);
    expect(io.emit).not.toHaveBeenCalled();

    // Valid external open frame.
    expect(relay.controlStatus({
      method: "setStatus",
      statusKey: CHILD_QUESTION_STATUS_KEY,
      statusText: JSON.stringify({
        v: 1,
        action: "open",
        requestId: "ext-1",
        title: "Choose DB",
        externalRecord: { system: "pi-decision", id: "dec_123" },
        hold: true,
      }),
    })).toBe(true);
    expect(relay.pending).toBe(1);
    expect(io.emit).toHaveBeenCalledWith(expect.objectContaining({
      requestId: "ext-1",
      method: "external",
      title: "Choose DB",
      hold: true,
      externalRecord: { system: "pi-decision", id: "dec_123" },
    }));
    expect(io.blocked).toHaveBeenCalledWith(100);

    // Parent ui_response clears pending without writing extension_ui_response to stdin.
    expect(relay.respond({ requestId: "ext-1", cancelled: true })).toBe(true);
    expect(relay.pending).toBe(0);
    expect(io.send).not.toHaveBeenCalled();
    expect(io.blocked).toHaveBeenLastCalledWith(undefined);

    // Open again and withdraw via control frame -> emits cancel.
    relay.controlStatus({
      method: "setStatus",
      statusKey: CHILD_QUESTION_STATUS_KEY,
      statusText: JSON.stringify({
        v: 1,
        action: "open",
        requestId: "ext-2",
        title: "Again",
        externalRecord: { system: "pi-decision", id: "dec_456" },
        hold: true,
      }),
    });
    expect(relay.controlStatus({
      method: "setStatus",
      statusKey: CHILD_QUESTION_STATUS_KEY,
      statusText: JSON.stringify({ v: 1, action: "withdraw", requestId: "ext-2" }),
    })).toBe(true);
    expect(io.cancel).toHaveBeenCalledWith("ext-2");
    expect(relay.pending).toBe(0);
    expect(io.blocked).toHaveBeenLastCalledWith(undefined);
    relay.close();
  });
});

describe("F-097: child-side pi-fabric:child-question:route:v1 extension event", () => {
  const load = async () => {
    const events = createEventBus();
    const shutdown: Array<() => unknown> = [];
    const pi = {
      events,
      getActiveTools: vi.fn(() => []),
      getAllTools: vi.fn(() => []),
      on: vi.fn((event: string, handler: () => unknown) => {
        if (event === "session_shutdown") shutdown.push(handler);
      }),
      registerCommand: vi.fn(),
      registerMessageRenderer: vi.fn(),
      registerTool: vi.fn(),
      setActiveTools: vi.fn(),
    } as unknown as ExtensionAPI;
    await piFabric(pi);
    return { events, shutdown };
  };

  it("declines outside a routed RPC worker and claims + emits open/withdraw inside one", async () => {
    const { events, shutdown } = await load();
    try {
      const setStatus = vi.fn();
      const claim = vi.fn();
      const respond = vi.fn();

      // Not a routed worker -> refused, claim not called.
      events.emit(FABRIC_CHILD_QUESTION_ROUTE_EVENT, {
        version: 1,
        context: { mode: "tui", ui: { setStatus } },
        requestId: "req-1",
        title: "Ask",
        externalRecord: { system: "pi-decision", id: "dec_1" },
        claim,
        respond,
      });
      expect(claim).not.toHaveBeenCalled();
      expect(setStatus).not.toHaveBeenCalled();
      expect(respond).toHaveBeenCalledWith({ ok: false, error: expect.any(String) });

      // Inside a routed RPC worker -> claimed, emits open and then withdraw on abort.
      vi.stubEnv("PI_FABRIC_CHILD_QUESTIONS", "route");
      vi.stubEnv("PI_FABRIC_LINEAGE", JSON.stringify({ version: 1, rootSessionId: "root", runId: "run-1", depth: 1, childIndex: 0, worker: true }));
      const controller = new AbortController();
      const claim2 = vi.fn();
      const respond2 = vi.fn();
      events.emit(FABRIC_CHILD_QUESTION_ROUTE_EVENT, {
        version: 1,
        context: { mode: "rpc", ui: { setStatus } },
        requestId: "req-2",
        title: "Deploy?",
        externalRecord: { system: "pi-decision", id: "dec_2" },
        hold: true,
        signal: controller.signal,
        claim: claim2,
        respond: respond2,
      });
      expect(claim2).toHaveBeenCalledTimes(1);
      expect(respond2).toHaveBeenCalledWith({ ok: true });
      expect(setStatus).toHaveBeenCalledTimes(1);
      expect(setStatus.mock.calls[0]![0]).toBe(FABRIC_CHILD_QUESTION_STATUS_KEY);
      expect(JSON.parse(setStatus.mock.calls[0]![1] as string)).toEqual({
        v: 1,
        action: "open",
        requestId: "req-2",
        title: "Deploy?",
        externalRecord: { system: "pi-decision", id: "dec_2" },
        hold: true,
      });

      controller.abort();
      expect(setStatus).toHaveBeenCalledTimes(2);
      expect(JSON.parse(setStatus.mock.calls[1]![1] as string)).toEqual({
        v: 1,
        action: "withdraw",
        requestId: "req-2",
      });
    } finally {
      for (const handler of shutdown) await handler();
    }
  });
});
