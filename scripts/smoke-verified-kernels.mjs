#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ActionRegistry } from "../dist/core/action-registry.js";
import { compileFabricSummary } from "../dist/compaction/hook.js";
import * as kernel from "../dist/verified/generated/kernel.js";

const root = new URL("../", import.meta.url);
for (const file of ["kernel.js", "kernel.d.ts", "manifest.json"]) {
  assert.equal(readFileSync(new URL(`src/verified/generated/${file}`, root), "utf8"), readFileSync(new URL(`dist/verified/generated/${file}`, root), "utf8"));
}
assert.equal(kernel.footprintFits(65n, 64n, true), false);
assert.equal(kernel.pointerCurrent(true, false), false);
assert.equal(kernel.headReadable(true, true, false, true, false), false);
assert.equal(kernel.useNormalized(true, true, true, true), false);
assert.deepEqual(kernel.consume(true), { $: "Tuple", fst: true, snd: false });

const registry = new ActionRegistry();
let entered;
let release;
const active = new Promise((resolve) => { entered = resolve; });
const gate = new Promise((resolve) => { release = resolve; });
let secondRan = false;
registry.register({
  name: "proofsmoke", description: "Bundled conflict gate smoke",
  async list() { return []; },
  async describe(name) {
    return { name, description: name, inputSchema: { type: "object", additionalProperties: false }, risk: "write",
      effect: { kind: "transactional", ordering: "ordered", resources: name === "hold"
        ? [...Array.from({ length: 64 }, (_, i) => `r${i}`), "shared"] : ["shared"] } };
  },
  async invoke(name) {
    if (name === "hold") { entered(); await gate; } else secondRan = true;
    return name;
  },
});
const invoke = (name) => registry.invoke(`proofsmoke.${name}`, {}, {
  cwd: fileURLToPath(root), signal: undefined, parentToolCallId: "proof-smoke", nestedToolCallId: name,
  extensionContext: {}, update() {}, approve: async () => {}, audits: [], maxResultChars: 1000, effectPolicy: "strict",
});
const held = invoke("hold");
try {
  await active;
  await assert.rejects(invoke("second"), /unknown resource footprint/);
  assert.equal(secondRan, false);
} finally {
  release();
  await held;
  await registry.close();
}

const entries = ["first request", "next request"].map((text, i) => ({
  type: "message", id: `e${i}`, parentId: i === 0 ? null : "e0", timestamp: "2026-01-01T00:00:00Z",
  message: { role: "user", content: text, timestamp: i },
}));
const summary = compileFabricSummary(entries, 100);
assert.ok("compaction" in summary);
assert.ok(Buffer.byteLength(summary.compaction.summary) <= 32_768);
console.log("Bundled artifact identity, registry conflict refusal, compaction, and kernel behavior verified.");
