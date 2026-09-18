import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setImmediate as yieldToHost } from "node:timers/promises";
import { MemoryProvider } from "../dist/providers/memory-provider.js";
import { encodeCwdDir } from "../dist/memory/discovery.js";

const inline = process.argv.includes("--inline");
const Provider = inline ? MemoryProvider
  : (await import("../dist/memory/worker-provider.js")).WorkerMemoryProvider;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-recall-responsiveness-"));
const cwd = path.join(root, "project");
const directory = path.join(root, "sessions", encodeCwdDir(cwd));
fs.mkdirSync(directory, { recursive: true });
const files = [];
const text = "brand name business name thương hiệu tên Dịch vụ phần mềm Xuân Anh ".repeat(32);
let sourceBytes = 0;
for (let session = 0; session < 13; session++) {
  const records = [{ type: "session", version: 3, id: `session-${session}`, cwd }];
  for (let entry = 0; entry < 500; entry++) {
    records.push({
      type: "message", id: `entry-${entry}`, parentId: entry === 0 ? null : `entry-${entry - 1}`,
      timestamp: "2026-09-18T00:00:00.000Z",
      message: { role: "user", content: `${text} unique_${session}_${entry}`, timestamp: 1 },
    });
  }
  const file = path.join(directory, `${session}.jsonl`);
  const content = records.map(record => JSON.stringify(record)).join("\n") + "\n";
  fs.writeFileSync(file, content);
  sourceBytes += Buffer.byteLength(content);
  files.push(file);
}
const provider = new Provider({ agentDir: root, cwd, config: {
  enabled: true, indexDir: path.join(root, "index"), maxSessions: 100,
  maxEntryChars: 2_000, hotSessions: 0,
} });
const invocation = {
  cwd, signal: undefined, parentToolCallId: "recall-benchmark", nestedToolCallId: "recall",
  extensionContext: {}, update() {},
};
try {
  // Seed derived cold caches before measuring repeated single-session hydration.
  await provider.invoke("recall", { scope: "project", query: "brand" }, invocation);
  await yieldToHost();
  const started = performance.now();
  let previous = started;
  let maxEventLoopGapMs = 0;
  let heartbeatTicks = 0;
  const heartbeat = setInterval(() => {
    const now = performance.now();
    maxEventLoopGapMs = Math.max(maxEventLoopGapMs, now - previous);
    previous = now;
    heartbeatTicks++;
  }, 10);
  try {
    const results = await Promise.all(files.map(file => provider.invoke("recall", {
      scope: `session:${file}`, query: "brand name business name thương hiệu tên", pageSize: 3,
    }, invocation)));
    const recallMs = performance.now() - started;
    const ticksWhilePending = heartbeatTicks;
    await yieldToHost();
    maxEventLoopGapMs = Math.max(maxEventLoopGapMs, performance.now() - previous);
    if (results.some(result => result.hits.length !== 3 || result.total !== 500)) {
      throw new Error("Recall changed exact matching or pagination");
    }
    console.log(JSON.stringify({
      mode: inline ? "inline" : "worker", sessions: files.length, sourceBytes,
      recallMs: Math.round(recallMs), heartbeatTicks: ticksWhilePending,
      maxEventLoopGapMs: Math.round(maxEventLoopGapMs),
    }, null, 2));
    if (!inline && ticksWhilePending === 0) throw new Error("Recall starved the host event loop");
  } finally {
    clearInterval(heartbeat);
  }
} finally {
  await provider.close?.();
  fs.rmSync(root, { recursive: true, force: true });
}
