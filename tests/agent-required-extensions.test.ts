import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AgentManager } from "../src/agents/manager.js";
import { normalizeAgentRunRequest } from "../src/agents/request.js";
import { absoluteExtensionPaths } from "../src/agents/required-extensions.js";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import { parseWorkerOptions } from "../src/worker/options.js";

// F-019: an extensions: false child may load only extensions that its parent
// session itself loaded, named by package or by the exact loaded path. A caller
// must never reach `-e` with an arbitrary path of its own.

const roots: string[] = [];
const managers: AgentManager[] = [];
const temporary = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-required-ext-"));
  roots.push(root);
  return root;
};
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
});
afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

/** A package directory with a manifest name and one extension entry file. */
const extensionPackage = (root: string, name: string): string => {
  const directory = path.join(root, "packages", name.replace(/[@/]/g, "_"));
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name }));
  const entry = path.join(directory, "index.ts");
  fs.writeFileSync(entry, "export default () => {};\n");
  return entry;
};

/** A worker that records its argv and settles completed without starting Pi. */
const captureWorker = (root: string): { workerPath: string; argvFile: string } => {
  const argvFile = path.join(root, "argv.json");
  const workerPath = path.join(root, "capture.mjs");
  fs.writeFileSync(
    workerPath,
    `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv));\n` +
      `await import(${JSON.stringify(pathToFileURL(path.resolve("tests/fixtures/fake-worker.mjs")).href)});\n`,
  );
  return { workerPath, argvFile };
};

const managerFor = (
  root: string,
  options: {
    loaded?: readonly string[] | undefined;
    api?: string;
    fabricExtensionPath?: string;
  },
) => {
  const { workerPath, argvFile } = captureWorker(root);
  const manager = new AgentManager(root, {
    ...DEFAULT_FABRIC_CONFIG.agents,
    runner: "pi",
    model: "",
    timeoutMs: 5_000,
    sessionExport: false,
  }, {
    workerPath,
    runRoot: path.join(root, "runs"),
    ...(options.fabricExtensionPath ? { fabricExtensionPath: options.fabricExtensionPath } : {}),
    loadedExtensions: () => options.loaded,
    piModelApi: () => options.api,
  });
  managers.push(manager);
  return { manager, argvFile };
};

const workerArgv = (root: string, overrides: Record<string, string>) => [
  process.execPath, "worker.js",
  ...Object.entries({
    id: "probe", runner: "pi", name: "probe",
    "task-file": path.join(root, "task.txt"), "status-file": path.join(root, "status.json"),
    "lifecycle-file": path.join(root, "lifecycle.jsonl"), "log-file": path.join(root, "events.jsonl"),
    cwd: root, "pi-binary": "pi", "claude-binary": "unused", "veda-binary": "unused",
    "veda-backend": "unused", "veda-persona": "unused", "timeout-ms": "5000", depth: "1",
    "full-code-mode": "false", extensions: "false", tools: "[]", "granted-risks": "[]", transport: "process",
    ...overrides,
  }).flatMap(([key, value]) => [`--${key}`, value]),
];

describe("requiredExtensions on agents.run/spawn", () => {
  it.each(["pi", "pi-durable"] as const)(
    "forwards a parent-loaded extension named by package to an extensions: false %s child",
    async (runner) => {
      const root = temporary();
      const provider = extensionPackage(root, "provider-pkg");
      const other = extensionPackage(root, "unrelated-pkg");
      const { manager, argvFile } = managerFor(root, { loaded: [other, provider], api: "unified" });
      const result = await manager.run({
        task: "probe",
        runner,
        transport: "process",
        model: "unified/claude",
        extensions: false,
        requiredExtensions: ["provider-pkg"],
      });
      expect(result.status, result.error).toBe("completed");
      const options = parseWorkerOptions(JSON.parse(fs.readFileSync(argvFile, "utf8")));
      expect(options.extensions).toBe(false);
      // The path comes from the parent's loaded set, never from the caller.
      expect(options.requiredExtensions).toEqual([provider]);
    },
  );

  it("accepts the exact absolute path of a parent-loaded extension", async () => {
    const root = temporary();
    const provider = extensionPackage(root, "provider-pkg");
    const { manager, argvFile } = managerFor(root, { loaded: [provider] });
    const result = await manager.run({
      task: "probe", transport: "process", model: "p/m", extensions: false, requiredExtensions: [provider],
    });
    expect(result.status, result.error).toBe("completed");
    expect(parseWorkerOptions(JSON.parse(fs.readFileSync(argvFile, "utf8"))).requiredExtensions).toEqual([provider]);
  });

  it("matches a scoped package by its unscoped name, and refuses an ambiguous one", async () => {
    const root = temporary();
    const scoped = extensionPackage(root, "@vendor/provider-pkg");
    const { manager, argvFile } = managerFor(root, { loaded: [scoped] });
    const result = await manager.run({
      task: "probe", transport: "process", model: "p/m", extensions: false, requiredExtensions: ["provider-pkg"],
    });
    expect(result.status, result.error).toBe("completed");
    expect(parseWorkerOptions(JSON.parse(fs.readFileSync(argvFile, "utf8"))).requiredExtensions).toEqual([scoped]);

    const ambiguousRoot = temporary();
    const first = extensionPackage(ambiguousRoot, "@one/shared");
    const second = extensionPackage(ambiguousRoot, "@two/shared");
    const ambiguous = managerFor(ambiguousRoot, { loaded: [first, second] });
    await expect(ambiguous.manager.run({
      task: "never launch", transport: "process", model: "p/m", extensions: false, requiredExtensions: ["shared"],
    })).rejects.toThrow(/matches more than one loaded package/);
    expect(fs.existsSync(ambiguous.argvFile)).toBe(false);
  });

  it("refuses an arbitrary path the parent did not load, before launch", async () => {
    const root = temporary();
    const provider = extensionPackage(root, "provider-pkg");
    // A real, loadable file the caller controls, but the parent never loaded it.
    const hostile = extensionPackage(temporary(), "hostile-pkg");
    const { manager, argvFile } = managerFor(root, { loaded: [provider] });
    await expect(manager.run({
      task: "never launch", transport: "process", model: "p/m", extensions: false, requiredExtensions: [hostile],
    })).rejects.toThrow(/not loaded by this session/);
    expect(fs.existsSync(argvFile)).toBe(false);
    expect(manager.listForUi()).toHaveLength(0);
  });

  it("refuses a package name that no parent-loaded extension has", async () => {
    const root = temporary();
    const provider = extensionPackage(root, "provider-pkg");
    extensionPackage(root, "installed-but-not-loaded");
    const { manager, argvFile } = managerFor(root, { loaded: [provider] });
    await expect(manager.run({
      task: "never launch", transport: "process", model: "p/m", extensions: false,
      requiredExtensions: ["installed-but-not-loaded"],
    })).rejects.toThrow(/not loaded by this session/);
    expect(fs.existsSync(argvFile)).toBe(false);
  });

  it("refuses a relative path even when it points at a parent-loaded extension", async () => {
    const root = temporary();
    const provider = extensionPackage(root, "provider-pkg");
    const { manager, argvFile } = managerFor(root, { loaded: [provider] });
    const relative = path.relative(root, provider);
    await expect(manager.run({
      task: "never launch", transport: "process", model: "p/m", extensions: false, requiredExtensions: [relative],
    })).rejects.toThrow(/not loaded by this session/);
    expect(fs.existsSync(argvFile)).toBe(false);
  });

  it("refuses when the parent's loaded extensions are unknown", async () => {
    const root = temporary();
    const provider = extensionPackage(root, "provider-pkg");
    const { manager, argvFile } = managerFor(root, { loaded: undefined });
    await expect(manager.run({
      task: "never launch", transport: "process", model: "p/m", extensions: false, requiredExtensions: [provider],
    })).rejects.toThrow(/cannot verify which extensions this session loaded/);
    expect(fs.existsSync(argvFile)).toBe(false);
  });

  it("refuses Fabric itself as a required extension", async () => {
    const root = temporary();
    const fabric = extensionPackage(root, "pi-fabric");
    const { manager, argvFile } = managerFor(root, { loaded: [fabric], fabricExtensionPath: fabric });
    await expect(manager.run({
      task: "never launch", transport: "process", model: "p/m", extensions: false, requiredExtensions: ["pi-fabric"],
    })).rejects.toThrow(/Fabric itself/);
    expect(fs.existsSync(argvFile)).toBe(false);
  });

  it("refuses requiredExtensions when extensions stay enabled", async () => {
    const root = temporary();
    const provider = extensionPackage(root, "provider-pkg");
    const { manager, argvFile } = managerFor(root, { loaded: [provider] });
    await expect(manager.run({
      task: "never launch", transport: "process", model: "p/m", requiredExtensions: ["provider-pkg"],
    })).rejects.toThrow(/only with extensions: false/);
    expect(fs.existsSync(argvFile)).toBe(false);
  });

  it("refuses requiredExtensions for a non-Pi runner", async () => {
    const root = temporary();
    const provider = extensionPackage(root, "provider-pkg");
    const { manager, argvFile } = managerFor(root, { loaded: [provider] });
    await expect(manager.run({
      task: "never launch", runner: "claude", transport: "process", extensions: false,
      requiredExtensions: ["provider-pkg"],
    })).rejects.toThrow(/Pi runner/);
    expect(fs.existsSync(argvFile)).toBe(false);
  });
});

describe("extension-provided model check before launch", () => {
  it("refuses an extensions: false child whose model API only an extension provides", async () => {
    const root = temporary();
    const { manager, argvFile } = managerFor(root, { loaded: [], api: "unified" });
    const failure = manager.run({
      task: "never launch", transport: "process", model: "unified/claude-opus-5-5", extensions: false,
    });
    await expect(failure).rejects.toThrow(/unified\/claude-opus-5-5/);
    await expect(failure).rejects.toThrow(/provider "unified"/);
    await expect(failure).rejects.toThrow(/requiredExtensions/);
    expect(fs.existsSync(argvFile)).toBe(false);
    expect(manager.listForUi()).toHaveLength(0);
  });

  it("launches an extensions: false child whose model uses a built-in API", async () => {
    const root = temporary();
    const { manager, argvFile } = managerFor(root, { loaded: [], api: "anthropic-messages" });
    const result = await manager.run({
      task: "probe", transport: "process", model: "anthropic/claude-sonnet-5-5", extensions: false,
    });
    expect(result.status, result.error).toBe("completed");
    expect(fs.existsSync(argvFile)).toBe(true);
  });

  it("launches an extension-provided model once a provider extension is required", async () => {
    const root = temporary();
    const provider = extensionPackage(root, "provider-pkg");
    const { manager, argvFile } = managerFor(root, { loaded: [provider], api: "unified" });
    const result = await manager.run({
      task: "probe", transport: "process", model: "unified/claude-opus-5-5", extensions: false,
      requiredExtensions: ["provider-pkg"],
    });
    expect(result.status, result.error).toBe("completed");
    expect(fs.existsSync(argvFile)).toBe(true);
  });
});

describe("requiredExtensions request and worker contracts", () => {
  const defaults = { runner: "pi" as const, timeoutMs: 1_000 };

  it("keeps a string list and rejects malformed values instead of dropping them", () => {
    expect(normalizeAgentRunRequest({ task: "t", extensions: false, requiredExtensions: ["a", "b"] }, defaults))
      .toMatchObject({ requiredExtensions: ["a", "b"] });
    expect(() => normalizeAgentRunRequest({ task: "t", requiredExtensions: "a" }, defaults))
      .toThrow(/requiredExtensions/);
    expect(() => normalizeAgentRunRequest({ task: "t", requiredExtensions: ["a", 3] }, defaults))
      .toThrow(/requiredExtensions/);
  });

  it("makes the parent's configured extension paths absolute and drops synthetic entries", () => {
    const cwd = path.join(os.tmpdir(), "session-cwd");
    expect(absoluteExtensionPaths(
      ["./ext/index.ts", "/abs/ext.ts", "~/agent/ext.ts", "builtin:mcp", "<inline:codemode>"],
      cwd,
    )).toEqual([
      path.join(cwd, "ext", "index.ts"),
      "/abs/ext.ts",
      path.join(os.homedir(), "agent", "ext.ts"),
    ]);
  });

  it("rejects worker required extensions that are relative, or that ride along with extensions enabled", () => {
    const root = temporary();
    expect(() => parseWorkerOptions(workerArgv(root, { "required-extensions": JSON.stringify(["ext/index.ts"]) })))
      .toThrow(/required extensions/i);
    expect(() => parseWorkerOptions(workerArgv(root, {
      extensions: "true", "required-extensions": JSON.stringify([path.join(root, "index.ts")]),
    }))).toThrow(/required extensions/i);
    expect(() => parseWorkerOptions(workerArgv(root, {
      runner: "claude", "required-extensions": JSON.stringify([path.join(root, "index.ts")]),
    }))).toThrow(/required extensions/i);
  });
});

// The real worker must turn the verified list into `-e` flags after
// --no-extensions, for both the pi binary and the durable sibling entry.
describe("real worker launch flags", () => {
  let fixture: string;
  let worker: string;
  beforeAll(async () => {
    fixture = temporary();
    worker = path.join(fixture, "worker.mjs");
    fs.symlinkSync(path.resolve("node_modules"), path.join(fixture, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    await build({ entryPoints: [path.resolve("src/worker.ts")], outfile: worker, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent" });
    fs.mkdirSync(path.join(fixture, "durable"));
    // Both launch doubles record argv, then behave as the fake Pi RPC child.
    const probe = `
      import fs from 'node:fs';
      fs.writeFileSync(process.env.LAUNCH_ARGV_FILE, JSON.stringify(process.argv.slice(2)));
      await import(${JSON.stringify(pathToFileURL(path.resolve("tests/fixtures/fake-pi-model.mjs")).href)});
    `;
    fs.writeFileSync(path.join(fixture, "durable", "worker.js"), probe);
    fs.writeFileSync(path.join(fixture, "fake-pi.mjs"), probe);
  }, 60_000);

  it.each(["pi", "pi-durable"])("passes each required extension with -e after --no-extensions for %s", async (runner) => {
    const root = temporary();
    const provider = extensionPackage(root, "provider-pkg");
    fs.writeFileSync(path.join(root, "task.txt"), "run on requested model");
    const argvFile = path.join(root, "launch-argv.json");
    const args = workerArgv(root, {
      runner,
      "pi-binary": path.join(fixture, "fake-pi.mjs"),
      model: "openai-codex/gpt-5.6-sol",
      "required-extensions": JSON.stringify([provider]),
    });
    const child = spawn(process.execPath, [worker, ...args.slice(2)], {
      env: { ...process.env, LAUNCH_ARGV_FILE: argvFile }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stdout.resume();
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    await new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("close", () => resolve()); });
    expect(fs.existsSync(argvFile), stderr).toBe(true);
    const launched = JSON.parse(fs.readFileSync(argvFile, "utf8")) as string[];
    const noExtensions = launched.indexOf("--no-extensions");
    expect(noExtensions).toBeGreaterThanOrEqual(0);
    const extensionFlag = launched.indexOf("-e");
    expect(extensionFlag).toBeGreaterThan(noExtensions);
    expect(launched[extensionFlag + 1]).toBe(provider);
  }, 30_000);
});
