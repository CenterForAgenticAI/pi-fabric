import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CapturedToolCatalog } from "../src/capture/catalog.js";
import { normalizeFabricConfig } from "../src/config.js";
import { FabricRuntimeState } from "../src/fabric-runtime-state.js";
import { SESSION_LABEL_STATUS_KEY } from "../src/topology/session-label.js";

// The runtime decides which sessions show a Fabric label: a root session
// shows its own, a child launched by Fabric shows none, and shutdown clears it.

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const startRuntime = async (
  sessionLabel: Record<string, unknown> = {},
): Promise<{ runtime: FabricRuntimeState; setStatus: ReturnType<typeof vi.fn> }> => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-session-label-"));
  roots.push(cwd);
  fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  vi.stubEnv("PI_CODING_AGENT_DIR", path.join(cwd, "agent"));
  vi.stubEnv("PI_FABRIC_PROJECT_ROOT", cwd);
  // Keep a developer's Herdr session out of the test.
  vi.stubEnv("HERDR_ENV", "");
  const pi = {
    events: { emit: vi.fn() },
    getThinkingLevel: vi.fn(() => "off"),
    sendMessage: vi.fn(),
    appendEntry: vi.fn(),
  } as unknown as ExtensionAPI;
  const setStatus = vi.fn();
  const context = {
    cwd,
    hasUI: true,
    isProjectTrusted: () => true,
    isIdle: () => true,
    hasPendingMessages: () => false,
    modelRegistry: { find: vi.fn(), getApiKeyAndHeaders: vi.fn() },
    sessionManager: {
      getSessionId: () => "session-label-runtime",
      getSessionFile: () => undefined,
      getBranch: () => [],
      getLeafId: () => undefined,
    },
    ui: { setStatus, notify: vi.fn(), setWidget: vi.fn() },
  } as unknown as ExtensionContext;
  const config = normalizeFabricConfig({
    capture: { enabled: false },
    mcp: { enabled: false, cache: { enabled: false } },
    mesh: { enabled: true },
    memory: { enabled: false },
    agents: { enabled: false },
    residency: { enabled: false },
    prewalk: { enabled: false, alwaysRearm: false },
    approvals: { read: "allow", write: "allow" },
    ui: { sessionLabel },
  });
  const fixture = path.join(cwd, "unused.mjs");
  fs.writeFileSync(fixture, "export default {};");
  const runtime = new FabricRuntimeState(pi, new CapturedToolCatalog(), {
    paths: { extension: fixture, worker: fixture, residentHost: fixture, skills: cwd },
  });
  await runtime.initialize(context, config);
  await runtime.sessionLabel()?.sync();
  return { runtime, setStatus };
};

const labelStatuses = (setStatus: ReturnType<typeof vi.fn>): unknown[] =>
  setStatus.mock.calls.filter(([key]) => key === SESSION_LABEL_STATUS_KEY).map(([, text]) => text);

describe("Fabric runtime session label", () => {
  it("shows a root session's minted label in the footer and clears it on shutdown", async () => {
    const { runtime, setStatus } = await startRuntime();
    try {
      const status = runtime.sessionLabel()?.status();
      expect(status?.label).toMatch(/^[A-Z]+-\d+$/);
      expect(labelStatuses(setStatus)).toEqual([`Fabric ${status!.label}`]);
    } finally {
      await runtime.shutdown();
    }
    expect(labelStatuses(setStatus).at(-1)).toBeUndefined();
    expect(labelStatuses(setStatus)).toHaveLength(2);
  });

  it("keeps the footer empty when the footer setting is off", async () => {
    const { runtime, setStatus } = await startRuntime({ footer: false });
    try {
      expect(runtime.sessionLabel()?.status()?.footer).toBe(false);
      expect(labelStatuses(setStatus)).toEqual([]);
    } finally {
      await runtime.shutdown();
    }
  });

  it("shows nothing in a child session launched by Fabric", async () => {
    vi.stubEnv("PI_FABRIC_PARENT_RUN", "parent-run-1");
    vi.stubEnv("PI_FABRIC_AGENT_NAME", "worker");
    const { runtime, setStatus } = await startRuntime();
    try {
      expect(runtime.sessionLabel()?.status()).toBeUndefined();
      expect(labelStatuses(setStatus)).toEqual([]);
    } finally {
      await runtime.shutdown();
    }
  });
});
