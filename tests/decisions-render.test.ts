import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEventBus, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MeshStore, type MeshIdentity } from "../src/mesh/store.js";
import { DecisionStore, type DecisionRecord } from "../src/decisions/store.js";
import { routeChildQuestion } from "../src/decisions/host.js";
import { openFabricDecisions } from "../src/decisions/command.js";
import type { AgentChildQuestionRequest } from "../src/agents/types.js";

// The literal event name is the contract; the tests do not import it so they
// fail on behaviour, not on a missing export, when the hook is absent.
const RENDER_EVENT = "pi-fabric:questions:render:v1";

interface RenderRequest {
  version: number;
  surface: string;
  context: unknown;
  decision: DecisionRecord;
  signal: AbortSignal;
  claim: (render: () => unknown) => boolean;
}

const roots: string[] = [];
const main: MeshIdentity = { id: "session:main", name: "main", kind: "main", sessionId: "main" };
const human = { answeredBy: "alice", via: "cli" };

const decisionStore = (now?: () => number): DecisionStore => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-decision-render-"));
  roots.push(root);
  return new DecisionStore(new MeshStore(root, 64 * 1024, 500), main, now);
};

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const request = (
  question: Record<string, unknown>,
  signal = new AbortController().signal,
): AgentChildQuestionRequest & { onDecision: ReturnType<typeof vi.fn<(id: string) => void>> } => ({
  runId: "run-1",
  name: "worker",
  question: { requestId: "q1", timeout: 60_000, ...question },
  signal,
  onDecision: vi.fn<(id: string) => void>(),
});

const pick = { method: "select", title: "Pick", message: "why", options: ["Alpha", "Beta"] };

/** A renderer that records every request and answers with `render`. */
const registerRenderer = (
  render: (request: RenderRequest) => unknown,
): { events: ReturnType<typeof createEventBus>; seen: RenderRequest[] } => {
  const events = createEventBus();
  const seen: RenderRequest[] = [];
  events.on(RENDER_EVENT, (value) => {
    const incoming = value as RenderRequest;
    seen.push(incoming);
    incoming.claim(() => render(incoming));
  });
  return { events, seen };
};

const uiContext = () => {
  const select = vi.fn(async (_title: string, options: string[]) => options[1]);
  const notify = vi.fn();
  const context = { hasUI: true, ui: { select, notify } } as unknown as ExtensionContext;
  return { context, select, notify };
};

const untilAborted = (signal: AbortSignal): Promise<never> =>
  new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));

describe("pi-fabric:questions:render:v1 for routed child questions", () => {
  it("lets a registered renderer answer, so ctx.ui.select is never called", async () => {
    const store = decisionStore();
    const { context, select } = uiContext();
    const { events, seen } = registerRenderer((incoming) => ({
      status: "answered",
      decisionId: incoming.decision.id,
      answer: { optionId: "o2" },
    }));
    const routed = request(pick);
    expect(await routeChildQuestion(routed, { context, store, events })).toEqual({ value: "Beta" });
    expect(select).not.toHaveBeenCalled();
    expect(seen).toHaveLength(1);
    const [incoming] = seen;
    expect(incoming).toMatchObject({
      version: 1,
      surface: "child-question",
      decision: {
        kind: "question",
        title: "worker: Pick",
        body: "why",
        input: "select",
        holder: "root",
        options: [{ id: "o1", label: "Alpha" }, { id: "o2", label: "Beta" }],
        raisedBy: { participantId: "run-1", runId: "run-1" },
      },
    });
    expect(incoming!.context).toBe(context);
    expect(routed.onDecision).toHaveBeenCalledWith(incoming!.decision.id);
    expect(await store.get(incoming!.decision.id)).toMatchObject({
      status: "answered",
      answer: { optionId: "o2", via: "tui" },
    });
  });

  it("falls back to ctx.ui when no renderer claims, and records the answer", async () => {
    const store = decisionStore();
    const { context, select } = uiContext();
    const routed = request(pick);
    expect(await routeChildQuestion(routed, { context, store, events: createEventBus() })).toEqual({ value: "Beta" });
    expect(select).toHaveBeenCalledWith("worker: Pick", ["Alpha", "Beta"], expect.objectContaining({ timeout: 60_000 }));
    const id = routed.onDecision.mock.calls[0]![0];
    expect(await store.get(id)).toMatchObject({ status: "answered", answer: { optionId: "o2", via: "tui" } });
  });

  it("falls back to ctx.ui when the renderer throws or rejects", async () => {
    for (const render of [
      () => { throw new Error("renderer broke"); },
      async () => { throw new Error("renderer broke later"); },
    ]) {
      const store = decisionStore();
      const { context, select } = uiContext();
      const { events, seen } = registerRenderer(render);
      expect(await routeChildQuestion(request(pick), { context, store, events })).toEqual({ value: "Beta" });
      expect(seen).toHaveLength(1);
      expect(select).toHaveBeenCalledTimes(1);
      expect((await store.get(seen[0]!.decision.id))?.status).toBe("answered");
    }
  });

  it("refuses an answer for a different decision and falls back to ctx.ui", async () => {
    const store = decisionStore();
    const other = await store.raise({ title: "Unrelated", options: [{ id: "o2", label: "Yes" }], holder: "user" });
    const { context, select } = uiContext();
    const { events } = registerRenderer(() => ({
      status: "answered",
      decisionId: other.id,
      answer: { optionId: "o2" },
    }));
    expect(await routeChildQuestion(request(pick), { context, store, events })).toEqual({ value: "Beta" });
    expect(select).toHaveBeenCalledTimes(1);
    expect((await store.get(other.id))?.status).toBe("open");
  });

  it("lets a renderer change only the answer, never holder, raiser or attribution", async () => {
    const store = decisionStore();
    const { context, select } = uiContext();
    const { events, seen } = registerRenderer((incoming) => {
      // Mutating the copy it was handed must not reach the record.
      incoming.decision.holder = "user";
      incoming.decision.raisedBy.participantId = "session:main";
      return {
        status: "answered",
        decisionId: incoming.decision.id,
        holder: "user",
        answeredBy: "session:main",
        via: "cli",
        answer: { optionId: "o1", answeredBy: "session:main", via: "cli", at: 1 },
      };
    });
    expect(await routeChildQuestion(request(pick), { context, store, events })).toEqual({ value: "Alpha" });
    expect(select).not.toHaveBeenCalled();
    const stored = await store.get(seen[0]!.decision.id);
    expect(stored).toMatchObject({ holder: "root", raisedBy: { participantId: "run-1" }, answer: { optionId: "o1", via: "tui" } });
    expect(stored?.answer?.answeredBy).not.toBe("session:main");
    expect(stored?.answer?.at).not.toBe(1);
  });

  it("falls back to ctx.ui when the renderer's answer does not fit the decision", async () => {
    const store = decisionStore();
    const { context, select } = uiContext();
    const { events, seen } = registerRenderer((incoming) => ({
      status: "answered",
      decisionId: incoming.decision.id,
      answer: { optionId: "o9" },
    }));
    expect(await routeChildQuestion(request(pick), { context, store, events })).toEqual({ value: "Beta" });
    expect(select).toHaveBeenCalledTimes(1);
    expect((await store.get(seen[0]!.decision.id))?.answer?.optionId).toBe("o2");
  });

  it("aborts the render when the decision is cancelled in the store", async () => {
    const store = decisionStore();
    const { context, select } = uiContext();
    let renderSignal: AbortSignal | undefined;
    const { events, seen } = registerRenderer((incoming) => {
      renderSignal = incoming.signal;
      void store.cancel(incoming.decision.id, human);
      return untilAborted(incoming.signal);
    });
    expect(await routeChildQuestion(request(pick), { context, store, events })).toEqual({ cancelled: true });
    expect(renderSignal?.aborted).toBe(true);
    expect(select).not.toHaveBeenCalled();
    expect(await store.get(seen[0]!.decision.id)).toMatchObject({ status: "cancelled", answer: { via: "cli" } });
  });

  it("aborts the render when the decision expires", async () => {
    let now = 1_000_000;
    const store = decisionStore(() => now);
    const { context, select } = uiContext();
    const { events, seen } = registerRenderer((incoming) => {
      now += 120_000;
      return untilAborted(incoming.signal);
    });
    expect(await routeChildQuestion(request(pick), { context, store, events })).toEqual({ cancelled: true });
    expect(seen[0]!.signal.aborted).toBe(true);
    expect(select).not.toHaveBeenCalled();
    expect((await store.get(seen[0]!.decision.id))?.status).toBe("expired");
  });

  it("aborts the render and cancels the decision when the child run settles", async () => {
    const store = decisionStore();
    const { context, select } = uiContext();
    const controller = new AbortController();
    const { events, seen } = registerRenderer((incoming) => {
      controller.abort(new Error("settled"));
      return untilAborted(incoming.signal);
    });
    // As on the headless path, the abort reason rejects; the manager turns it into a cancel.
    await expect(routeChildQuestion(request(pick, controller.signal), { context, store, events })).rejects.toThrow("settled");
    expect(seen[0]!.signal.aborted).toBe(true);
    expect(select).not.toHaveBeenCalled();
    expect(await store.get(seen[0]!.decision.id)).toMatchObject({ status: "cancelled", answer: { via: "abort" } });
  });

  it("cancels the decision when the renderer dismisses the question", async () => {
    const store = decisionStore();
    const { context, select } = uiContext();
    const { events, seen } = registerRenderer((incoming) => ({ status: "dismissed", decisionId: incoming.decision.id }));
    expect(await routeChildQuestion(request(pick), { context, store, events })).toEqual({ cancelled: true });
    expect(select).not.toHaveBeenCalled();
    expect((await store.get(seen[0]!.decision.id))?.status).toBe("cancelled");
  });
});

describe("recorded child questions on the ctx.ui path", () => {
  it("keeps a select with more options than a decision holds on the direct dialog, unrecorded", async () => {
    const store = decisionStore();
    const options = Array.from({ length: 13 }, (_, index) => `Option ${index + 1}`);
    const select = vi.fn(async () => "Option 13");
    const context = { hasUI: true, ui: { select } } as unknown as ExtensionContext;
    const { events, seen } = registerRenderer(() => undefined);
    const routed = request({ method: "select", title: "Many", options });
    expect(await routeChildQuestion(routed, { context, store, events })).toEqual({ value: "Option 13" });
    expect(seen).toHaveLength(0);
    expect(routed.onDecision).not.toHaveBeenCalled();
    expect(await store.list()).toEqual([]);
  });

  it("relays a nested child's question to its parent's UI without recording it", async () => {
    const store = decisionStore();
    const select = vi.fn(async () => "Beta");
    const context = { hasUI: true, ui: { select } } as unknown as ExtensionContext;
    const { events, seen } = registerRenderer(() => undefined);
    const routed = request(pick);
    expect(await routeChildQuestion(routed, { context, store, events, relayUi: true })).toEqual({ value: "Beta" });
    expect(seen).toHaveLength(0);
    expect(routed.onDecision).not.toHaveBeenCalled();
    expect(await store.list()).toEqual([]);
  });

  it("cancels the record and the child's dialog when the store refuses the typed text", async () => {
    const store = decisionStore();
    const editor = vi.fn(async () => "x".repeat(4_001));
    const context = { hasUI: true, ui: { editor } } as unknown as ExtensionContext;
    const routed = request({ method: "editor", title: "Draft" });
    expect(await routeChildQuestion(routed, { context, store, events: createEventBus() })).toEqual({ cancelled: true });
    expect(editor).toHaveBeenCalledTimes(1);
    expect((await store.get(routed.onDecision.mock.calls[0]![0]))?.status).toBe("cancelled");
  });

  it("closes the dialog and returns the record's answer when the CLI answers first", async () => {
    const store = decisionStore();
    let dialogSignal: AbortSignal | undefined;
    const select = vi.fn(async (_title: string, _options: string[], dialog: { signal: AbortSignal }) => {
      dialogSignal = dialog.signal;
      const [open] = await store.list({ status: "open" });
      await store.answer(open!.id, { optionId: "o1" }, human);
      await new Promise((resolve) => dialog.signal.addEventListener("abort", resolve, { once: true }));
      return undefined;
    });
    const context = { hasUI: true, ui: { select } } as unknown as ExtensionContext;
    expect(await routeChildQuestion(request(pick), { context, store, events: createEventBus() })).toEqual({ value: "Alpha" });
    expect(dialogSignal?.aborted).toBe(true);
  });
});

describe("pi-fabric:questions:render:v1 in /fabric decisions", () => {
  it("lets a registered renderer answer the picked decision without ctx.ui dialogs", async () => {
    const store = decisionStore();
    const record = await store.raise({ title: "Why?", holder: "user" });
    const { context, select, notify } = uiContext();
    const { events, seen } = registerRenderer((incoming) => ({
      status: "answered",
      decisionId: incoming.decision.id,
      answer: { text: "because" },
    }));
    await openFabricDecisions(store.mesh, context, record.id, events);
    expect(select).not.toHaveBeenCalled();
    expect(seen[0]).toMatchObject({ surface: "decisions-command", decision: { id: record.id, input: "text" } });
    expect(await store.get(record.id)).toMatchObject({ status: "answered", answer: { text: "because", via: "tui" } });
    expect(notify).toHaveBeenLastCalledWith(`Answered ${record.id}`, "info");
  });

  it("leaves the decision open when the renderer dismisses it, and falls back when it throws", async () => {
    const store = decisionStore();
    const record = await store.raise({ title: "Pick", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] });
    const dismissed = uiContext();
    await openFabricDecisions(
      store.mesh,
      dismissed.context,
      record.id,
      registerRenderer((incoming) => ({ status: "dismissed", decisionId: incoming.decision.id })).events,
    );
    expect(dismissed.select).not.toHaveBeenCalled();
    expect((await store.get(record.id))?.status).toBe("open");

    const broken = uiContext();
    await openFabricDecisions(store.mesh, broken.context, record.id, registerRenderer(() => {
      throw new Error("renderer broke");
    }).events);
    expect(broken.select).toHaveBeenCalledTimes(1);
    expect(await store.get(record.id)).toMatchObject({ status: "answered", answer: { optionId: "b" } });
  });

  it("lets a renderer cancel the decision it was handed, and only that one", async () => {
    const store = decisionStore();
    const other = await store.raise({ title: "Other" });
    const record = await store.raise({ title: "Mine" });
    const wrong = uiContext();
    wrong.select.mockImplementation(async () => undefined);
    await openFabricDecisions(store.mesh, wrong.context, record.id, registerRenderer(() => ({
      status: "cancelled",
      decisionId: other.id,
    })).events);
    expect(wrong.select).toHaveBeenCalledTimes(1);
    expect((await store.get(other.id))?.status).toBe("open");
    expect((await store.get(record.id))?.status).toBe("open");

    const right = uiContext();
    await openFabricDecisions(store.mesh, right.context, record.id, registerRenderer((incoming) => ({
      status: "cancelled",
      decisionId: incoming.decision.id,
    })).events);
    expect(right.select).not.toHaveBeenCalled();
    expect(await store.get(record.id)).toMatchObject({ status: "cancelled", answer: { via: "tui" } });
    expect((await store.get(other.id))?.status).toBe("open");
  });

  it("aborts the render when the decision is answered elsewhere", async () => {
    const store = decisionStore();
    const record = await store.raise({ title: "Why?" });
    const { context, select, notify } = uiContext();
    const { events, seen } = registerRenderer((incoming) => {
      void store.answer(incoming.decision.id, { text: "from cli" }, human);
      return untilAborted(incoming.signal);
    });
    await openFabricDecisions(store.mesh, context, record.id, events);
    expect(seen[0]!.signal.aborted).toBe(true);
    expect(select).not.toHaveBeenCalled();
    expect(await store.get(record.id)).toMatchObject({ status: "answered", answer: { text: "from cli", via: "cli" } });
    expect(notify).toHaveBeenLastCalledWith(`Answered ${record.id}`, "info");
  });
});
