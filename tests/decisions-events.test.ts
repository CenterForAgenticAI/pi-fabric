import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { MeshStore, type MeshIdentity } from "../src/mesh/store.js";
import { DecisionStore, type DecisionRecord } from "../src/decisions/store.js";
import {
  answerFabricDecisionRequest,
  answerFabricDecisionsCapability,
  type ResolveFabricDecisions,
} from "../src/decisions/events.js";
import {
  readFabricDecisionRequestV1,
  readFabricDecisionsCapabilityRequestV1,
  type FabricDecisionQuestionV1,
  type FabricDecisionResultV1,
  type FabricDecisionsCapabilityResultV1,
} from "../src/protocol.js";

const roots: string[] = [];
const main: MeshIdentity = { id: "session:main", name: "main", kind: "main", sessionId: "main" };
const human = { answeredBy: "alice", via: "cli" };
const context = {} as ExtensionContext;

const decisionStore = (): DecisionStore => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-decision-events-"));
  roots.push(root);
  return new DecisionStore(new MeshStore(root, 64 * 1024, 500), main);
};

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const waitForOpen = async (store: DecisionStore): Promise<DecisionRecord> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const [open] = await store.list({ status: "open" });
    if (open) return open;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("no open decision appeared");
};

const ask = (
  question: FabricDecisionQuestionV1,
  resolve: ResolveFabricDecisions,
  extra: { signal?: AbortSignal; onRaised?: (id: string) => void } = {},
): Promise<FabricDecisionResultV1> =>
  new Promise((settle) => {
    void answerFabricDecisionRequest(
      { version: 1, context, question, claim: () => true, respond: settle, ...extra },
      resolve,
    );
  });

const capability = (resolve: ResolveFabricDecisions): Promise<FabricDecisionsCapabilityResultV1> =>
  new Promise((settle) => {
    void answerFabricDecisionsCapability({ version: 1, context, claim: () => true, respond: settle }, resolve);
  });

describe("decisions event channel", () => {
  it("reports the store limits when decisions are available", async () => {
    const store = decisionStore();
    const result = await capability(async () => ({ store }));
    expect(result).toMatchObject({ ok: true, available: true, maxOptions: 12, maxTitleChars: 200, minTimeoutMs: 1_000 });
    expect(result.ok && result.available && result.inputs).toEqual(["text", "confirm", "select", "editor"]);
  });

  it("reports the reason when decisions are unavailable", async () => {
    await expect(capability(async () => ({ reason: "mesh disabled" }))).resolves.toEqual({
      ok: true,
      available: false,
      reason: "mesh disabled",
    });
    await expect(ask({ title: "Pick" }, async () => ({ reason: "mesh disabled" }))).resolves.toEqual({
      ok: false,
      error: "mesh disabled",
    });
  });

  it("returns a person's answer and reports the raised id first", async () => {
    const store = decisionStore();
    const raised: string[] = [];
    const pending = ask(
      { title: "Pick a colour", options: [{ id: "red", label: "Red" }, { id: "blue", label: "Blue" }] },
      async () => ({ store }),
      { onRaised: (id) => raised.push(id) },
    );
    const open = await waitForOpen(store);
    expect(raised).toEqual([open.id]);
    await store.answer(open.id, { optionId: "blue" }, human);
    await expect(pending).resolves.toMatchObject({
      ok: true,
      id: open.id,
      status: "answered",
      answer: { optionId: "blue", answeredBy: "alice", via: "cli" },
    });
  });

  it("always holds the question for the user with no default, escalation, or program holder", async () => {
    const store = decisionStore();
    const hostile = {
      title: "Approve?",
      options: [{ id: "yes", label: "Yes", extra: "dropped" }],
      holder: "program",
      onExpire: "default",
      defaultOptionId: "yes",
      escalation: { chain: ["program"], hopTimeoutMs: 1, onFinal: "default" },
      kind: "approval",
    } as unknown as FabricDecisionQuestionV1;
    const controller = new AbortController();
    const pending = ask(hostile, async () => ({ store }), { signal: controller.signal });
    const open = await waitForOpen(store);
    expect(open).toMatchObject({ kind: "question", holder: "user", onExpire: "cancel" });
    expect(open.defaultOptionId).toBeUndefined();
    expect(open.escalation).toBeUndefined();
    expect(open.options).toEqual([{ id: "yes", label: "Yes" }]);
    controller.abort();
    await pending;
  });

  it("returns cancelled with no answer when a person cancels", async () => {
    const store = decisionStore();
    const pending = ask({ title: "Name?" }, async () => ({ store }));
    const open = await waitForOpen(store);
    await store.cancel(open.id, human);
    const result = await pending;
    expect(result).toEqual({ ok: true, id: open.id, status: "cancelled" });
  });

  it("returns expired with no answer when the timeout passes", async () => {
    let now = 1_000_000;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-decision-events-"));
    roots.push(root);
    const store = new DecisionStore(new MeshStore(root, 64 * 1024, 500), main, () => now);
    const pending = ask({ title: "Name?", timeoutMs: 1_000 }, async () => ({ store }));
    await waitForOpen(store);
    now += 2_000;
    const result = await pending;
    expect(result).toMatchObject({ ok: true, status: "expired" });
    expect("answer" in result).toBe(false);
  });

  it("cancels the stored decision when the caller aborts", async () => {
    const store = decisionStore();
    const controller = new AbortController();
    const pending = ask({ title: "Name?" }, async () => ({ store }), { signal: controller.signal });
    const open = await waitForOpen(store);
    controller.abort();
    await expect(pending).resolves.toEqual({ ok: false, id: open.id, error: "Decision request aborted" });
    expect((await store.get(open.id))?.status).toBe("cancelled");
  });

  it("rejects invalid questions without raising a decision", async () => {
    const store = decisionStore();
    const result = await ask({ title: "" }, async () => ({ store }));
    expect(result.ok).toBe(false);
    expect(await store.list()).toEqual([]);
  });

  it("ignores malformed requests", () => {
    const base = { version: 1, context, claim: () => true, respond: () => undefined };
    expect(readFabricDecisionsCapabilityRequestV1(base)).toBeDefined();
    expect(readFabricDecisionsCapabilityRequestV1({ ...base, version: 2 })).toBeUndefined();
    expect(readFabricDecisionRequestV1({ ...base, question: { title: "x" } })).toBeDefined();
    expect(readFabricDecisionRequestV1(base)).toBeUndefined();
    expect(readFabricDecisionRequestV1({ ...base, question: [] })).toBeUndefined();
    expect(readFabricDecisionRequestV1({ ...base, question: { title: "x" }, signal: {} })).toBeUndefined();
    expect(readFabricDecisionRequestV1({ ...base, question: { title: "x" }, onRaised: "no" })).toBeUndefined();
  });
});
