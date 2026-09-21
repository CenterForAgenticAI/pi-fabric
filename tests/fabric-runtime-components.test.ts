import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { CapturedToolCatalog } from "../src/capture/catalog.js";
import { normalizeFabricConfig } from "../src/config.js";
import type { FabricExecutionResult } from "../src/execution-service.js";
import { FabricRuntimeState } from "../src/fabric-runtime-state.js";
import { getActiveRepairCompiler } from "../src/repairs/active.js";
import { catalogDigestFromSurface } from "../src/repairs/catalog-digest.js";
import {
  FABRIC_COMPONENT_DISCOVER_EVENT,
  FABRIC_PROVIDER_DISCOVER_EVENT,
  type FabricComponentDiscovery,
  type FabricProviderDiscovery,
} from "../src/protocol.js";

describe("Fabric runtime provider components", () => {
  it("activates every enabled built-in component before execution and discovery", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-runtime-components-"));
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    vi.stubEnv("PI_CODING_AGENT_DIR", path.join(cwd, "agent"));
    vi.stubEnv("PI_FABRIC_PROJECT_ROOT", cwd);

    let runtime!: FabricRuntimeState;
    const discoverySnapshots: Array<{ initialized: boolean; active: string[] }> = [];
    let componentDiscovery: FabricComponentDiscovery | undefined;
    const pi = {
      events: {
        emit: vi.fn((event: string, payload: unknown) => {
          if (event === FABRIC_COMPONENT_DISCOVER_EVENT) {
            componentDiscovery = payload as FabricComponentDiscovery;
            componentDiscovery.register({
              name: "guidance-only",
              guarantee: "revertible",
              activate(component) {
                component.guide({
                  label: "deepseek-profile",
                  models: ["deepseek/*"],
                  content: "Use the DeepSeek profile.",
                });
              },
            });
          }
          if (event === FABRIC_PROVIDER_DISCOVER_EVENT) {
            discoverySnapshots.push({
              initialized: runtime.initialized,
              active: runtime.componentGraph().components
                .filter((component) => component.state === "active")
                .map((component) => component.id)
                .sort(),
            });
            (payload as FabricProviderDiscovery).register({
              name: "external",
              description: "External provider",
              async list() { return []; },
              async describe() { return undefined; },
              async invoke() { return undefined; },
            });
          }
        }),
      },
      getThinkingLevel: vi.fn(() => "off"),
      sendMessage: vi.fn(),
    } as unknown as ExtensionAPI;
    const context = {
      cwd,
      hasUI: false,
      isProjectTrusted: () => true,
      isIdle: () => true,
      hasPendingMessages: () => false,
      modelRegistry: {
        find: vi.fn(),
        getApiKeyAndHeaders: vi.fn(),
      },
      sessionManager: {
        getSessionId: () => "runtime-components-session",
        getSessionFile: () => undefined,
        getBranch: () => [],
        getLeafId: () => undefined,
      },
      ui: {
        setStatus: vi.fn(),
        notify: vi.fn(),
      },
    } as unknown as ExtensionContext;
    const config = normalizeFabricConfig({
      fullCodeMode: true,
      capture: { enabled: true },
      components: [{ id: "guidance-only", component: "guidance-only" }],
      mcp: { enabled: false, cache: { enabled: false } },
      mesh: { enabled: true },
      memory: { enabled: true },
      agents: { enabled: false },
      residency: { enabled: false },
      prewalk: { enabled: false, alwaysRearm: false },
    });
    const fixture = path.join(cwd, "unused.mjs");
    fs.writeFileSync(fixture, "export default {};");
    runtime = new FabricRuntimeState(pi, new CapturedToolCatalog(), {
      paths: {
        extension: fixture,
        worker: fixture,
        residentHost: fixture,
        skills: cwd,
      },
    });

    try {
      await runtime.initialize(context, config);

      expect(getActiveRepairCompiler()).toBe(runtime.repairs);
      expect(runtime.repairs.catalogDigest).toBe(catalogDigestFromSurface({
        providers: runtime.registry.providers().map((provider) => provider.name),
        capturedTools: [],
      }));
      expect(runtime.registry.providers().map((provider) => provider.name)).toContain("external");
      expect(discoverySnapshots).toEqual([{
        initialized: true,
        active: [
          "fabric.provider.agents",
          "fabric.provider.compact",
          "fabric.provider.extensions",
          "fabric.provider.jev",
          "fabric.provider.mcp",
          "fabric.provider.memory",
          "fabric.provider.mesh",
          "fabric.provider.pi",
          "fabric.provider.prewalk",
          "fabric.provider.schema",
          "fabric.provider.state",
        ],
      }]);
      const discovery = componentDiscovery;
      if (!discovery) throw new Error("Expected component discovery");
      expect(() => discovery.register({
        name: "fabric.provider.mcp",
        activate() {},
      }, { overwrite: true })).toThrow(
        "Reserved Fabric component name: fabric.provider.mcp",
      );
      const builtins = runtime.componentGraph().components.filter((component) =>
        component.id.startsWith("fabric.provider.")
      );
      expect(builtins).toEqual(
        expect.arrayContaining([
          ...[
            "pi",
            "extensions",
            "mcp",
            "mesh",
            "state",
            "schema",
            "compact",
            "prewalk",
            "agents",
            "memory",
            "jev",
          ].map((name) => expect.objectContaining({
            id: `fabric.provider.${name}`,
            state: "active",
          })),
        ]),
      );
      expect(builtins.flatMap((component) =>
        component.effects?.flatMap((effect) => effect.resources) ?? []
      )).not.toContain("*");
      expect(builtins.find((component) => component.id === "fabric.provider.mcp")?.effects).toEqual([{
        label: "provider-component:mcp:holder",
        kind: "transactional",
        resources: ["fabric:provider:mcp:holder"],
        ordering: "ordered",
      }]);

      const guidance = runtime.componentGraph().components.find((component) =>
        component.id === "guidance-only"
      );
      expect(guidance).toMatchObject({ state: "active" });
      expect(guidance?.effectConflicts).toBeUndefined();
      expect(runtime.modelGuidance()).toContainEqual(
        expect.objectContaining({
          componentId: "guidance-only",
          label: "deepseek-profile",
        }),
      );
      const invocation = {
        cwd, signal: undefined, parentToolCallId: "jev-reload-test", nestedToolCallId: "jev-reload-test",
        extensionContext: context, update() {}, approve: async () => {}, audits: [], maxResultChars: 32_768,
      };
      const spawned = await runtime.registry.invoke("jev.spawn", {
        program: { name: "self-pinned-loop", code: "while (true) await program.sleep(10);", requires: ["jev.evaluate"], inputSchema: {}, outputSchema: {} }, input: null,
      }, invocation) as { id: string };
      const joined = runtime.registry.invoke("jev.join", { id: spawned.id }, invocation);
      await new Promise(resolve => setTimeout(resolve, 20));
      await runtime.registry.invoke("components.reload", { id: "fabric.provider.jev" }, invocation);
      expect(await joined).toMatchObject({ state: "cancelled" });
      expect(runtime.componentGraph().components.find(c => c.id === "fabric.provider.jev")?.state).toBe("active");
    } finally {
      await runtime.shutdown();
      expect(getActiveRepairCompiler()).toBeUndefined();
      vi.unstubAllEnvs();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("initializes schema enforce mode without expecting the private extensions provider (#114)", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-runtime-enforce-"));
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    vi.stubEnv("PI_CODING_AGENT_DIR", path.join(cwd, "agent"));
    vi.stubEnv("PI_FABRIC_PROJECT_ROOT", cwd);

    const pi = {
      events: { emit: vi.fn() },
      getThinkingLevel: vi.fn(() => "off"),
      sendMessage: vi.fn(),
    } as unknown as ExtensionAPI;
    const context = {
      cwd,
      hasUI: false,
      isProjectTrusted: () => true,
      isIdle: () => true,
      hasPendingMessages: () => false,
      modelRegistry: { find: vi.fn(), getApiKeyAndHeaders: vi.fn() },
      sessionManager: {
        getSessionId: () => "runtime-enforce-session",
        getSessionFile: () => undefined,
        getBranch: () => [],
        getLeafId: () => undefined,
      },
      ui: { setStatus: vi.fn(), notify: vi.fn() },
    } as unknown as ExtensionContext;
    const config = normalizeFabricConfig({
      schema: { mode: "enforce" },
      capture: { enabled: false },
      mcp: { enabled: false, cache: { enabled: false } },
      mesh: { enabled: false },
      memory: { enabled: false },
      agents: { enabled: false },
      residency: { enabled: false },
      prewalk: { enabled: false, alwaysRearm: false },
    });
    const fixture = path.join(cwd, "unused.mjs");
    fs.writeFileSync(fixture, "export default {};");
    const runtime = new FabricRuntimeState(pi, new CapturedToolCatalog(), {
      paths: {
        extension: fixture,
        worker: fixture,
        residentHost: fixture,
        skills: cwd,
      },
    });

    try {
      await expect(runtime.initialize(context, config)).resolves.toBeUndefined();
      expect(runtime.registry.providers().map((provider) => provider.name)).toContain("pi");
      expect(runtime.registry.providers().map((provider) => provider.name)).not.toContain(
        "extensions",
      );
    } finally {
      await runtime.shutdown();
      vi.unstubAllEnvs();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("freezes repair surfaces across capture suspension and reload", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-runtime-repairs-"));
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    vi.stubEnv("PI_CODING_AGENT_DIR", path.join(cwd, "agent"));
    vi.stubEnv("PI_FABRIC_PROJECT_ROOT", cwd);

    const pi = {
      events: { emit: vi.fn() },
      getThinkingLevel: vi.fn(() => "off"),
      sendMessage: vi.fn(),
    } as unknown as ExtensionAPI;
    const context = {
      cwd,
      hasUI: false,
      isProjectTrusted: () => true,
      isIdle: () => true,
      hasPendingMessages: () => false,
      modelRegistry: { find: vi.fn(), getApiKeyAndHeaders: vi.fn() },
      sessionManager: {
        getSessionId: () => "runtime-repairs-session",
        getSessionFile: () => undefined,
        getBranch: () => [],
        getLeafId: () => undefined,
      },
      ui: { setStatus: vi.fn(), notify: vi.fn() },
    } as unknown as ExtensionContext;
    const capturedTools = new CapturedToolCatalog();
    const config = normalizeFabricConfig({
      fullCodeMode: true,
      capture: { enabled: true },
      mcp: { enabled: false, cache: { enabled: false } },
      mesh: { enabled: true },
      memory: { enabled: true },
      agents: { enabled: false },
      residency: { enabled: false },
      prewalk: { enabled: false, alwaysRearm: false },
    });
    const fixture = path.join(cwd, "unused.mjs");
    fs.writeFileSync(fixture, "export default {};");
    const runtime = new FabricRuntimeState(pi, capturedTools, {
      paths: {
        extension: fixture,
        worker: fixture,
        residentHost: fixture,
        skills: cwd,
      },
    });
    const tableFile = (): string =>
      path.join(cwd, "agent", "fabric", "repairs", "current.json");

    try {
      await runtime.initialize(context, config);
      const before = runtime.repairs;
      const digest = before.catalogDigest;
      expect(getActiveRepairCompiler()).toBe(before);

      // Suspension clears the catalog transiently (the interceptor setPolicy
      // path): the repair surface must not flip to the empty-catalog digest
      // that promotion could then persist over the stable table.
      capturedTools.markSuspended();
      capturedTools.clear();
      expect(getActiveRepairCompiler()).toBe(before);
      expect(before.catalogDigest).toBe(digest);

      // Reload while suspended: the replacement compiler activates with an
      // uncommitted surface and must refuse to persist anything.
      await runtime.initialize(context, config);
      const reloaded = runtime.repairs;
      expect(reloaded).not.toBe(before);
      expect(getActiveRepairCompiler()).toBe(reloaded);
      expect(reloaded.catalogDigest).toBe("");
      expect(
        reloaded.observeInvalidArgs("memory.recall", { sessionId: "s1" }, ["session"], "extra"),
      ).toBeUndefined();
      expect(fs.existsSync(tableFile())).toBe(false);

      // Re-arm: the stable surface re-commits and promotion resumes.
      capturedTools.markResumed();
      capturedTools.clear();
      expect(reloaded.catalogDigest).toBe(digest);
      expect(
        reloaded.observeInvalidArgs("memory.recall", { sessionId: "s1" }, ["session"], "extra"),
      ).toEqual({
        kind: "keyAlias",
        ref: "memory.recall",
        from: "sessionId",
        to: "session",
      });
      await reloaded.flush();
      expect(fs.existsSync(tableFile())).toBe(true);
    } finally {
      await runtime.shutdown();
      expect(getActiveRepairCompiler()).toBeUndefined();
      vi.unstubAllEnvs();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// The runtime is the component that decides, so the checkpoint contract is
// pinned here as well as at the claim helpers: a gated boundary delivers the
// plan message, starts no handoff, and leaves the arm armed for the next one.
describe("Fabric runtime prewalk plan checkpoint", () => {
  it.each([false, true])("consumes the audited checkpoint window (shell read before plan=%s)", async (readBeforePlan) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-prewalk-gate-"));
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    vi.stubEnv("PI_CODING_AGENT_DIR", path.join(cwd, "agent"));
    vi.stubEnv("PI_FABRIC_PROJECT_ROOT", cwd);

    const pi = {
      events: { emit: vi.fn() },
      getThinkingLevel: vi.fn(() => "off"),
      sendMessage: vi.fn(),
    } as unknown as ExtensionAPI;
    const context = {
      cwd,
      hasUI: false,
      isProjectTrusted: () => true,
      isIdle: () => true,
      hasPendingMessages: () => false,
      modelRegistry: { find: vi.fn(), getApiKeyAndHeaders: vi.fn() },
      sessionManager: {
        getSessionId: () => "runtime-prewalk-gate",
        getSessionFile: () => undefined,
        getBranch: () => [],
        getLeafId: () => undefined,
      },
      ui: { setStatus: vi.fn(), notify: vi.fn() },
    } as unknown as ExtensionContext;
    const config = normalizeFabricConfig({
      fullCodeMode: true,
      capture: { enabled: false },
      mcp: { enabled: false, cache: { enabled: false } },
      mesh: { enabled: false },
      memory: { enabled: false },
      agents: { enabled: false },
      residency: { enabled: false },
      prewalk: { enabled: true, mode: "in-place", model: "anthropic/executor", requirePlan: true },
    });
    const fixture = path.join(cwd, "unused.mjs");
    fs.writeFileSync(fixture, "export default {};");
    const runtime = new FabricRuntimeState(pi, new CapturedToolCatalog(), {
      paths: { extension: fixture, worker: fixture, residentHost: fixture, skills: cwd },
    });
    try {
    await runtime.initialize(context, config);
    runtime.prewalk.arm({
      model: "anthropic/executor",
      sessionId: "session-1",
      requirePlan: true,
    });
    const file = path.join(cwd, "app.ts");
    fs.writeFileSync(file, "before");
    await runtime.prewalkDrift.captureBaseline("session-1", cwd);
    fs.writeFileSync(file, "after: audited edit");
    const execution = {
      success: true,
      value: "outer result",
      logs: [],
      audits: [
        { ref: "pi.edit", nestedToolCallId: "edit-1", startedAt: 1, endedAt: 2, success: true },
      ],
      phases: [],
    } as unknown as FabricExecutionResult;

    const pending = await runtime.claimHandoff(execution, "session-1", "auto", "call-1");

    expect(pending).toBeUndefined();
    expect(runtime.prewalk.status()).toMatchObject({ state: "armed" });
    expect(pi.sendMessage).toHaveBeenCalledOnce();
    const [message, options] = (pi.sendMessage as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    expect(message).toMatchObject({ customType: "pi-fabric-prewalk-plan", display: false });
    expect(options).toEqual({ deliverAs: "steer", triggerTurn: true });

    // Delivery is not readiness: the arm still owes a recorded plan, so the
    // boundary keeps withholding until prewalk.plan supplies one (the claim
    // itself is covered in tests/prewalk-handoff.test.ts).
    expect(runtime.prewalk.planCheckpointRequired("session-1")).toBe(true);
    const shell = (): FabricExecutionResult => ({
      ...execution, audits: [{ ref: "pi.bash", nestedToolCallId: "shell", startedAt: 3, endedAt: 4, success: true }],
    });
    runtime.activity.start("shell-read");
    if (readBeforePlan) {
      expect(await runtime.claimHandoff(shell(), "session-1", "auto", "shell-read")).toBeUndefined();
      expect(runtime.prewalk.planState("session-1").prompts).toBe(1);
    }
    runtime.prewalk.submitPlan("session-1", {
      outcome: "Finish the task", steps: ["Check app.ts"], verification: ["Read app.ts"], risks: "None",
    });
    expect(await runtime.claimHandoff(shell(), "session-1", "auto", "shell-read")).toBeUndefined();
    fs.writeFileSync(file, "after: genuine new shell write");
    runtime.activity.start("shell-write");
    expect(await runtime.claimHandoff(shell(), "session-1", "auto", "shell-write")).toMatchObject({
      kind: "prewalk-in-place", triggerRef: "fs.drift", triggerFiles: ["app.ts"],
    });
    await runtime.initialize(context, config);
    expect(runtime.prewalk.status().state).toBe("idle");
    runtime.prewalk.arm({ model: "anthropic/executor", sessionId: "session-1", requirePlan: true });
    expect(runtime.prewalk.planState("session-1")).toEqual({ required: true, ready: false, prompts: 0 });
    } finally {
      await runtime.shutdown();
      vi.unstubAllEnvs();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
