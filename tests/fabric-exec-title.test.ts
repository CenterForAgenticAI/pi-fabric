import { describe, expect, it, vi } from "vitest";
import { normalizeFabricConfig } from "../src/config.js";
import type { FabricState } from "../src/fabric-state.js";
import { createFabricExecTool } from "../src/fabric-exec-tool.js";
import { defaultCodePreviewSettings } from "../src/ui/code-preview.js";
import type { FabricRenderAudit } from "../src/ui/fabric-render.js";

const readAudit: FabricRenderAudit = {
  ref: "pi.read",
  startedAt: 0,
  endedAt: 4,
  success: true,
  tool: "read",
  provider: "pi",
  args: { path: "src/config.ts" },
};

const harness = (options: {
  audits?: FabricRenderAudit[];
  ui?: Record<string, unknown>;
  mode?: string;
  hasUI?: boolean;
  fail?: boolean;
} = {}) => {
  const titles: string[] = [];
  const audits = options.audits ?? [readAudit];
  const state = {
    bootstrapped: true,
    initialized: true,
    config: normalizeFabricConfig({ ui: { toolDisplay: "compact", ...options.ui } }),
    ensure: vi.fn(async () => {}),
    claimHandoff: vi.fn(async () => undefined),
    prewalk: { planRequired: () => false, status: () => ({ state: "idle" }) },
    execution: {
      execute: vi.fn(async (request: { onPartial(snapshot: unknown): void }) => {
        request.onPartial({ audits, phases: [], progress: "reading" });
        if (options.fail) throw new Error("aborted");
        return {
          success: true,
          value: { ok: true },
          logs: [],
          audits,
          phases: [],
          trace: { outcome: "succeeded", operations: [] },
          elapsedMs: 4,
        };
      }),
    },
  } as unknown as FabricState;
  const tool = createFabricExecTool(
    state,
    defaultCodePreviewSettings(),
    new Map(),
    (value) => value,
  );
  const context = {
    mode: options.mode ?? "tui",
    hasUI: options.hasUI ?? true,
    cwd: "/work/pi-fabric",
    ui: {
      setTitle: (title: string) => titles.push(title),
      setStatus: () => {},
      notify: () => {},
    },
    sessionManager: {
      getSessionId: () => "session-1",
      getSessionName: () => "titles",
    },
  };
  return { titles, tool, context };
};

const run = (
  probe: ReturnType<typeof harness>,
  code = "return await pi.read({ path: 'src/config.ts' });",
) => probe.tool.execute!(
  "fabric-call",
  { code } as never,
  undefined,
  undefined,
  probe.context as never,
);

describe("fabric_exec window title", () => {
  it("shows the intent, then the latest nested call, then Pi's title", async () => {
    const probe = harness();
    await run(probe);
    expect(probe.titles).toEqual([
      "Read config.ts",
      "read src/config.ts · typescript",
      "π - titles - pi-fabric",
    ]);
  });

  it("shows only the newest call when several run", async () => {
    const probe = harness({
      audits: [
        readAudit,
        { ...readAudit, ref: "pi.bash", tool: "bash", args: { command: "bun run build" } },
      ],
    });
    await run(probe);
    expect(probe.titles).toContain("bash $ bun run build");
    expect(probe.titles).not.toContain("read src/config.ts · typescript");
    expect(probe.titles.at(-1)).toBe("π - titles - pi-fabric");
  });

  it("hands the title back when the program throws", async () => {
    const probe = harness({ fail: true });
    await expect(run(probe)).rejects.toThrow("aborted");
    expect(probe.titles.at(-1)).toBe("π - titles - pi-fabric");
  });

  it("leaves the window title alone when disabled or non-interactive", async () => {
    const disabled = harness({ ui: { terminalTitle: false } });
    await run(disabled);
    expect(disabled.titles).toEqual([]);

    const rpc = harness({ mode: "rpc" });
    await run(rpc);
    expect(rpc.titles).toEqual([]);

    const headless = harness({ hasUI: false });
    await run(headless);
    expect(headless.titles).toEqual([]);
  });
});
