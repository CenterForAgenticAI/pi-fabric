import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openFabricExecJournal, type FabricExecJournal } from "../src/runtime/exec-journal.js";
import type { FabricHostCall } from "../src/runtime/kernel.js";
import { QuickJsRuntime } from "../src/runtime/quickjs-runtime.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

const options = { timeoutMs: 5_000, memoryLimitBytes: 32 * 1024 * 1024 };
const hooks = { served() {}, local: () => undefined };
const identity = { code: "fixture" };

function journalFile(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-journal-")); roots.push(root);
  return path.join(root, "journal", "call.jsonl");
}

// Opens a fresh journal and returns the header digest the worker would memoize.
async function record(file: string, code: string, host: (journal: FabricExecJournal) => FabricHostCall, signal?: AbortSignal) {
  let digest = "";
  const journal = await openFabricExecJournal({ path: file, accept: async (value) => { digest = value; } }, identity, hooks);
  try {
    const result = await new QuickJsRuntime().execute(code, host(journal), { ...options, journal, ...(signal ? { signal } : {}) });
    return { digest, result };
  } finally { journal.close(); }
}

async function resume(file: string, digest: string, code: string, host: FabricHostCall, resumeIdentity = identity) {
  const journal = await openFabricExecJournal({ path: file, digest, accept: async () => { throw new Error("resume must not accept"); } }, resumeIdentity, hooks);
  try { return await new QuickJsRuntime().execute(code, host, { ...options, journal }); }
  finally { journal.close(); }
}

const target = (args: Record<string, unknown>) => `${String(args.ref)}:${JSON.stringify(args.args)}`;
const neverCalled: FabricHostCall = async (ref, args) => { throw new Error(`host called on resume: ${ref} ${JSON.stringify(args)}`); };
// A first attempt whose call `stopAt` hangs until the run is aborted, as a crash would leave it.
function crashingHost(stopAt: number, controller: AbortController, intent: boolean) {
  return (journal: FabricExecJournal): FabricHostCall => async (_ref, args, signal, call) => {
    const n = (args.args as { n: number }).n;
    if (n < stopAt) return n * 10;
    if (intent) journal.intent(call!.seq, String(args.ref));
    queueMicrotask(() => controller.abort());
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  };
}

const twoCalls = (second: string) => `const a = await tools.call({ ref: "demo.read", args: { n: 1 } });\nconst b = await tools.call({ ref: "${second}", args: { n: 2 } });\nreturn [a, b];`;

describe("fabric_exec crash journal", () => {
  it("serves recorded results without the host and repeats the guest clock and randomness", async () => {
    const file = journalFile();
    const code = `const r = Math.random(); const t0 = Date.now();\nconst x = await tools.call({ ref: "demo.read", args: { n: 1 } });\nawait new Promise(resolve => setTimeout(resolve, 5));\nconst t1 = Date.now();\nconst y = await tools.call({ ref: "demo.read", args: { n: 2 } });\nreturn [r, t0, x, t1, y, Math.random(), new Date(t1).toString(), new Date(0).getHours()];`;
    const calls: string[] = [];
    const first = await record(file, code, () => async (_ref, args) => {
      calls.push(target(args));
      await new Promise(resolve => setTimeout(resolve, 10));
      return (args.args as { n: number }).n * 10;
    });
    expect(first.result.terminationReason, first.result.error).toBe("completed");
    expect(calls).toEqual(['demo.read:{"n":1}', 'demo.read:{"n":2}']);
    const value = first.result.value as unknown[];
    expect(value[2]).toBe(10);
    expect(value[4]).toBe(20);
    expect(value[3]).toBeGreaterThan(value[1] as number);
    expect(value[7]).toBe(0);

    const again = await resume(file, first.digest, code, neverCalled);
    expect(again.terminationReason, again.error).toBe("completed");
    expect(again.value).toEqual(value);
  });

  it("runs the calls after the last recorded result live and keeps recording", async () => {
    const file = journalFile();
    const controller = new AbortController();
    const first = await record(file, twoCalls("demo.read"), crashingHost(2, controller, false), controller.signal);
    expect(first.result.terminationReason).toBe("aborted");

    const live: string[] = [];
    const again = await resume(file, first.digest, twoCalls("demo.read"), async (_ref, args) => {
      live.push(target(args));
      return (args.args as { n: number }).n * 10;
    });
    expect(again.terminationReason, again.error).toBe("completed");
    expect(again.value).toEqual([10, 20]);
    expect(live).toEqual(['demo.read:{"n":2}']);

    // The live result was journaled too, so a third attempt calls nothing.
    const third = await resume(file, first.digest, twoCalls("demo.read"), neverCalled);
    expect(third.value).toEqual([10, 20]);
  });

  it("stops at a call with an intent but no result and never repeats it", async () => {
    const file = journalFile();
    const controller = new AbortController();
    const first = await record(file, twoCalls("demo.write"), crashingHost(2, controller, true), controller.signal);
    expect(first.result.terminationReason).toBe("aborted");

    const again = await resume(file, first.digest, twoCalls("demo.write"), neverCalled);
    expect(again.terminationReason).toBe("runtime_error");
    expect(again.error).toContain("fabric_exec was interrupted during this call, which may have run:");
    expect(again.error).toContain('demo.write({"n":2})');
    expect(again.error).toContain("1 earlier tool call finished before the interruption");
    expect(again.error).toContain("This call was not repeated.");
  });

  it("refuses a resume whose program no longer repeats its recorded calls", async () => {
    const file = journalFile();
    const first = await record(file, twoCalls("demo.read"), () => async (_ref, args) => (args.args as { n: number }).n);
    const changed = 'return await tools.call({ ref: "demo.other", args: { n: 9 } });';
    const again = await resume(file, first.digest, changed, neverCalled);
    expect(again.terminationReason).toBe("runtime_error");
    expect(again.error).toBe('fabric_exec could not resume after an interruption: the program did not repeat its recorded demo.read call (it made demo.other({"n":9}) instead). No call after the divergence ran.');
  });

  it("replays a recorded error with its message and opted-in numeric fields", async () => {
    const file = journalFile();
    const code = 'try { await tools.call({ ref: "demo.fail", args: {} }); } catch (error) { const e = error as Record<string, unknown>; return [e.message, e.status]; }\nreturn null;';
    const first = await record(file, code, () => async () => { throw Object.assign(new Error("HTTP 429"), { guestFields: { status: 429 } }); });
    expect(first.result.value).toEqual(["HTTP 429", 429]);
    const again = await resume(file, first.digest, code, neverCalled);
    expect(again.value).toEqual(["HTTP 429", 429]);
  });

  it("drops a torn last line but refuses damage before it", async () => {
    const file = journalFile();
    const first = await record(file, twoCalls("demo.read"), () => async (_ref, args) => (args.args as { n: number }).n);
    const intact = fs.readFileSync(file);

    fs.appendFileSync(file, '0badc0de {"c":2');
    const torn = await resume(file, first.digest, twoCalls("demo.read"), neverCalled);
    expect(torn.value).toEqual([1, 2]);
    expect(fs.readFileSync(file).equals(intact)).toBe(true);

    const lines = intact.toString("utf8").split("\n");
    const damaged = lines[1]!.replace('"seq":0', '"seq":5');
    expect(damaged).not.toBe(lines[1]);
    lines[1] = damaged;
    fs.writeFileSync(file, lines.join("\n"));
    await expect(resume(file, first.digest, twoCalls("demo.read"), neverCalled)).rejects.toThrow(
      "fabric_exec could not resume after an interruption: its journal is damaged. Nothing was rerun.",
    );
  });

  it("refuses a missing, replaced, or re-identified journal", async () => {
    const file = journalFile();
    const first = await record(file, twoCalls("demo.read"), () => async () => 1);
    await expect(resume(file, first.digest, twoCalls("demo.read"), neverCalled, { code: "changed" })).rejects.toThrow(
      "the program, its payloads, or its execution settings changed since the journal was recorded",
    );
    await expect(resume(file, "0".repeat(64), twoCalls("demo.read"), neverCalled)).rejects.toThrow("its journal was replaced or lost its header");
    fs.rmSync(file);
    await expect(resume(file, first.digest, twoCalls("demo.read"), neverCalled)).rejects.toThrow("its journal is missing");
  });

  it("refuses to resume past a result that named process-local work", async () => {
    const file = journalFile();
    const first = await record(file, 'return await tools.call({ ref: "agents.spawn", args: {} });', () => async () => ({ id: "child" }));
    await expect(resume(file, first.digest, 'return await tools.call({ ref: "agents.spawn", args: {} });', neverCalled)).rejects.toThrow(
      "its agents.spawn call returned process-local work that did not survive the restart",
    );
  });

  it("creates the journal private to its owner", async () => {
    const file = journalFile();
    await record(file, "return 1;", () => async () => undefined);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
  });
});
