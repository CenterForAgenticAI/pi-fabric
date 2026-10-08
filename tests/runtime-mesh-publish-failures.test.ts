import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CapturedToolCatalog } from "../src/capture/catalog.js";
import { normalizeFabricConfig } from "../src/config.js";
import { FabricRuntimeState } from "../src/fabric-runtime-state.js";
import { LifecycleBroker } from "../src/lifecycle/broker.js";
import type { FabricLifecyclePublishRequest } from "../src/lifecycle/types.js";
import { MeshStore } from "../src/mesh/store.js";
import {
  FABRIC_COMPONENT_DISCOVER_EVENT,
  type FabricComponentDiscovery,
  type FabricProvider,
} from "../src/protocol.js";

// Best-effort mesh publications from the host runtime must never surface as
// unhandled rejections, and a failed component transition must not be
// remembered as published.

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const WAITING_COMPONENT = "needs-absent";

const startRuntime = async (): Promise<{
  runtime: FabricRuntimeState;
  context: ExtensionContext;
}> => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-mesh-publish-"));
  roots.push(cwd);
  fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  vi.stubEnv("PI_CODING_AGENT_DIR", path.join(cwd, "agent"));
  vi.stubEnv("PI_FABRIC_PROJECT_ROOT", cwd);
  const pi = {
    events: {
      emit: vi.fn((event: string, payload: unknown) => {
        if (event !== FABRIC_COMPONENT_DISCOVER_EVENT) return;
        // Requires a capability nobody provides, so it stays "waiting" and
        // re-reports the same state on every provider change.
        (payload as FabricComponentDiscovery).register({
          name: WAITING_COMPONENT,
          requires: ["alpha.cap", "absent.capability"],
          activate() {},
        });
      }),
    },
    getThinkingLevel: vi.fn(() => "off"),
    sendMessage: vi.fn(),
    appendEntry: vi.fn(),
  } as unknown as ExtensionAPI;
  const context = {
    cwd,
    hasUI: false,
    isProjectTrusted: () => true,
    isIdle: () => true,
    hasPendingMessages: () => false,
    modelRegistry: { find: vi.fn(), getApiKeyAndHeaders: vi.fn() },
    sessionManager: {
      getSessionId: () => "mesh-publish-failures-session",
      getSessionFile: () => undefined,
      getBranch: () => [],
      getLeafId: () => undefined,
    },
    ui: { setStatus: vi.fn(), notify: vi.fn() },
  } as unknown as ExtensionContext;
  const config = normalizeFabricConfig({
    capture: { enabled: false },
    components: [{ id: WAITING_COMPONENT, component: WAITING_COMPONENT }],
    mcp: { enabled: false, cache: { enabled: false } },
    mesh: { enabled: true },
    memory: { enabled: false },
    agents: { enabled: false },
    residency: { enabled: false },
    prewalk: { enabled: false, alwaysRearm: false },
    approvals: { read: "allow", write: "allow" },
  });
  const fixture = path.join(cwd, "unused.mjs");
  fs.writeFileSync(fixture, "export default {};");
  const runtime = new FabricRuntimeState(pi, new CapturedToolCatalog(), {
    paths: { extension: fixture, worker: fixture, residentHost: fixture, skills: cwd },
  });
  await runtime.initialize(context, config);
  return { runtime, context };
};

const provider = (name: string, actions: readonly string[] = []): FabricProvider => {
  const descriptors = actions.map((action) => ({
    name: action,
    description: `${name}.${action}`,
    inputSchema: { type: "object", additionalProperties: false },
    risk: "read" as const,
  }));
  return {
    name,
    description: `Test provider ${name}`,
    async list() { return descriptors; },
    async describe(action) { return descriptors.find((descriptor) => descriptor.name === action); },
    async invoke() { return undefined; },
  };
};

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50));

describe("Fabric runtime best-effort mesh publications", () => {
  it("handles a rejected compaction publish without an unhandled rejection and reports it", async () => {
    const failure = new Error("mesh event log is full");
    // A plain patch rather than vi.spyOn: a spy observes the returned promise,
    // which would mark the rejection handled and hide the defect.
    const original = MeshStore.prototype.publish;
    const topics: string[] = [];
    MeshStore.prototype.publish = function (this: MeshStore, input) {
      topics.push(input.topic);
      if (input.topic === "fabric.compact") return Promise.reject(failure);
      return original.call(this, input);
    };
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { runtime, context } = await startRuntime();
    try {
      await runtime.registry.invoke("compact.request", { reason: "test" }, {
        cwd: context.cwd,
        signal: undefined,
        parentToolCallId: "compact-request",
        nestedToolCallId: "compact-request",
        extensionContext: context,
        update() {},
        approve: async () => {},
        audits: [],
        maxResultChars: 32_768,
      });
      expect(topics).toContain("fabric.compact");
      await settle();
      expect(unhandled).not.toContain(failure);
      expect(warn.mock.calls.some((args) =>
        args.some((arg) => typeof arg === "string" && arg.includes("fabric.compact") &&
          arg.includes("mesh event log is full")),
      )).toBe(true);
    } finally {
      await runtime.shutdown();
      process.off("unhandledRejection", onUnhandled);
      MeshStore.prototype.publish = original;
    }
  });

  it("does not remember a failed component transition and republishes it on the next report", async () => {
    const original = LifecycleBroker.prototype.publish;
    let armed = false;
    let failed = false;
    const waitingPublications: string[] = [];
    vi.spyOn(LifecycleBroker.prototype, "publish").mockImplementation(
      function (this: LifecycleBroker, request: FabricLifecyclePublishRequest) {
        const data = request.data as Record<string, unknown> | undefined;
        if (armed && request.event === "component.state" && data?.id === WAITING_COMPONENT) {
          waitingPublications.push(String(data.state));
          if (!failed && data.state === "waiting") {
            failed = true;
            return Promise.reject(new Error("mesh lock timed out"));
          }
        }
        return original.call(this, request);
      },
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { runtime } = await startRuntime();
    try {
      await runtime.components.settle();
      expect(runtime.components.status(WAITING_COMPONENT)).toMatchObject({
        state: "waiting",
        missing: expect.arrayContaining(["alpha.cap", "absent.capability"]),
      });
      armed = true;

      // A real transition: one requirement appears, the component stays
      // waiting on the other, and that publication fails.
      runtime.registerExternal(provider("alpha", ["cap"]));
      await vi.waitFor(() => expect(failed).toBe(true), { timeout: 10_000 });
      await runtime.components.settle();
      await settle();
      expect(runtime.components.status(WAITING_COMPONENT)).toMatchObject({
        state: "waiting",
        missing: ["absent.capability"],
      });
      expect(waitingPublications).toEqual(["waiting"]);
      expect(warn.mock.calls.some((args) =>
        args.some((arg) => typeof arg === "string" && arg.includes(WAITING_COMPONENT) &&
          arg.includes("mesh lock timed out")),
      )).toBe(true);

      // The next provider change re-reports the same state: the failed
      // transition is published this time.
      runtime.registerExternal(provider("first-tick"));
      await vi.waitFor(
        () => expect(waitingPublications).toEqual(["waiting", "waiting"]),
        { timeout: 10_000 },
      );
      await runtime.components.settle();
      await settle();

      // Once published, the unchanged state is not published again.
      runtime.registerExternal(provider("second-tick"));
      await runtime.components.settle();
      await settle();
      expect(waitingPublications).toEqual(["waiting", "waiting"]);
    } finally {
      await runtime.shutdown();
    }
  });
});
