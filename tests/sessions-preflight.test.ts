import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionRunner } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DurableShellBridge } from "../src/jev-fabric/bridge.js";
import type { FabricInvocationContext } from "../src/protocol.js";
import { emitToolCallPreflight } from "../src/providers/pi-tools-provider.js";
import { SessionsProvider } from "../src/providers/sessions-provider.js";

const fake = fileURLToPath(new URL("./fixtures/fake-jev-fabric.mjs", import.meta.url));
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

type Hook = (event: { toolName: string; parentToolCallId: string; input: Record<string, unknown> }) => Promise<{ block: true; reason?: string } | undefined>;

// The provider is wired the way the runtime wires it: through the shared preflight and a runner.
const setup = (hook: Hook) => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "fabric-sessions-preflight-")));
  const binary = path.join(root, "jev-fabric");
  fs.writeFileSync(binary, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`, { mode: 0o755 });
  const bridge = { home: path.join(root, "home"), resolve: async () => ({ path: binary }) } as unknown as DurableShellBridge;
  const emitToolCall = vi.fn(hook);
  const runner = { emitToolCall } as unknown as ExtensionRunner;
  const provider = new SessionsProvider(bridge, {
    cwd: root,
    shellOverride: () => false,
    preflight: (input, context) => emitToolCallPreflight(runner, "bash", input, context),
  });
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  cleanups.push(() => provider.close());
  const call = (name: string, args: Record<string, unknown>) =>
    provider.invoke(name, args, { parentToolCallId: "fabric_exec_7", nestedToolCallId: "nested_1", signal: new AbortController().signal } as unknown as FabricInvocationContext) as Promise<Record<string, any>>;
  return { root, provider, call, emitToolCall };
};

describe.skipIf(process.platform === "win32")("sessions run the shell tool_call preflight", () => {
  it("blocks sessions.open before the serve spawns anything, and the hook sees command, cwd and parent id", async () => {
    const { call, provider, root, emitToolCall } = setup(async () => ({ block: true, reason: "denied by shell guard" }));
    const marker = path.join(root, "ran");
    await expect(call("open", { cmd: `touch ${marker}` })).rejects.toThrow("denied by shell guard");
    expect(emitToolCall).toHaveBeenCalledOnce();
    expect(emitToolCall.mock.calls[0]![0]).toMatchObject({
      type: "tool_call", toolName: "bash", toolCallId: "nested_1", parentToolCallId: "fabric_exec_7",
      input: { command: `touch ${marker}`, cwd: root },
    });
    expect(await provider.invoke("list", {}, {} as FabricInvocationContext)).toEqual([]);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("shows the hook an argv open as one shell-quoted command line", async () => {
    const { call, emitToolCall } = setup(async () => ({ block: true }));
    await expect(call("open", { argv: ["rm", "-rf", "a b"] })).rejects.toThrow();
    expect(emitToolCall.mock.calls[0]![0].input.command).toBe("rm -rf 'a b'");
  });

  it("still spawns when no hook blocks", async () => {
    const { call, root } = setup(async () => undefined);
    const marker = path.join(root, "ran");
    const opened = await call("open", { cmd: `touch '${marker}'` });
    expect(opened).toMatchObject({ lifetime: "session" });
    expect(await call("wait", { id: opened.id, timeoutMs: 5000 })).toMatchObject({ state: "exited", exitCode: 0 });
    expect(fs.existsSync(marker)).toBe(true);
  });

  it("uses the command a hook rewrote, and refuses to rewrite argv", async () => {
    const rewrite = setup(async event => { event.input.command = "echo guarded"; return undefined; });
    const opened = await rewrite.call("open", { cmd: "echo original" });
    await rewrite.call("wait", { id: opened.id, timeoutMs: 5000 });
    expect((await rewrite.call("read", { id: opened.id, offset: 0 })).text).toBe("guarded\n");
    const argvRewrite = setup(async event => { event.input.command = "echo guarded"; return undefined; });
    await expect(argvRewrite.call("open", { argv: ["echo", "original"] })).rejects.toThrow("cannot rewrite argv");
  });

  it("preflights text written to a shell session, and blocked text never reaches stdin", async () => {
    let block = false;
    const { call, emitToolCall } = setup(async event => (block && event.input.command === "echo blocked" ? { block: true, reason: "no" } : undefined));
    const shell = await call("open", { argv: ["sh"] });
    block = true;
    await expect(call("write", { id: shell.id, text: "echo blocked" })).rejects.toThrow("no");
    expect(emitToolCall.mock.calls.at(-1)![0]).toMatchObject({ toolName: "bash", parentToolCallId: "fabric_exec_7", input: { command: "echo blocked" } });
    block = false;
    await call("write", { id: shell.id, text: "echo fine\n" });
    expect((await call("read", { id: shell.id, offset: 0, waitMs: 5000 })).text).toBe("fine\n");
  });

  it("does not preflight writes to a session that is not a shell", async () => {
    const { call, emitToolCall } = setup(async () => undefined);
    const cat = await call("open", { argv: ["cat"] });
    emitToolCall.mockClear();
    await call("write", { id: cat.id, text: "data\n" });
    expect(emitToolCall).not.toHaveBeenCalled();
  });
});
