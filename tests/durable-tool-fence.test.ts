import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_FABRIC_CONFIG, normalizeFabricConfig, type FabricConfig } from "../src/config.js";
import { ActionRegistry } from "../src/core/action-registry.js";
import { FabricExecutionService } from "../src/execution-service.js";
import { PiToolsProvider } from "../src/providers/pi-tools-provider.js";
import type { FabricActionDescriptor } from "../src/protocol.js";

// The durable worker publishes the fence under this key; Fabric never imports the worker.
type Fence = { toolCallId: string; accept(): Promise<void>; arm(): Promise<void> };
const holder = globalThis as { [key: symbol]: unknown };
const fences = (holder[Symbol.for("pi-fabric.durable-tool-fence.v1")] ??= new AsyncLocalStorage<Fence>()) as AsyncLocalStorage<Fence>;

const roots: string[] = [];
const registries: ActionRegistry[] = [];
afterEach(async () => {
  await Promise.all(registries.splice(0).map(registry => registry.close().catch(() => undefined)));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const writeAction: FabricActionDescriptor = {
  name: "write", description: "record an effect",
  inputSchema: { type: "object", properties: {}, additionalProperties: false }, risk: "write",
};

function fixture(config: FabricConfig = structuredClone(DEFAULT_FABRIC_CONFIG)) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-fence-")); roots.push(cwd);
  fs.writeFileSync(path.join(cwd, "sample.txt"), "fabric works\n");
  const events: string[] = [];
  const registry = new ActionRegistry(); registries.push(registry);
  registry.register(new PiToolsProvider(cwd, undefined, undefined));
  registry.register({
    name: "demo", description: "demo",
    async list() { return [writeAction]; },
    async describe(name) { return name === "write" ? writeAction : undefined; },
    async invoke() { events.push("invoke"); return "written"; },
  });
  const service = new FabricExecutionService(registry, config);
  const run = (code: string, fenceId = "call") => fences.run({
    toolCallId: fenceId,
    accept: async () => { events.push("accept"); },
    // A late arm proves the effect waits for the durable mark.
    arm: async () => { await new Promise(resolve => setTimeout(resolve, 20)); events.push("arm"); },
  }, () => service.execute({
    code, signal: undefined, parentToolCallId: "call",
    context: { cwd, hasUI: false } as ExtensionContext, onPartial() {},
  }));
  return { events, run };
}

const readOnly = 'const text = await pi.read({ path: "sample.txt" });\nreturn text.trim();';
const effectful = 'await pi.read({ path: "sample.txt" });\nawait tools.call({ ref: "demo.write", args: {} });\nreturn "done";';

describe("durable fabric_exec rerun fence", () => {
  it("accepts the fence for a read-only QuickJS program and never arms it", async () => {
    const { events, run } = fixture();
    const result = await run(readOnly);
    expect(result).toMatchObject({ success: true, value: "fabric works" });
    expect(events).toEqual(["accept"]);
  });

  it("arms the fence durably before an effectful call runs", async () => {
    const { events, run } = fixture();
    const result = await run(effectful);
    expect(result).toMatchObject({ success: true, value: "done" });
    expect(events).toEqual(["accept", "arm", "invoke"]);
  });

  it("arms before semantic search reaches the network classifier", async () => {
    const { events, run } = fixture();
    const result = await run('try { await tools.search({ query: "read", searchMode: "semantic" }); } catch {}\nreturn "searched";');
    expect(result).toMatchObject({ success: true, value: "searched" });
    expect(events).toEqual(["accept", "arm"]);
  });

  it("arms before a read approval that would prompt or classify", async () => {
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.approvals.read = "ask";
    const { events, run } = fixture(config);
    const result = await run('try { await pi.read({ path: "sample.txt" }); } catch {}\nreturn "asked";');
    expect(result).toMatchObject({ success: true, value: "asked" });
    expect(events).toEqual(["accept", "arm"]);
  });

  it("never accepts the fence for a native runtime whose effects bypass the host bridge", async () => {
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.executor.runtime = "node-process";
    config.executor.memoryLimitBytes = 128 * 1024 * 1024;
    const { events, run } = fixture(config);
    const result = await run(readOnly);
    expect(result).toMatchObject({ success: true, value: "fabric works" });
    expect(events).toEqual([]);
  }, 30_000);

  it("accepts the fence for a read-only Monty program", async () => {
    const config = normalizeFabricConfig({ executor: { kernel: "python", cpython: { binary: "/nonexistent/python3" }, memoryLimitBytes: 256 * 1024 * 1024 } });
    const { events, run } = fixture(config);
    const result = await run('text = await pi.read(path="sample.txt")\nreturn text.strip()');
    expect(result).toMatchObject({ success: true, value: "fabric works" });
    expect(events).toEqual(["accept"]);
  }, 30_000);

  it("ignores a fence that belongs to another tool call", async () => {
    const { events, run } = fixture();
    const result = await run(effectful, "another-call");
    expect(result).toMatchObject({ success: true, value: "done" });
    expect(events).toEqual(["invoke"]);
  });
});
