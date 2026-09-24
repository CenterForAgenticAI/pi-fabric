import { afterEach, describe, expect, it, vi } from "vitest";
import type { FabricInvocationContext } from "../src/protocol.js";
import { FabricShellJobStore } from "../src/core/shell-jobs.js";
import { PiToolsProvider } from "../src/providers/pi-tools-provider.js";
import { TasksProvider } from "../src/providers/tasks-provider.js";
const stores: FabricShellJobStore[] = [];
const context = {} as FabricInvocationContext;
afterEach(async () => { for (const store of stores.splice(0)) await store.close(); });
const setup = () => { const store = new FabricShellJobStore(); stores.push(store); return { store, provider: new TasksProvider(store) }; };

describe("tasks provider", () => {
  it("rejects a ninth monitor before spawning another shell", async () => {
    const { store } = setup();
    for (let i = 0; i < 8; i++) store.begin("bash", "existing watch", { monitor: { delivery: "ui", intervalMs: 1000, timeoutMs: 300000 } });
    const native = new PiToolsProvider(process.cwd(), undefined, undefined, { shellJobs: store, powerShellToolDefinitionFactory: undefined });
    await expect(native.invoke("bash", { command: "echo forbidden", monitor: { delivery: "wake" } }, context)).rejects.toThrow("At most 8 monitors");
    expect(store.list()).toHaveLength(8);
  });
  it("registers discoverable list/get/stop contracts", async () => {
    const { provider } = setup();
    expect((await provider.list({})).map(d => d.name)).toEqual(["list", "get", "stop"]);
    expect(await provider.describe("stop")).toMatchObject({ risk: "execute", inputSchema: { additionalProperties: false } });
  });
  it("returns terminal metadata, bounded output, and acknowledges a consumed result", async () => {
    const { store, provider } = setup(); const events = vi.fn(); store.subscribe(events);
    const job = store.begin("bash", "test", { cwd: "/work", ownerId: "session" }); job.spill(); job.append(Buffer.alloc(16000, 97)); await job.finish(7);
    const result = await provider.invoke("get", { id: job.id }, context) as { task: any; output: string };
    expect(result.task).toMatchObject({ id: job.id, cwd: "/work", ownerId: "session", status: "failed", exitCode: 7, unread: false });
    expect(result.output.length).toBeLessThan(8100);
    expect(events.mock.calls.at(-1)![0].type).toBe("acknowledged");
  });
  it("stops only owned handles; another session cannot access or kill them", async () => {
    const a = setup(), b = setup(); const job = a.store.begin("bash", "sleep");
    await expect(b.provider.invoke("stop", { id: job.id }, context)).rejects.toThrow("Unknown shell task");
    expect(job.abort.signal.aborted).toBe(false);
    expect(await a.provider.invoke("stop", { id: job.id }, context)).toMatchObject({ stopped: true, task: { stopping: true } });
    expect(await a.provider.invoke("stop", { id: job.id }, context)).toMatchObject({ stopped: false });
  });
  it("isolates listener errors and closes jobs without emitting completion wakeups", async () => {
    const { store } = setup(); store.subscribe(() => { throw new Error("bad observer"); });
    const events = vi.fn(); store.subscribe(events);
    const job = store.begin("bash", "work"); job.spill();
    events.mockClear(); await store.close();
    expect(job.abort.signal.aborted).toBe(true); expect(events).not.toHaveBeenCalled();
  });
});
