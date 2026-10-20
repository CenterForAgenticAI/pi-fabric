import fs from "node:fs";
import net, { type Server } from "node:net";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FabricSessionLabelConfig } from "../src/topology/session-label-settings.js";
import { SESSION_LABEL_STATUS_KEY, SessionLabelPresenter } from "../src/topology/session-label.js";

interface HerdrRequest {
  method: string;
  params: Record<string, unknown>;
}

const roots: string[] = [];
const servers: Server[] = [];
const presenters: SessionLabelPresenter[] = [];

afterEach(async () => {
  for (const presenter of presenters.splice(0)) await presenter.close();
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** A Herdr socket that keeps pane and tab labels and records every request. */
const startHerdr = async (initial: {
  paneLabel?: string | null;
  tabLabel?: string;
  failRename?: boolean;
} = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-label-"));
  roots.push(root);
  const socketPath = path.join(root, "herdr.sock");
  const pane: { pane_id: string; tab_id: string; label: string | null } = {
    pane_id: "w1:p1",
    tab_id: "w1:t1",
    label: initial.paneLabel === undefined ? "research" : initial.paneLabel,
  };
  const tab = { tab_id: "w1:t1", label: initial.tabLabel ?? "fabric-in-pi" };
  const requests: HerdrRequest[] = [];
  const server = net.createServer((socket) => {
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      input += chunk;
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(input.slice(0, newline)) as HerdrRequest & { id: string };
      requests.push({ method: request.method, params: request.params });
      const reply = (body: Record<string, unknown>) => socket.end(`${JSON.stringify({ id: request.id, ...body })}\n`);
      if (request.method === "pane.get" && request.params.pane_id === pane.pane_id) {
        reply({ result: { type: "pane_info", pane: { ...pane } } });
      } else if (request.method === "tab.get" && request.params.tab_id === tab.tab_id) {
        reply({ result: { type: "tab_info", tab: { ...tab } } });
      } else if (initial.failRename && request.method.endsWith(".rename")) {
        reply({ error: { code: "busy", message: "rename refused" } });
      } else if (request.method === "pane.rename" && request.params.pane_id === pane.pane_id) {
        pane.label = request.params.label as string | null;
        reply({ result: { type: "ok" } });
      } else if (request.method === "tab.rename" && request.params.tab_id === tab.tab_id) {
        tab.label = request.params.label as string;
        reply({ result: { type: "ok" } });
      } else {
        reply({ error: { code: "not_found", message: `${request.method} target not found` } });
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const environment: NodeJS.ProcessEnv = {
    HERDR_ENV: "1",
    HERDR_SOCKET_PATH: socketPath,
    HERDR_PANE_ID: pane.pane_id,
    // Stale on purpose: the live tab comes from pane.get.
    HERDR_TAB_ID: "w1:t9",
  };
  const renames = () => requests.filter((request) => request.method.endsWith(".rename"));
  return { pane, tab, requests, renames, environment };
};

const settings = (overrides: Partial<FabricSessionLabelConfig> = {}): FabricSessionLabelConfig => ({
  footer: true,
  herdr: "off",
  herdrPosition: "prefix",
  ...overrides,
});

const present = (options: {
  label?: () => string | undefined;
  settings: () => FabricSessionLabelConfig;
  environment?: NodeJS.ProcessEnv;
  mode?: ExtensionContext["mode"];
  hasUI?: boolean;
  on?: ExtensionAPI["on"];
}) => {
  const setStatus = vi.fn();
  const context = {
    mode: options.mode ?? "tui",
    hasUI: options.hasUI ?? true,
    ui: { setStatus },
  } as unknown as ExtensionContext;
  const pi = { on: options.on ?? (() => () => undefined) } as unknown as ExtensionAPI;
  const presenter = new SessionLabelPresenter(pi, context, {
    label: options.label ?? (() => "FAB-3"),
    settings: options.settings,
    environment: options.environment ?? {},
    intervalMs: 0,
  });
  presenters.push(presenter);
  return { presenter, setStatus };
};

describe("session label footer", () => {
  it("shows the Fabric label in the footer once and clears it on close", async () => {
    const { presenter, setStatus } = present({ settings: () => settings() });

    await presenter.sync();
    await presenter.sync();

    expect(setStatus.mock.calls).toEqual([[SESSION_LABEL_STATUS_KEY, "Fabric FAB-3"]]);
    await presenter.close();
    expect(setStatus).toHaveBeenLastCalledWith(SESSION_LABEL_STATUS_KEY, undefined);
  });

  it("waits for the label to be minted and hides it when the setting is off", async () => {
    let label: string | undefined;
    const current = settings();
    const { presenter, setStatus } = present({ label: () => label, settings: () => current });

    await presenter.sync();
    expect(setStatus).not.toHaveBeenCalled();

    label = "FAB-7";
    await presenter.sync();
    expect(setStatus).toHaveBeenLastCalledWith(SESSION_LABEL_STATUS_KEY, "Fabric FAB-7");

    current.footer = false;
    await presenter.sync();
    expect(setStatus).toHaveBeenLastCalledWith(SESSION_LABEL_STATUS_KEY, undefined);
  });
});

// The fake Herdr server listens on a Unix socket path; on Windows the client
// dials a named pipe instead, as in tests/herdr-transport.test.ts.
describe.skipIf(process.platform === "win32")("session label in Herdr", () => {
  it("leaves Herdr untouched while the integration is off", async () => {
    const herdr = await startHerdr();
    const { presenter } = present({ settings: () => settings(), environment: herdr.environment });

    await presenter.sync();
    await presenter.close();

    expect(herdr.requests).toEqual([]);
  });

  it("prefixes the live tab label once and restores it on close", async () => {
    const herdr = await startHerdr();
    const current = settings({ herdr: "tab" });
    const { presenter } = present({ settings: () => current, environment: herdr.environment });

    await presenter.sync();
    await presenter.sync();

    expect(herdr.tab.label).toBe("FAB-3 fabric-in-pi");
    expect(herdr.pane.label).toBe("research");
    expect(herdr.renames()).toEqual([
      { method: "tab.rename", params: { tab_id: "w1:t1", label: "FAB-3 fabric-in-pi" } },
    ]);
    expect(presenter.status().herdr.applied).toEqual(["tab w1:t1"]);

    await presenter.close();
    expect(herdr.tab.label).toBe("fabric-in-pi");
  });

  it("puts the label back as a suffix after another writer renames the pane", async () => {
    const herdr = await startHerdr();
    const current = settings({ herdr: "pane", herdrPosition: "suffix" });
    const { presenter } = present({ settings: () => current, environment: herdr.environment });

    await presenter.sync();
    expect(herdr.pane.label).toBe("research FAB-3");

    herdr.pane.label = "renamed-by-name-sync";
    await presenter.sync();
    expect(herdr.pane.label).toBe("renamed-by-name-sync FAB-3");
    expect(herdr.tab.label).toBe("fabric-in-pi");
  });

  it("moves the label when the position changes", async () => {
    const herdr = await startHerdr();
    const current = settings({ herdr: "tab" });
    const { presenter } = present({ settings: () => current, environment: herdr.environment });

    await presenter.sync();
    current.herdrPosition = "suffix";
    await presenter.sync();

    expect(herdr.tab.label).toBe("fabric-in-pi FAB-3");
  });

  it("shares one tab between two sessions without renaming back and forth", async () => {
    const herdr = await startHerdr();
    const current = settings({ herdr: "tab" });
    const first = present({ label: () => "FAB-3", settings: () => current, environment: herdr.environment });
    const second = present({ label: () => "FAB-4", settings: () => current, environment: herdr.environment });

    for (let round = 0; round < 3; round++) {
      await first.presenter.sync();
      await second.presenter.sync();
    }

    expect(herdr.tab.label).toBe("FAB-4 FAB-3 fabric-in-pi");
    expect(herdr.renames()).toHaveLength(2);

    await first.presenter.close();
    expect(herdr.tab.label).toBe("FAB-4 fabric-in-pi");
  });

  it("restores both names as soon as the target is turned off, clearing an unlabelled pane", async () => {
    const herdr = await startHerdr({ paneLabel: null });
    const current = settings({ herdr: "both" });
    const { presenter } = present({ settings: () => current, environment: herdr.environment });

    await presenter.sync();
    expect(herdr.pane.label).toBe("FAB-3");
    expect(herdr.tab.label).toBe("FAB-3 fabric-in-pi");

    current.herdr = "off";
    await presenter.sync();

    expect(herdr.pane.label).toBeNull();
    expect(herdr.tab.label).toBe("fabric-in-pi");
    expect(presenter.status().herdr.applied).toEqual([]);
  });

  it("does not rename anything outside an interactive TUI or outside Herdr", async () => {
    const herdr = await startHerdr();
    const current = settings({ herdr: "both" });
    const printMode = present({ settings: () => current, environment: herdr.environment, mode: "print", hasUI: false });
    const { HERDR_ENV: _herdr, ...outside } = herdr.environment;
    const notHerdr = present({ settings: () => current, environment: outside });

    await printMode.presenter.sync();
    await notHerdr.presenter.sync();

    expect(herdr.requests).toEqual([]);
    expect(notHerdr.presenter.status().herdr.available).toBe(false);
  });

  it("reports a Herdr failure in status instead of throwing", async () => {
    const herdr = await startHerdr({ failRename: true });
    const current = settings({ herdr: "tab" });
    const { presenter } = present({ settings: () => current, environment: herdr.environment });

    await expect(presenter.sync()).resolves.toBeUndefined();

    expect(herdr.tab.label).toBe("fabric-in-pi");
    expect(presenter.status().herdr.error).toContain("rename refused");
  });

  it("reapplies after a session name change without waiting for the timer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const herdr = await startHerdr();
      const handlers = new Map<string, () => unknown>();
      const on = ((event: string, handler: () => unknown) => {
        handlers.set(event, handler);
        return () => handlers.delete(event);
      }) as unknown as ExtensionAPI["on"];
      const current = settings({ herdr: "pane" });
      const { presenter } = present({ settings: () => current, environment: herdr.environment, on });
      await presenter.sync();
      herdr.pane.label = "new-name";

      handlers.get("session_info_changed")?.();
      await vi.advanceTimersByTimeAsync(1_000);
      await presenter.settled();

      expect(herdr.pane.label).toBe("FAB-3 new-name");
      expect(herdr.renames().filter((request) => request.params.label === "FAB-3 new-name")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
