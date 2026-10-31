import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerFabricCommand } from "../src/commands/fabric.js";
import type { CapturedToolCatalog } from "../src/capture/catalog.js";
import type { FabricState } from "../src/fabric-state.js";
import type { FabricUiController } from "../src/ui/controller.js";
import { FABRIC_DECISIONS_CAPABILITY_EVENT, FABRIC_DECISION_REQUEST_EVENT } from "../src/protocol.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MeshStore, type MeshIdentity } from "../src/mesh/store.js";
import { DecisionStore, MAX_ESCALATION_HOP_MS } from "../src/decisions/store.js";
import {
  answerFabricDecisionRequest,
  answerFabricDecisionsCapability,
  type FabricDecisionsTarget,
} from "../src/decisions/events.js";
import { DEFAULT_FABRIC_CONFIG, normalizeFabricConfig } from "../src/config.js";
import { DecisionsProvider } from "../src/providers/decisions-provider.js";
import {
  readFabricDecisionRequestV1,
  type FabricDecisionQuestionV1,
  type FabricDecisionResultV1,
  type FabricDecisionsCapabilityResultV1,
  type FabricInvocationContext,
} from "../src/protocol.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const roots: string[] = [];
const asker: MeshIdentity = { id: "session:asker", name: "asker", kind: "main", sessionId: "asker" };
const overseer: MeshIdentity = { id: "session:overseer", name: "overseer", kind: "main", sessionId: "overseer" };
const SOURCE = "@acme/ask-tool";
const SUPERVISOR = "session:overseer";
const context = {} as ExtensionContext;

const meshAt = (): MeshStore => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-decision-supervisor-"));
  roots.push(root);
  return new MeshStore(root, 64 * 1024, 500);
};

const clock = (start = 10_000_000) => {
  const state = { now: start };
  return { state, now: () => state.now };
};

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

interface Asked {
  result: Promise<FabricDecisionResultV1>;
  raised: Promise<string>;
  abort: () => void;
}

const ask = (
  store: DecisionStore,
  extra: { source?: string; supervisor?: string },
  question: FabricDecisionQuestionV1 = { title: "Pick", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], timeoutMs: 60_000 },
  supervisorSources: readonly string[] = [SOURCE],
): Asked => {
  const controller = new AbortController();
  let markRaised!: (id: string) => void;
  const raised = new Promise<string>((settle) => { markRaised = settle; });
  const result = new Promise<FabricDecisionResultV1>((settle) => {
    void answerFabricDecisionRequest(
      { version: 1, context, question, claim: () => true, respond: settle, signal: controller.signal, onRaised: markRaised, ...extra },
      async () => ({ store, supervisorSources }),
    );
  });
  return { result, raised, abort: () => controller.abort() };
};

const capability = (
  target: FabricDecisionsTarget,
  source?: string,
): Promise<FabricDecisionsCapabilityResultV1> =>
  new Promise((settle) => {
    void answerFabricDecisionsCapability(
      { version: 1, context, claim: () => true, respond: settle, ...(source !== undefined ? { source } : {}) },
      async () => target,
    );
  });

const stored = async (store: DecisionStore, id: string) => {
  const record = await store.get(id);
  if (!record) throw new Error(`decision ${id} is not stored`);
  return record;
};

const invocation = (id: string): FabricInvocationContext => ({
  cwd: process.cwd(),
  signal: undefined,
  parentToolCallId: id,
  nestedToolCallId: `${id}:n`,
  extensionContext: {} as FabricInvocationContext["extensionContext"],
  update: () => {},
});

describe("decision request supervisor holder", () => {
  it("keeps the user holder when the source is not allow-listed, naming a supervisor or not", async () => {
    const store = new DecisionStore(meshAt(), asker);
    for (const [source, list] of [[undefined, [SOURCE]], ["@other/tool", [SOURCE]], [SOURCE, []]] as const) {
      const pending = ask(store, { ...(source !== undefined ? { source } : {}), supervisor: SUPERVISOR }, undefined, list);
      const open = await stored(store, await pending.raised);
      expect(open).toMatchObject({ holder: "user", onExpire: "cancel" });
      expect(open.escalation).toBeUndefined();
      pending.abort();
      await pending.result;
    }
  });

  it("keeps the user holder when an allow-listed source names no supervisor", async () => {
    const store = new DecisionStore(meshAt(), asker);
    const pending = ask(store, { source: SOURCE });
    const open = await stored(store, await pending.raised);
    expect(open).toMatchObject({ holder: "user", onExpire: "cancel" });
    expect(open.escalation).toBeUndefined();
    pending.abort();
    await pending.result;
  });

  it("holds for the supervisor with a chain of exactly [supervisor, user] and never root", async () => {
    const { state, now } = clock();
    const store = new DecisionStore(meshAt(), asker, now);
    const pending = ask(store, { source: SOURCE, supervisor: SUPERVISOR });
    const open = await stored(store, await pending.raised);
    expect(open).toMatchObject({
      status: "open",
      holder: `supervisor:${SUPERVISOR}`,
      onExpire: "escalate",
      deadline: state.now + 60_000,
      escalation: { chain: [`supervisor:${SUPERVISOR}`, "user"], hop: 0, hopTimeoutMs: MAX_ESCALATION_HOP_MS, onFinal: "cancel" },
    });
    expect(open.escalation?.chain).not.toContain("root");
    expect(open.raisedBy).toMatchObject({ participantId: `extension:${SOURCE}` });
    pending.abort();
    await pending.result;
  });

  it("refuses a supervisor that is the store's own identity, without raising a decision", async () => {
    const store = new DecisionStore(meshAt(), asker);
    const result = await ask(store, { source: SOURCE, supervisor: asker.id }).result;
    expect(result.ok).toBe(false);
    expect(await store.list()).toEqual([]);
  });

  it("refuses user, root, extension:* and malformed supervisors, without raising a decision", async () => {
    const store = new DecisionStore(meshAt(), asker);
    const bad = ["user", "root", "extension:@acme/ask-tool", "extension:x", "", " session:x", "a b", "-x", "x".repeat(129), "a\nb"];
    for (const supervisor of bad) {
      const result = await ask(store, { source: SOURCE, supervisor }).result;
      expect(result.ok, JSON.stringify(supervisor)).toBe(false);
    }
    expect(await store.list()).toEqual([]);
  });

  it("does not refuse a bad supervisor from a source that is not allow-listed", async () => {
    const store = new DecisionStore(meshAt(), asker);
    const pending = ask(store, { source: "@other/tool", supervisor: "root" });
    const open = await stored(store, await pending.raised);
    expect(open.holder).toBe("user");
    pending.abort();
    await pending.result;
  });

  it("does not let the asking session answer through the decisions provider", async () => {
    const mesh = meshAt();
    const askerStore = new DecisionStore(mesh, asker);
    const pending = ask(askerStore, { source: SOURCE, supervisor: SUPERVISOR });
    const id = await pending.raised;
    const askerProvider = new DecisionsProvider(askerStore, asker);
    await expect(askerProvider.invoke("answer", { id, optionId: "a" }, invocation("a1"))).rejects.toThrow(/not this participant/);
    await expect(askerProvider.invoke("escalate", { id }, invocation("a2"))).rejects.toThrow(/not this participant/);
    expect((await stored(askerStore, id)).status).toBe("open");
    // The named supervisor can.
    const overseerProvider = new DecisionsProvider(new DecisionStore(mesh, overseer), overseer);
    await overseerProvider.invoke("answer", { id, optionId: "b" }, invocation("o1"));
    await expect(pending.result).resolves.toMatchObject({ ok: true, status: "answered", answer: { optionId: "b", answeredBy: overseer.id } });
  });

  it("moves to the user when the supervisor's hold ends, then the asker still cannot answer", async () => {
    const { state, now } = clock();
    const mesh = meshAt();
    const store = new DecisionStore(mesh, asker, now);
    const pending = ask(store, { source: SOURCE, supervisor: SUPERVISOR });
    const id = await pending.raised;
    const raised = await stored(store, id);
    state.now = raised.deadline! + 10;
    const moved = await stored(store, id);
    expect(moved).toMatchObject({
      status: "open",
      holder: "user",
      escalation: { hop: 1 },
      history: [{ holder: `supervisor:${SUPERVISOR}`, reason: "expired" }],
    });
    await expect(new DecisionsProvider(store, asker).invoke("answer", { id, optionId: "a" }, invocation("u1")))
      .rejects.toThrow(/held by the user/);
    // A person answers.
    await store.answer(id, { optionId: "a" }, { answeredBy: "alice", via: "cli" });
    await expect(pending.result).resolves.toMatchObject({ ok: true, status: "answered", answer: { answeredBy: "alice" } });
  });

  it("ends with a non-answer when the final hop passes unanswered", async () => {
    const { state, now } = clock();
    const store = new DecisionStore(meshAt(), asker, now);
    const pending = ask(store, { source: SOURCE, supervisor: SUPERVISOR });
    const id = await pending.raised;
    const raised = await stored(store, id);
    state.now = raised.deadline! + MAX_ESCALATION_HOP_MS + 10;
    const final = await stored(store, id);
    expect(final).toMatchObject({ status: "expired", holder: "user" });
    expect(final.answer).toBeUndefined();
    const result = await pending.result;
    expect(result).toMatchObject({ ok: true, id, status: "expired" });
    expect("answer" in result).toBe(false);
  });

  it("reports supervisor capability only for an allow-listed source", async () => {
    const store = new DecisionStore(meshAt(), asker);
    const target = { store, supervisorSources: [SOURCE] };
    expect(await capability(target, SOURCE)).toMatchObject({ ok: true, available: true, supervisor: true });
    expect(await capability(target, "@other/tool")).toMatchObject({ ok: true, available: true, supervisor: false });
    expect(await capability(target)).toMatchObject({ ok: true, available: true, supervisor: false });
    expect(await capability({ store }, SOURCE)).toMatchObject({ ok: true, available: true, supervisor: false });
    expect(await capability({ reason: "off" }, SOURCE)).toEqual({ ok: true, available: false, reason: "off" });
  });

  it("defaults supervisorSources to none and keeps only trimmed, bounded strings", () => {
    expect(DEFAULT_FABRIC_CONFIG.decisions.supervisorSources).toEqual([]);
    expect(normalizeFabricConfig({}).decisions.supervisorSources).toEqual([]);
    expect(normalizeFabricConfig({ decisions: { supervisorSources: "ask" } }).decisions.supervisorSources).toEqual([]);
    expect(normalizeFabricConfig({
      decisions: { supervisorSources: [" @acme/ask-tool ", "@acme/ask-tool", "", 7, "x".repeat(65), "other"] },
    }).decisions.supervisorSources).toEqual(["@acme/ask-tool", "other"]);
  });

  it("wires the host's decisions.supervisorSources into the event handlers", async () => {
    const store = new DecisionStore(meshAt(), asker);
    const listeners = new Map<string, (value: unknown) => void>();
    const pi = {
      events: { on: (channel: string, handler: (value: unknown) => void) => { listeners.set(channel, handler); return () => undefined; } },
      on: () => undefined,
      registerCommand: () => undefined,
    } as unknown as ExtensionAPI;
    const state = {
      ensure: async () => undefined,
      config: { mesh: { enabled: true }, decisions: { supervisorSources: [SOURCE] } },
      decisionStore: () => store,
    } as unknown as FabricState;
    registerFabricCommand(pi, {
      state,
      fabricUi: {} as FabricUiController,
      capturedTools: {} as CapturedToolCatalog,
      applyFabricMode: () => undefined,
      suspendToolCapture: () => undefined,
    });
    const reply = (source?: string) => new Promise<FabricDecisionsCapabilityResultV1>((settle) => {
      listeners.get(FABRIC_DECISIONS_CAPABILITY_EVENT)?.({ version: 1, context, claim: () => true, respond: settle, ...(source ? { source } : {}) });
    });
    expect(await reply(SOURCE)).toMatchObject({ available: true, supervisor: true });
    expect(await reply("@other/tool")).toMatchObject({ available: true, supervisor: false });
    let markRaised!: (id: string) => void;
    const raised = new Promise<string>((settle) => { markRaised = settle; });
    const settled = new Promise<FabricDecisionResultV1>((settle) => {
      listeners.get(FABRIC_DECISION_REQUEST_EVENT)?.({
        version: 1, context, question: { title: "Pick" }, source: SOURCE, supervisor: SUPERVISOR,
        claim: () => true, respond: settle, onRaised: markRaised,
      });
    });
    const open = await stored(store, await raised);
    expect(open).toMatchObject({ holder: `supervisor:${SUPERVISOR}`, escalation: { chain: [`supervisor:${SUPERVISOR}`, "user"] } });
    await store.cancel(open.id, { answeredBy: "alice", via: "cli" });
    await settled;
  });

  it("reads only a string supervisor from the event", () => {
    const base = { version: 1, context, question: { title: "x" }, claim: () => true, respond: () => undefined };
    expect(readFabricDecisionRequestV1({ ...base, supervisor: SUPERVISOR })).toBeDefined();
    expect(readFabricDecisionRequestV1({ ...base, supervisor: 42 })).toBeUndefined();
  });
});
