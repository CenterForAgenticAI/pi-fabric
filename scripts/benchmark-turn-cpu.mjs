import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

// External packages resolve from this temporary directory under the repository.
const root = fs.mkdtempSync(path.resolve(".benchmark-turn-cpu-"));
try {
  const outfile = path.join(root, "subjects.mjs");
  await build({ stdin: { resolveDir: process.cwd(), loader: "ts", contents: `
export { BackgroundEntropyCompiler, compileEntropySurfaceAsync } from './src/entropy/compiler.ts';
export { SessionObservationCache, mergeObservationWindowAsync, poolToValueObservations } from './src/entropy/pool.ts';
export { BackgroundSessionSelector, machineSessionFilesAsync } from './src/entropy/sessions.ts';
export { LiteralCallScanner } from './src/speculation/scanner.ts';
export { FabricSpeculationStreamTap } from './src/speculation/stream-tap.ts';
` }, outfile, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent" });
  const s = await import(pathToFileURL(outfile));
  const rows = [];
  async function measure(name, fn) {
    for (let i = 0; i < 2; i++) await fn();
    const samples = [];
    for (let i = 0; i < 5; i++) {
      const start = performance.now(); const cpu = process.cpuUsage();
      await fn();
      const used = process.cpuUsage(cpu);
      samples.push({ wallMs: performance.now() - start, cpuMs: (used.user + used.system) / 1000 });
    }
    const median = key => Math.round([...samples].sort((a,b) => a[key] - b[key])[2][key] * 100) / 100;
    const row = { name, wallMs: median("wallMs"), cpuMs: median("cpuMs") };
    rows.push(row); console.log(JSON.stringify(row));
  }
  const surface = { version: 1, actions: Array.from({ length: 150 }, (_,i) => ({ ref: `extensions.tool${i}`, inputSchema: {
    type: "object", properties: { path: { type: "string" }, mode: { type: "string", enum: ["fast", "safe"] }, limit: { type: "integer" } },
    required: ["path"], additionalProperties: false,
  } })) };
  for (const count of [1000, 10000]) {
    const makeTrace = i => ({ model: `provider/model${i % 2}`, taskKey: `task${Math.floor(i / 20)}`, operations:
      Array.from({ length: 8 }, (_,j) => ({ ref: `extensions.tool${j}`, args: { path: `file${i % 40}.ts`, mode: "safe", limit: 20 }, outcome: "succeeded" })),
    });
    let traces = Array.from({ length: count }, (_,i) => makeTrace(i));
    let observations = traces.flatMap(t => t.operations.flatMap(o => Object.entries(o.args).map(([key,value]) => ({ ref: o.ref, key, value }))));
    const compiler = new s.BackgroundEntropyCompiler();
    const cache = new s.SessionObservationCache();
    let pool = (await cache.merge(undefined, [{ file: "session", observations }])).file;
    const artifact = (await compiler.compile({ surface, windows: [{ file: "session", traces }] })).artifact;
    const uncached = () => s.compileEntropySurfaceAsync({ surface, traces, artifact, valueObservations: s.poolToValueObservations(pool) });
    const cached = () => compiler.compile({ surface, windows: [{ file: "session", traces }], artifact });
    assert.deepEqual((await cached()).report, (await uncached()).report);
    await measure(`entropy ${count * 8} ops: uncached`, uncached);
    await measure(`entropy ${count * 8} ops: cached`, cached);
    await measure(`observations ${observations.length}: uncached`, () => s.mergeObservationWindowAsync(pool, [{ file: "session", observations }]));
    await measure(`observations ${observations.length}: cached`, () => cache.merge(pool, [{ file: "session", observations }]));
    let next = count;
    await measure(`entropy + pool ${count * 8} ops: append one trace`, async () => {
      const added = makeTrace(next++);
      traces = [...traces, added];
      observations = [...observations, ...added.operations.flatMap(o => Object.entries(o.args).map(([key,value]) => ({ ref: o.ref, key, value })))];
      pool = (await cache.merge(pool, [{ file: "session", observations }])).file;
      await cached();
    });
  }
  const codeLines = Array.from({ length: 400 }, (_,i) => `await pi.read({path: 'file-${i}'});\n`);
  await measure("speculation 400 completed prefixes: ungated scanner", () => {
    const scanner = new s.LiteralCallScanner(); let prefix = "";
    for (const line of codeLines) { prefix += line; scanner.push(prefix); }
  });
  await measure("speculation 400 completed prefixes: bounded tap", () => {
    const original = Date.now; let now = 1000; let launches = 0;
    Date.now = () => now;
    try {
      const tap = new s.FabricSpeculationStreamTap({ enabled: () => true, maxBufferBytes: () => 100_000, isEligible: () => true, launch() { launches++; } });
      tap.setScannerFactory(() => new s.LiteralCallScanner());
      const event = (type, delta = "") => ({ assistantMessageEvent: { type, delta, contentIndex: 0,
        partial: { content: [{ type: "toolCall", name: "fabric_exec", id: "call" }] } } });
      tap.handleMessageUpdate(event("toolcall_start"), {});
      tap.handleMessageUpdate(event("toolcall_delta", '{"code":"'), {});
      for (const line of codeLines) { now += 51; tap.handleMessageUpdate(event("toolcall_delta", JSON.stringify(line).slice(1,-1)), {}); }
      tap.handleMessageUpdate({ assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall: {} } }, {});
      assert.equal(launches, 400);
    } finally { Date.now = original; }
  });
  const agentDir = path.join(root, "agent"); const sessionDir = path.join(agentDir, "sessions", "synthetic");
  fs.mkdirSync(sessionDir, { recursive: true });
  for (let i = 0; i < 5000; i++) fs.writeFileSync(path.join(sessionDir, `${i}.jsonl`), "");
  const selector = new s.BackgroundSessionSelector();
  await measure("discovery 5000 files: full scan", () => s.machineSessionFilesAsync(agentDir));
  await measure("discovery 5000 files: cached selection", () => selector.select(agentDir, undefined));
  console.log(JSON.stringify({ runtime: process.version, arch: process.arch, synthetic: true, repeats: 5, rows }, null, 2));
} finally { fs.rmSync(root, { recursive: true, force: true }); }
