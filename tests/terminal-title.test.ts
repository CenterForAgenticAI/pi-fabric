import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultCodePreviewSettings } from "../src/ui/code-preview.js";
import type { FabricRenderAudit } from "../src/ui/fabric-render.js";
import { piAppTitle, piTerminalTitle } from "../src/ui/pi-terminal-title.js";
import {
  FabricTerminalTitle,
  MAX_TERMINAL_TITLE_CHARS,
  terminalCallTitle,
  terminalTitleText,
  withTerminalTitle,
} from "../src/ui/terminal-title.js";

const audit = (overrides: Partial<FabricRenderAudit>): FabricRenderAudit => ({
  ref: "pi.read",
  provider: "pi",
  tool: "read",
  args: {},
  ...overrides,
});

const scratch: string[] = [];

afterEach(() => {
  for (const directory of scratch.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const hostPackage = (entry: string, manifest: unknown): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-host-"));
  scratch.push(root);
  fs.mkdirSync(path.join(root, path.dirname(entry)), { recursive: true });
  fs.writeFileSync(path.join(root, entry), "");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(manifest));
  return path.join(root, entry);
};

describe("terminalTitleText", () => {
  it("drops styling and control characters a raw OSC title cannot carry", () => {
    expect(terminalTitleText("\u001b[1;36mread\u001b[0m src/config.ts")).toBe("read src/config.ts");
    expect(terminalTitleText("  read\n\tsrc/config.ts  ")).toBe("read src/config.ts");
    expect(terminalTitleText("scan\u0007\u001b]0;pwned")).toBe("scan ]0;pwned");
    expect(terminalTitleText(undefined)).toBe("");
  });

  it("clips long titles to the window-chrome budget", () => {
    const clipped = terminalTitleText("x".repeat(MAX_TERMINAL_TITLE_CHARS + 40));
    expect(Array.from(clipped)).toHaveLength(MAX_TERMINAL_TITLE_CHARS);
    expect(clipped.endsWith("…")).toBe(true);
  });
});

describe("terminalCallTitle", () => {
  it("reuses the transcript's nested call vocabulary without escapes", () => {
    const core = { cwd: "/work/pi-fabric", settings: defaultCodePreviewSettings() };
    expect(terminalCallTitle(audit({ args: { path: "src/config.ts", offset: 10, limit: 40 } }), core))
      .toBe("read src/config.ts:10-49 · typescript");
    expect(terminalCallTitle(audit({
      ref: "pi.grep", tool: "grep", args: { pattern: "fallback", path: "src" },
    }), core)).toBe("grep /fallback/ in src");
    expect(terminalCallTitle(audit({
      ref: "pi.bash", tool: "bash", args: { command: "bun run build" },
    }), core)).toBe("bash $ bun run build");
  });

  it("keeps a control character in a path inert", () => {
    const title = terminalCallTitle(
      audit({ args: { path: "src/\u001b[31mred\u001b[0m.ts" } }),
      { cwd: "/work/pi-fabric", settings: defaultCodePreviewSettings() },
    );
    expect(title).not.toContain("\u001b");
    expect(title).toBe("read src/␛[31mred␛[0m.ts · typescript");
  });
});

describe("FabricTerminalTitle", () => {
  it("shows the latest call title, coalesces repeats, and hands the title back once", async () => {
    const applied: string[] = [];
    const run = new FabricTerminalTitle({
      setTitle: (title) => applied.push(title),
      base: () => "π - my project",
    });
    run.show("read src/a.ts");
    run.show("read src/a.ts");
    run.show("bash $ bun run build");
    expect(applied).toEqual(["read src/a.ts", "bash $ bun run build"]);

    await run.restore();
    await run.restore();
    expect(applied).toEqual(["read src/a.ts", "bash $ bun run build", "π - my project"]);

    run.show("read src/late.ts");
    expect(applied).toHaveLength(3);
  });

  it("keeps Pi's title away while a parallel run still holds it", async () => {
    const applied: string[] = [];
    const options = { setTitle: (title: string) => applied.push(title), base: () => "π - my project" };
    const first = new FabricTerminalTitle(options);
    const second = new FabricTerminalTitle(options);
    first.show("read src/a.ts");
    second.show("bash $ bun run build");

    await first.restore();
    expect(applied).toEqual(["read src/a.ts", "bash $ bun run build"]);

    await second.restore();
    expect(applied.at(-1)).toBe("π - my project");
  });

  it("stays inert without a host setter", async () => {
    const run = new FabricTerminalTitle();
    expect(() => run.show("read src/a.ts")).not.toThrow();
    await expect(run.restore()).resolves.toBeUndefined();
  });

  it("restores the title when the program throws", async () => {
    const applied: string[] = [];
    const run = new FabricTerminalTitle({
      setTitle: (title) => applied.push(title),
      base: async () => "π - my project",
    });
    await expect(withTerminalTitle(run, "Reading", async () => {
      throw new Error("aborted");
    })).rejects.toThrow("aborted");
    expect(applied).toEqual(["Reading", "π - my project"]);
  });

  it("runs without borrowing the title", async () => {
    await expect(withTerminalTitle(undefined, "Reading", async () => 7)).resolves.toBe(7);
  });
});

describe("piTerminalTitle", () => {
  const context = (sessionName: string | undefined) => ({
    cwd: "/work/pi-fabric",
    sessionManager: { getSessionName: () => sessionName },
  });

  it("mirrors Pi's own session and cwd title shape", () => {
    expect(piTerminalTitle(context("titles"))).toBe("π - titles - pi-fabric");
    expect(piTerminalTitle(context("  "))).toBe("π - pi-fabric");
    expect(piTerminalTitle(context(undefined))).toBe("π - pi-fabric");
  });

  it("reads a branded app name from the running host manifest", () => {
    const bundled = hostPackage(path.join("dist", "bundle", "index.js"), {
      name: "@earendil-works/pi-coding-agent",
      piConfig: { name: "tee" },
    });
    expect(piAppTitle(bundled)).toBe("tee");
    expect(piAppTitle(hostPackage(path.join("dist", "index.js"), { name: "pi" }))).toBe("π");
    expect(piAppTitle(path.join(os.tmpdir(), "missing", "dist", "index.js"))).toBe("π");
    expect(piAppTitle(undefined)).toBe("π");
  });
});
