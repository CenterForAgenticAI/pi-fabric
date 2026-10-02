import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { ActionRegistry } from "../src/core/action-registry.js";
import { FabricHostPolicy } from "../src/core/host-policy.js";
import piFabric from "../src/index.js";
import {
  FABRIC_HOST_POLICY_EVENT,
  readFabricHostPolicyRequestV1,
  type FabricActionDescriptor,
  type FabricHostPolicyAckV1,
  type FabricInvocationContext,
  type FabricProvider,
  type FabricRisk,
} from "../src/protocol.js";

const context: FabricInvocationContext = {
  cwd: process.cwd(),
  signal: undefined,
  parentToolCallId: "parent",
  nestedToolCallId: "nested",
  extensionContext: {} as ExtensionContext,
  update() {},
};

const provider = (name: string, actions: Record<string, FabricRisk>, invoked: string[]): FabricProvider => ({
  name,
  description: name,
  async list() { return []; },
  async describe(action): Promise<FabricActionDescriptor | undefined> {
    const risk = actions[action];
    return risk
      ? { name: action, description: action, inputSchema: { type: "object", additionalProperties: false }, risk }
      : undefined;
  },
  async invoke(action) {
    invoked.push(`${name}.${action}`);
    return "ran";
  },
});

const invoke = (registry: ActionRegistry, ref: string): Promise<unknown> =>
  registry.invoke(ref, {}, { ...context, approve: async () => {}, audits: [], maxResultChars: 10_000 });

const workerPolicy = {
  owner: "pi-delegate",
  reason: "read-only worker",
  deniedTools: ["write", "edit", "delegate"],
};

describe("host policy request", () => {
  const reply = () => undefined;

  it("accepts a well-formed policy and copies only named fields", () => {
    const request = readFabricHostPolicyRequestV1({
      policy: { ...workerPolicy, allowedUnhookedRisks: ["read"], smuggled: true },
      reply,
      extra: 1,
    });
    expect(request?.policy).toEqual({ ...workerPolicy, allowedUnhookedRisks: ["read"] });
  });

  it("rejects malformed policies instead of partially applying them", () => {
    expect(readFabricHostPolicyRequestV1({ policy: workerPolicy })).toBeUndefined();
    expect(readFabricHostPolicyRequestV1({ policy: { ...workerPolicy, owner: "" }, reply })).toBeUndefined();
    expect(readFabricHostPolicyRequestV1({ policy: { ...workerPolicy, reason: 1 }, reply })).toBeUndefined();
    expect(readFabricHostPolicyRequestV1({ policy: { ...workerPolicy, deniedTools: "write" }, reply })).toBeUndefined();
    expect(readFabricHostPolicyRequestV1({ policy: { ...workerPolicy, deniedProviders: [""] }, reply })).toBeUndefined();
    expect(readFabricHostPolicyRequestV1({ policy: { ...workerPolicy, allowedUnhookedRisks: ["root"] }, reply })).toBeUndefined();
    expect(readFabricHostPolicyRequestV1({
      policy: { ...workerPolicy, deniedTools: Array.from({ length: 257 }, (_, i) => `t${i}`) },
      reply,
    })).toBeUndefined();
  });
});

describe("FabricHostPolicy", () => {
  it("is inactive and allows everything until a policy is applied", () => {
    const policy = new FabricHostPolicy();
    expect(policy.active).toBe(false);
    expect(policy.denial({ ref: "agents.run", provider: "agents", name: "run", risk: "agent" })).toBeUndefined();
    expect(policy.executorDenial()).toBeUndefined();
  });

  it("denies named tools, denied providers, and unhooked non-read risks", () => {
    const policy = new FabricHostPolicy();
    policy.apply({ ...workerPolicy, deniedProviders: ["mesh"] });
    expect(policy.denial({ ref: "pi.write", provider: "pi", name: "write", risk: "write" })).toContain("tool write");
    expect(policy.denial({ ref: "extensions.delegate", provider: "extensions", name: "delegate", risk: "execute" })).toContain("tool delegate");
    // Hooked providers keep their non-read tools: Pi tool_call hooks still guard them.
    expect(policy.denial({ ref: "pi.bash", provider: "pi", name: "bash", risk: "execute" })).toBeUndefined();
    expect(policy.denial({ ref: "mesh.peers", provider: "mesh", name: "peers", risk: "read" })).toContain("provider mesh");
    expect(policy.denial({ ref: "agents.run", provider: "agents", name: "run", risk: "agent" })).toContain("agent actions");
    expect(policy.denial({ ref: "memory.recall", provider: "memory", name: "recall", risk: "read" })).toBeUndefined();
    expect(policy.executorDenial()).toContain("refuses native executors");
  });

  it("only narrows when a later policy is applied", () => {
    const policy = new FabricHostPolicy();
    policy.apply({ owner: "a", reason: "first" });
    policy.apply({ owner: "b", reason: "second", allowedUnhookedRisks: ["read", "agent"] });
    expect(policy.denial({ ref: "agents.run", provider: "agents", name: "run", risk: "agent" })).toContain("from a");
  });

  it("keeps its own copy of the applied policy", () => {
    const policy = new FabricHostPolicy();
    const input = { owner: "a", reason: "r", deniedTools: ["write"] };
    policy.apply(input);
    input.deniedTools.length = 0;
    expect(policy.denial({ ref: "pi.write", provider: "pi", name: "write", risk: "write" })).toBeDefined();
  });
});

describe("registry enforcement", () => {
  it("refuses a denied action before its provider runs and allows the rest", async () => {
    const invoked: string[] = [];
    const registry = new ActionRegistry();
    registry.register(provider("agents", { run: "agent", list: "read" }, invoked));
    registry.register(provider("pi", { write: "write", bash: "execute" }, invoked));
    const policy = new FabricHostPolicy();
    registry.setHostPolicy(policy);
    expect(await invoke(registry, "agents.run")).toBe("ran");

    policy.apply(workerPolicy);
    await expect(invoke(registry, "agents.run")).rejects.toThrow("refused by the Fabric host policy from pi-delegate");
    await expect(invoke(registry, "pi.write")).rejects.toThrow("tool write is unavailable here");
    expect(await invoke(registry, "agents.list")).toBe("ran");
    expect(await invoke(registry, "pi.bash")).toBe("ran");
    expect(invoked).toEqual(["agents.run", "agents.list", "pi.bash"]);
    await registry.close(new Set(["agents", "pi"]));
  });

  it("goes red when the registry has no policy attached", async () => {
    const invoked: string[] = [];
    const registry = new ActionRegistry();
    registry.register(provider("agents", { run: "agent" }, invoked));
    const policy = new FabricHostPolicy();
    policy.apply(workerPolicy);
    registry.setHostPolicy(undefined);
    expect(await invoke(registry, "agents.run")).toBe("ran");
    registry.setHostPolicy(policy);
    await expect(invoke(registry, "agents.run")).rejects.toThrow();
    expect(invoked).toEqual(["agents.run"]);
    await registry.close(new Set(["agents"]));
  });
});

describe("host policy event", () => {
  it("acknowledges synchronously after the policy is in force and unsubscribes on shutdown", async () => {
    const listeners = new Map<string, (value: unknown) => unknown>();
    const handlers = new Map<string, Array<(...args: never[]) => unknown>>();
    const pi = {
      events: {
        emit: vi.fn(),
        on: vi.fn((channel: string, handler: (value: unknown) => unknown) => {
          listeners.set(channel, handler);
          return () => listeners.delete(channel);
        }),
      },
      getActiveTools: vi.fn(() => ["fabric_exec"]),
      getAllTools: vi.fn(() => [{ name: "fabric_exec" }]),
      on: vi.fn((event: string, handler: (...args: never[]) => unknown) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      }),
      registerCommand: vi.fn(),
      registerMessageRenderer: vi.fn(),
      registerTool: vi.fn(),
      setActiveTools: vi.fn(),
    } as unknown as ExtensionAPI;
    await piFabric(pi);
    const request = listeners.get(FABRIC_HOST_POLICY_EVENT)!;
    let ack: FabricHostPolicyAckV1 | undefined;
    request({ policy: workerPolicy, reply: (value: FabricHostPolicyAckV1) => { ack = value; } });
    expect(ack).toEqual({ version: 1, accepted: true });
    expect(() => request({ policy: { owner: "x" }, reply: () => undefined })).toThrow("Invalid Pi Fabric host policy request");
    for (const shutdown of handlers.get("session_shutdown") ?? []) await shutdown();
    expect(listeners.has(FABRIC_HOST_POLICY_EVENT)).toBe(false);
  });
});
