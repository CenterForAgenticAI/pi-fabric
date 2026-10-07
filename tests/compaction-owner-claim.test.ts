import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
  type SessionBeforeTreeEvent,
  type SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CapturedToolCatalog } from "../src/capture/catalog.js";
import { CompactionOwnerRegistry } from "../src/compaction/claim.js";
import { registerCompactionHook } from "../src/compaction/hook.js";
import { normalizeFabricConfig } from "../src/config.js";
import {
  COMPACTION_SEED_DELIVERY,
  CompactController,
  compactionSeedMessage,
  type CompactionSeedMessage,
} from "../src/core/compact-controller.js";
import { FabricRuntimeState } from "../src/fabric-runtime-state.js";
import piFabric from "../src/index.js";
import {
  FABRIC_COMPACTION_OWNER_EVENT,
  readFabricCompactionOwnerMessageV1,
  type FabricCompactionOwnerActionsV1,
  type FabricCompactionOwnerClaimResultV1,
  type FabricCompactionOwnerHandleV1,
  type FabricCompactionOwnerWithdrawResultV1,
  type FabricInvocationContext,
} from "../src/protocol.js";
import { CompactProvider } from "../src/providers/compact-provider.js";
import { GUEST_TYPE_DECLARATIONS } from "../src/runtime/guest-types.js";
import { typeCheckFabricCode } from "../src/runtime/type-checker.js";

type Handler = (event: unknown, context: ExtensionContext) => unknown;

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const fakePi = () => {
  const listeners = new Map<string, (value: unknown) => unknown>();
  const handlers = new Map<string, Handler[]>();
  const pi = {
    events: {
      emit: vi.fn((channel: string, value: unknown) => listeners.get(channel)?.(value)),
      on: vi.fn((channel: string, handler: (value: unknown) => unknown) => {
        listeners.set(channel, handler);
        return () => listeners.delete(channel);
      }),
    },
    on: vi.fn((event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    }),
    getActiveTools: vi.fn(() => ["fabric_exec"]),
    getAllTools: vi.fn(() => [{ name: "fabric_exec" }]),
    registerCommand: vi.fn(),
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn(),
    setActiveTools: vi.fn(),
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
    appendEntry: vi.fn(),
    getThinkingLevel: vi.fn(() => "off"),
  } as unknown as ExtensionAPI;
  const emit = async (name: string, event: unknown, context: ExtensionContext) => {
    const results: unknown[] = [];
    for (const handler of handlers.get(name) ?? []) results.push(await handler(event, context));
    return results;
  };
  return { pi, listeners, handlers, emit };
};

const loadFabric = async () => {
  const host = fakePi();
  await piFabric(host.pi);
  const shutdown = async () => {
    await host.emit("session_shutdown", {}, {} as ExtensionContext);
  };
  cleanups.push(shutdown);
  const compact = (event: SessionBeforeCompactEvent, context = {} as ExtensionContext) =>
    host.handlers.get("session_before_compact")![0]!(event, context);
  const tree = (event: SessionBeforeTreeEvent, context = {} as ExtensionContext) =>
    host.handlers.get("session_before_tree")![0]!(event, context);
  const send = (message: unknown) => host.pi.events.emit(FABRIC_COMPACTION_OWNER_EVENT, message);
  return { ...host, compact, tree, send, shutdown };
};

const assistant = (text: string) => ({
  role: "assistant", content: [{ type: "text", text }], api: "anthropic-messages", provider: "test", model: "test",
  stopReason: "stop", timestamp: 1,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
}) as Extract<SessionMessageEntry["message"], { role: "assistant" }>;

const longSession = () => {
  const session = SessionManager.inMemory();
  session.appendMessage({ role: "user", content: "Original task: migrate the auth module", timestamp: 1 });
  session.appendMessage(assistant("Earlier result"));
  session.appendMessage({ role: "user", content: "Long autonomous turn", timestamp: 2 });
  for (let i = 0; i < 12; i++) session.appendMessage(assistant(`Stage ${i}: ${"x".repeat(8_000)}`));
  session.appendMessage(assistant("Latest progress"));
  return session;
};

const compactEvent = (session: SessionManager, reason: "manual" | "threshold" = "manual"): SessionBeforeCompactEvent => ({
  type: "session_before_compact",
  reason,
  branchEntries: session.getBranch(),
  preparation: { tokensBefore: 40_000, settings: { enabled: true, keepRecentTokens: 1_000, reserveTokens: 16_384 } },
} as unknown as SessionBeforeCompactEvent);

const treeEvent = (session: SessionManager): SessionBeforeTreeEvent => ({
  type: "session_before_tree",
  preparation: {
    userWantsSummary: true,
    entriesToSummarize: session.getBranch(),
    oldLeafId: session.getLeafId(),
  },
} as unknown as SessionBeforeTreeEvent);

const owner = { name: "pi-context-aware", version: "1.4.0" };

const claimMessage = (overrides: Record<string, unknown> = {}) => {
  let result: FabricCompactionOwnerClaimResultV1 | undefined;
  return {
    message: {
      version: 1,
      type: "claim",
      owner,
      actions: {},
      reply: (value: FabricCompactionOwnerClaimResultV1) => { result = value; },
      ...overrides,
    },
    result: () => result,
  };
};

const claimed = (send: (message: unknown) => unknown, overrides: Record<string, unknown> = {}): FabricCompactionOwnerHandleV1 => {
  const claim = claimMessage(overrides);
  send(claim.message);
  const result = claim.result();
  if (!result?.ok) throw new Error(`claim failed: ${JSON.stringify(result)}`);
  return result.handle;
};

const invocation = (extensionContext = {} as ExtensionContext): FabricInvocationContext => ({
  cwd: process.cwd(),
  signal: undefined,
  parentToolCallId: "test",
  nestedToolCallId: "nested",
  extensionContext,
  update() {},
  activity() {},
});

describe("compaction owner protocol", () => {
  it("copies only named fields from a claim", () => {
    const handler = () => undefined;
    const signal = new AbortController().signal;
    const raw = {
      version: 1,
      type: "claim",
      owner: { name: "pi-context-aware", version: "1.4.0", secret: "dropped" },
      actions: { request: { fields: ["seed", "instructions", "seed"], handler } },
      branchSummary: false,
      signal,
      reply: () => undefined,
    };
    const read = readFabricCompactionOwnerMessageV1(raw);
    if (!read.ok || read.message.type !== "claim") throw new Error("expected a claim");
    expect(read.message.owner).toEqual({ name: "pi-context-aware", version: "1.4.0" });
    expect(read.message.owner).not.toBe(raw.owner);
    expect(read.message.actions.request?.fields).toEqual(["seed", "instructions"]);
    expect(read.message.actions.request?.handler).toBe(handler);
    expect(read.message.actions).not.toBe(raw.actions);
    expect("branchSummary" in read.message).toBe(false);
    expect(read.message.signal).toBe(signal);
  });

  it.each([
    ["unknown top-level key", { branchSummaries: true }],
    ["unknown action", { actions: { compact: { handler: () => undefined } } }],
    ["unknown field", { actions: { request: { fields: ["focus"], handler: () => undefined } } }],
    ["missing handler", { actions: { status: {} } }],
    ["blank owner", { owner: { name: " ", version: "1" } }],
    ["control characters", { owner: { name: "a\nb", version: "1" } }],
    ["non-boolean branchSummary", { branchSummary: "yes" }],
    ["bad signal", { signal: { aborted: false } }],
  ])("rejects a claim with %s and replies with the reason", (_label, overrides) => {
    const reply = vi.fn();
    const read = readFabricCompactionOwnerMessageV1({
      version: 1, type: "claim", owner, actions: {}, reply, ...overrides,
    });
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reply).toBe(reply);
  });

  it("rejects a claim without a reply callback", () => {
    expect(readFabricCompactionOwnerMessageV1({ version: 1, type: "claim", owner, actions: {} })).toMatchObject({ ok: false });
  });
});

describe("compaction owner claim", () => {
  it("makes Fabric yield compaction to the owner, and withdrawal restores Fabric", async () => {
    const fabric = await loadFabric();
    const session = longSession();
    expect(fabric.compact(compactEvent(session))).toMatchObject({ compaction: { summary: expect.any(String) } });

    const handle = claimed(fabric.send);
    expect(handle.active).toBe(true);
    expect(fabric.compact(compactEvent(session))).toBeUndefined();

    expect(handle.withdraw()).toBe(true);
    expect(handle.active).toBe(false);
    expect(fabric.compact(compactEvent(session))).toMatchObject({ compaction: { summary: expect.any(String) } });
  });

  it("turns off Fabric's threshold deferral under a claim", () => {
    let handler: Handler | undefined;
    let claim: { branchSummary: boolean } | undefined;
    registerCompactionHook({
      on(name: string, candidate: unknown) {
        if (name === "session_before_compact") handler = candidate as Handler;
      },
    } as unknown as ExtensionAPI, {
      getEngine: () => "fabric",
      getThresholdTokens: () => 150_000,
      getThresholdContextRatio: () => 0.9,
      getOwnerClaim: () => claim,
    });
    const context = { model: { provider: "anthropic", id: "sonnet", contextWindow: 200_000 } } as unknown as ExtensionContext;
    const event = { reason: "threshold", preparation: { tokensBefore: 100_000 }, branchEntries: [] };

    expect(handler!(event, context)).toEqual({ cancel: true });
    claim = { branchSummary: false };
    expect(handler!(event, context)).toBeUndefined();
  });

  it("keeps /tree summaries with Fabric unless the owner declares branchSummary", async () => {
    const fabric = await loadFabric();
    const session = longSession();

    const keeper = claimed(fabric.send);
    expect(fabric.tree(treeEvent(session))).toMatchObject({ summary: { summary: expect.any(String) } });
    keeper.withdraw();

    const taker = claimed(fabric.send, { branchSummary: true });
    expect(fabric.tree(treeEvent(session))).toBeUndefined();
    taker.withdraw();
    expect(fabric.tree(treeEvent(session))).toMatchObject({ summary: { summary: expect.any(String) } });
  });

  it("refuses a second claim with a warning naming both owners", async () => {
    const fabric = await loadFabric();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const first = claimed(fabric.send);

    const second = claimMessage({ owner: { name: "other-compactor", version: "0.2.0" } });
    fabric.send(second.message);

    expect(second.result()).toMatchObject({ ok: false, holder: owner });
    const error = (second.result() as { error: string }).error;
    expect(error).toContain("other-compactor@0.2.0");
    expect(error).toContain("pi-context-aware@1.4.0");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("other-compactor@0.2.0"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("pi-context-aware@1.4.0"));
    expect(first.active).toBe(true);
  });

  it("refuses a withdrawal from anyone but the holder", async () => {
    const fabric = await loadFabric();
    const session = longSession();
    const handle = claimed(fabric.send);

    let refused: FabricCompactionOwnerWithdrawResultV1 | undefined;
    fabric.send({ version: 1, type: "withdraw", token: "not-the-token", reply: (value: FabricCompactionOwnerWithdrawResultV1) => { refused = value; } });
    expect(refused).toMatchObject({ ok: false });
    expect(handle.active).toBe(true);
    expect(fabric.compact(compactEvent(session))).toBeUndefined();

    let accepted: FabricCompactionOwnerWithdrawResultV1 | undefined;
    fabric.send({ version: 1, type: "withdraw", token: handle.token, reply: (value: FabricCompactionOwnerWithdrawResultV1) => { accepted = value; } });
    expect(accepted).toEqual({ ok: true });
    expect(handle.active).toBe(false);
  });

  it("offers Fabric's deterministic summary as the owner's fallback", async () => {
    const fabric = await loadFabric();
    const session = longSession();
    const event = compactEvent(session);
    const handle = claimed(fabric.send);

    const fallback = handle.fallback(event, {} as ExtensionContext);
    const withCarry = handle.fallback(event, {} as ExtensionContext, { carry: ["Auth regression is still open"] });
    const invalidCarry = handle.fallback(event, {} as ExtensionContext, { carry: [""] });
    handle.withdraw();
    const fabricOwn = fabric.compact(compactEvent(session)) as { compaction: unknown };

    // Exactly what Fabric's own engine produces for the same event.
    expect(fallback).toEqual({ ok: true, compaction: fabricOwn.compaction });
    expect(fallback).toMatchObject({ ok: true, compaction: { details: { compactor: "fabric" } } });
    expect(withCarry).toMatchObject({ ok: true, compaction: { summary: expect.stringContaining("Auth regression is still open") } });
    expect(invalidCarry).toMatchObject({ ok: false });
    expect(handle.fallback(event, {} as ExtensionContext)).toMatchObject({ ok: false, reason: expect.stringContaining("no longer held") });
  });

  it("clears the claim when Fabric's session shuts down", async () => {
    const fabric = await loadFabric();
    const handle = claimed(fabric.send);
    await fabric.shutdown();
    expect(handle.active).toBe(false);
    expect(fabric.listeners.has(FABRIC_COMPACTION_OWNER_EVENT)).toBe(false);
  });

  it("clears the claim when the owner's signal aborts", async () => {
    const fabric = await loadFabric();
    const session = longSession();
    const lifetime = new AbortController();
    const handle = claimed(fabric.send, { signal: lifetime.signal });
    expect(fabric.compact(compactEvent(session))).toBeUndefined();

    lifetime.abort();
    expect(handle.active).toBe(false);
    expect(fabric.compact(compactEvent(session))).toMatchObject({ compaction: expect.anything() });
    // A new owner can claim once the old one is gone.
    expect(claimed(fabric.send, { owner: { name: "next-owner", version: "1.0.0" } }).active).toBe(true);
  });
});

describe("compact.* under a claim", () => {
  const setup = (actions: FabricCompactionOwnerActionsV1, branchSummary = false) => {
    const controller = new CompactController();
    const appendEntry = vi.fn();
    const registry = new CompactionOwnerRegistry({ warn: vi.fn(), fallback: vi.fn() });
    const provider = new CompactProvider(controller, { appendEntry, owner: () => registry.active });
    const reply = vi.fn();
    registry.claim({ version: 1, type: "claim", owner, actions, ...(branchSummary ? { branchSummary } : {}), reply });
    return { controller, provider, appendEntry, registry };
  };

  it("fails an unsupported field with the owner's name and records nothing", async () => {
    const request = vi.fn();
    const { controller, provider } = setup({ request: { fields: ["instructions"], handler: request } });

    await expect(provider.invoke("request", { instructions: "Keep the plan", seed: "Continue with phase 2" }, invocation()))
      .rejects.toThrow(/pi-context-aware@1\.4\.0.*"seed"/);
    expect(request).not.toHaveBeenCalled();
    expect(controller.status().pending).toBeUndefined();
  });

  it("fails an undeclared carry field with the owner's name and forwards nothing", async () => {
    const carry = vi.fn(() => ({ items: [] }));
    const { provider, appendEntry } = setup({ carry: { fields: ["add"], handler: carry } });

    await expect(provider.invoke("carry", { remove: ["Auth regression is still open"] }, invocation()))
      .rejects.toThrow(/pi-context-aware@1\.4\.0.*"remove"/);
    expect(carry).not.toHaveBeenCalled();
    expect(appendEntry).not.toHaveBeenCalled();
  });

  it("fails an unsupported action with the owner's name and stores no carry entry", async () => {
    const { provider, appendEntry } = setup({});
    const branch = { sessionManager: { getBranch: () => [] } } as unknown as ExtensionContext;

    await expect(provider.invoke("carry", { add: ["Auth regression is still open"] }, invocation(branch)))
      .rejects.toThrow(/pi-context-aware@1\.4\.0.*compact\.carry/);
    await expect(provider.invoke("request", { reason: "pressure" }, invocation(branch)))
      .rejects.toThrow(/pi-context-aware@1\.4\.0.*compact\.request/);
    expect(appendEntry).not.toHaveBeenCalled();
  });

  it("routes request and carry to the owner with only declared fields", async () => {
    const request = vi.fn(() => ({ accepted: true }));
    const carry = vi.fn(() => ({ items: ["Auth regression is still open"] }));
    const { controller, provider, appendEntry } = setup({
      request: { fields: ["instructions", "preserve", "seed"], handler: request },
      carry: { fields: ["add"], handler: carry },
    });

    const preserve = ["tests/auth.test.ts"];
    await expect(provider.invoke("request", { instructions: "Keep the plan", preserve, seed: "Continue" }, invocation()))
      .resolves.toEqual({
        requested: true,
        intent: {
          requestedBy: "model",
          requestedAt: expect.any(Number),
          instructions: "Keep the plan",
          preserve: ["tests/auth.test.ts"],
          seed: "Continue",
        },
        claim: owner,
        result: { accepted: true },
      });
    expect(request).toHaveBeenCalledWith({ instructions: "Keep the plan", preserve: ["tests/auth.test.ts"], seed: "Continue" }, expect.anything());
    expect((request.mock.calls[0] as unknown[])[0]).not.toHaveProperty("requestedBy");
    expect(((request.mock.calls[0] as unknown[])[0] as { preserve: string[] }).preserve).not.toBe(preserve);
    expect(controller.status().pending).toBeUndefined();

    await expect(provider.invoke("carry", { add: ["Auth regression is still open"] }, invocation()))
      .resolves.toEqual({ items: ["Auth regression is still open"], claim: owner });
    expect(carry).toHaveBeenCalledWith({ add: ["Auth regression is still open"] }, expect.anything());
    expect(appendEntry).not.toHaveBeenCalled();
  });

  it("names the owner in status and adds its stage and thresholds to pressure", async () => {
    const { provider } = setup({
      status: { handler: () => ({ stage: "fold" }) },
      pressure: { handler: () => ({ stage: "fold", thresholds: { fold: 0.7, compact: 0.9 }, extra: "dropped" } as never) },
    });
    const host = {
      model: { provider: "anthropic", id: "sonnet", contextWindow: 100_000 },
      getContextUsage: () => ({ tokens: 72_000, contextWindow: 100_000, percent: 72 }),
    } as unknown as ExtensionContext;

    await expect(provider.invoke("status", {}, invocation(host))).resolves.toMatchObject({
      claim: { name: "pi-context-aware", version: "1.4.0", branchSummary: false, actions: ["pressure", "status"] },
      ownerStatus: { stage: "fold" },
    });
    const pressure = await provider.invoke("pressure", {}, invocation(host));
    expect(pressure).toMatchObject({
      band: "warn",
      claim: owner,
      ownerPressure: { stage: "fold", thresholds: { fold: 0.7, compact: 0.9 } },
    });
    expect((pressure as { ownerPressure: object }).ownerPressure).not.toHaveProperty("extra");
  });

  it("leaves status and pressure unchanged without a claim", async () => {
    const provider = new CompactProvider(new CompactController(), { owner: () => undefined });
    expect(await provider.invoke("status", {}, invocation())).not.toHaveProperty("claim");
    expect(await provider.invoke("pressure", {}, invocation())).not.toHaveProperty("claim");
  });
});

// The seed as the model reads it: origin first, then the escaped seed.
const SEED_LABEL = "A Fabric program requested this continuation when it compacted the context. It is not a message from the user.";
const seedContent = (escapedSeed: string) =>
  `${SEED_LABEL}\n<fabric-compaction-seed>\n${escapedSeed}\n</fabric-compaction-seed>`;

describe("compact.request seed", () => {
  it("sends the seed only after the compaction commits", async () => {
    let complete: ((result: never) => void) | undefined;
    let fail: ((error: Error) => void) | undefined;
    const sent: Array<{ message: CompactionSeedMessage; status: string | undefined }> = [];
    const controller: CompactController = new CompactController({
      sendSeed: (message) => sent.push({ message, status: controller.status().last?.status }),
    });
    const context = {
      compact: vi.fn((options: { onComplete: (result: never) => void; onError: (error: Error) => void }) => {
        complete = options.onComplete;
        fail = options.onError;
      }),
    } as unknown as ExtensionContext;
    const provider = new CompactProvider(controller);

    await provider.invoke("request", { reason: "phase done", seed: "Start phase 2: wire the API" }, invocation());
    expect(controller.status().pending?.seed).toBe("Start phase 2: wire the API");
    const committing = controller.maybeCommit(context);
    expect(sent).toEqual([]);
    complete!({ summary: "s", tokensBefore: 10 } as never);
    await committing;
    expect(sent).toEqual([{
      message: {
        customType: "fabric-compaction-seed",
        content: seedContent("Start phase 2: wire the API"),
        display: true,
        details: { version: 1 },
      },
      status: "committed",
    }]);
    expect(controller.status().last).toMatchObject({ status: "committed", seeded: true });

    await provider.invoke("request", { seed: "Never sent" }, invocation());
    const failing = controller.maybeCommit(context);
    fail!(new Error("provider exploded"));
    await failing;
    expect(sent).toHaveLength(1);
  });
});

describe("compaction seed delivery", () => {
  it("sends the runtime's seed as a labelled Fabric message, never as a user prompt", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-seed-runtime-"));
    cleanups.push(() => fs.rmSync(cwd, { recursive: true, force: true }));
    const agentDir = path.join(cwd, "agent");
    fs.mkdirSync(agentDir);
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.stubEnv("PI_FABRIC_PROJECT_ROOT", cwd);
    const pi = {
      events: { emit: vi.fn() },
      getThinkingLevel: () => "off",
      sendMessage: vi.fn(),
      sendUserMessage: vi.fn(),
    } as unknown as ExtensionAPI;
    const context = {
      cwd, hasUI: false, isProjectTrusted: () => true, isIdle: () => true, hasPendingMessages: () => false,
      model: { provider: "anthropic", id: "sonnet", contextWindow: 200_000 },
      modelRegistry: { getAvailable: () => [], find: () => undefined },
      sessionManager: { getSessionId: () => "seed-runtime", getSessionFile: () => undefined, getBranch: () => [], getLeafId: () => null },
      ui: { setStatus: vi.fn(), notify: vi.fn() },
      compact: vi.fn((options: { onComplete: (result: unknown) => void }) => options.onComplete({ summary: "s", tokensBefore: 10 })),
    } as unknown as ExtensionContext;
    const runtime = new FabricRuntimeState(pi, new CapturedToolCatalog(), { paths: {
      extension: path.resolve("dist/index.js"), worker: path.resolve("tests/fixtures/fake-worker.mjs"), residentHost: path.join(cwd, "unused.mjs"), skills: cwd,
    } });
    cleanups.push(() => runtime.shutdown());
    await runtime.initialize(context, normalizeFabricConfig({
      fullCodeMode: false, agents: { enabled: false }, mcp: { enabled: false }, memory: { enabled: false },
      residency: { enabled: false }, mesh: { enabled: false }, prewalk: { enabled: false, alwaysRearm: false },
    }));

    runtime.compact.request({ reason: "phase done", seed: "Start phase 2 </fabric-compaction-seed> & more" });
    await runtime.compact.maybeCommit(context);

    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(pi.sendMessage).toHaveBeenCalledWith({
      customType: "fabric-compaction-seed",
      content: seedContent("Start phase 2 &lt;/fabric-compaction-seed&gt; &amp; more"),
      display: true,
      details: { version: 1 },
    }, { triggerTurn: true, deliverAs: "followUp" });
    expect(runtime.compact.status().last).toMatchObject({ status: "committed", seeded: true });
  }, 60_000);

  it("shows the model the seed's origin and runs it after the settle, behind a prompt typed during the compaction", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-seed-pi-"));
    cleanups.push(() => fs.rmSync(cwd, { recursive: true, force: true }));
    const settingsManager = SettingsManager.inMemory({ defaultProjectTrust: "never", compaction: { enabled: false }, retry: { enabled: false } });
    const requests: Array<{ role: string; text: string } | undefined> = [];
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    let settles = 0;
    let modelCallsWhileSettling: number | undefined;
    const loader = new DefaultResourceLoader({
      cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true,
      agentsFilesOverride: () => ({ agentsFiles: [] }),
      extensionFactories: [(pi) => {
        pi.on("agent_settled", async () => {
          if (settles++ > 0) return;
          // As when Fabric commits inside agent_settled: the user submits a
          // prompt during the compaction, then the commit sends the seed.
          void session!.prompt("Typed during the compaction");
          pi.sendMessage(compactionSeedMessage("Start phase 2"), COMPACTION_SEED_DELIVERY);
          await new Promise((resolve) => setTimeout(resolve, 20));
          modelCallsWhileSettling = requests.length;
        });
        pi.registerProvider("offline-seed", {
          api: "offline-seed", apiKey: "offline", baseUrl: "http://invalid.local",
          models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 2048 }],
          streamSimple(model, llmContext) {
            const last = llmContext.messages.at(-1) as { role: string; content: string | Array<{ type: string; text?: string }> } | undefined;
            requests.push(last && {
              role: last.role,
              text: typeof last.content === "string"
                ? last.content
                : last.content.map((part) => part.type === "text" ? part.text : "").join(""),
            });
            const message: AssistantMessage = {
              role: "assistant", content: [{ type: "text", text: "done" }],
              api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: "stop",
              usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            };
            const stream = createAssistantMessageEventStream();
            stream.push({ type: "start", partial: message });
            stream.push({ type: "done", reason: "stop", message });
            stream.end();
            return stream;
          },
        });
      }],
    });
    await loader.reload();
    const modelRuntime = await ModelRuntime.create({ authPath: path.join(cwd, "auth.json"), modelsPath: null, modelsStorePath: path.join(cwd, "models.json"), refreshOnCreate: false });
    ({ session } = await createAgentSession({ cwd, agentDir: cwd, settingsManager, modelRuntime, resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd) }));
    try {
      await session.bindExtensions({});
      await session.setModel(modelRuntime.getModel("offline-seed", "fixture")!);
      await session.prompt("Finish phase 1");

      // Nothing ran while agent_settled was still being emitted.
      expect(modelCallsWhileSettling).toBe(1);
      expect(requests).toEqual([
        { role: "user", text: "Finish phase 1" },
        { role: "user", text: "Typed during the compaction" },
        { role: "user", text: seedContent("Start phase 2") },
      ]);
    } finally {
      session.dispose();
    }
  }, 30_000);
});

describe("program types", () => {
  it("accept a seed and read the claim fields", () => {
    const result = typeCheckFabricCode(`
const requested = await compact.request({ reason: "phase done", seed: "Start phase 2" });
const status = await compact.status();
const pressure = await compact.pressure();
return { seed: requested.intent.seed, owner: requested.claim?.name, actions: status.claim?.actions, stage: pressure.ownerPressure?.stage };
`, GUEST_TYPE_DECLARATIONS);
    expect(result.errors).toEqual([]);
  });
});

describe("threshold trigger under a claim", () => {
  it("skips Fabric's settled-boundary trigger while a claim is held", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-claim-"));
    cleanups.push(() => fs.rmSync(cwd, { recursive: true, force: true }));
    const agentDir = path.join(cwd, "agent");
    fs.mkdirSync(agentDir);
    fs.mkdirSync(path.join(cwd, ".pi"));
    fs.writeFileSync(path.join(cwd, ".pi", "fabric.json"), JSON.stringify({
      compaction: { outputReserveTokens: 10_000 }, prewalk: { alwaysRearm: false }, mesh: { enabled: false }, components: [],
    }));
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    for (const key of ["PI_FABRIC_PARENT_RUN", "PI_FABRIC_ACTOR_ID", "PI_FABRIC_DEPTH", "PI_FABRIC_CAPABILITY_REQUIREMENTS", "PI_FABRIC_CAPABILITY_DIGEST"]) {
      vi.stubEnv(key, undefined);
    }
    const fabric = await loadFabric();
    const context = {
      cwd,
      hasUI: false,
      isProjectTrusted: () => true,
      model: { provider: "anthropic", id: "sonnet", contextWindow: 100_000 },
      getContextUsage: () => ({ tokens: 95_000, contextWindow: 100_000, percent: 95 }),
      compact: vi.fn((options?: { onComplete?: (result: never) => void }) => options?.onComplete?.({} as never)),
      sessionManager: { getSessionId: () => cwd, getBranch: () => [], getSessionFile: () => undefined, getLeafId: () => undefined },
      ui: { setStatus: vi.fn(), notify: vi.fn() },
    } as unknown as ExtensionContext;
    await fabric.emit("session_start", { type: "session_start" }, context);

    const handle = claimed(fabric.send);
    await fabric.emit("agent_settled", { type: "agent_settled" }, context);
    expect(context.compact).not.toHaveBeenCalled();

    handle.withdraw();
    await fabric.emit("agent_settled", { type: "agent_settled" }, context);
    expect(context.compact).toHaveBeenCalledOnce();
  }, 60_000);
});
