import { describe, expect, it } from "vitest";
import * as kernel from "../src/verified/generated/kernel.js";
import {
  acceptCompactionCut, acceptMemoryChunk, acceptSampleAccounting, acceptSummaryBounds,
  assertCertificateFacts, bendList, boundedEffectResources,
} from "../src/verified/policy.js";
import { acceptsExpansionPage } from "../src/verified/memory.js";
import { effectConflictsBetween, registrationEffect, summarizeEffects } from "../src/components/effect-policy.js";
import { sampleAddressed } from "../src/compaction/bounds.js";

const booleans = (size: number): boolean[][] => Array.from({ length: 2 ** size }, (_, mask) =>
  Array.from({ length: size }, (_, bit) => (mask & (1 << bit)) !== 0));

// These are ABI/refinement checks of the emitted implementation, not substitutes
// for the universal Bend proofs. In particular they exercise native JS numbers,
// constructor fields, BigInts, and the adapter's actual source observations.
describe("compiled Bend policy bridge", () => {
  it("matches lifecycle, coverage, pointer, normalizer, and head truth tables", () => {
    for (const row of booleans(5)) {
      const [a, b, c, d, e] = row as [boolean, boolean, boolean, boolean, boolean];
      expect(kernel.transitionCurrent(a, b, c, d)).toBe(!a && b && c && !d);
      expect(kernel.canClose(a, b, c, d)).toBe(a && !b && !c && !d);
      expect(kernel.cleanupState(a, b)).toBe(a ? 2 : b ? 1 : 0);
      expect(kernel.pointerCurrent(a, b)).toBe(a && b);
      expect(kernel.coverageComplete(a, b)).toBe(a && !b);
      expect(kernel.lineageSelected(a, b)).toBe(a || b);
      expect(kernel.useNormalized(a, b, c, d)).toBe(!a && b && c && d);
      expect(kernel.headReadable(a, b, c, d, e)).toBe(a && b && (c || (d && e)));
      expect(kernel.knownConflict(a, b, c)).toBe(a && (b || c));
    }
  });

  it("matches every unknown-footprint combination symmetrically", () => {
    for (const row of booleans(6)) {
      const [lu, luo, lo, ru, ruo, ro] = row as [boolean, boolean, boolean, boolean, boolean, boolean];
      const expected = (lu && (luo || ro)) || (ru && (ruo || lo));
      expect(kernel.unknownConflict(lu, luo, lo, ru, ruo, ro)).toBe(expected);
      expect(kernel.unknownConflict(ru, ruo, ro, lu, luo, lo)).toBe(expected);
    }
  });

  it("never loses a late conflicting resource or treats wildcard as a literal name", () => {
    const many = [...Array.from({ length: 64 }, (_, i) => `r${i}`), "shared"];
    expect(boundedEffectResources(many)).toEqual(["*"]);
    expect(boundedEffectResources(["x".repeat(257)])).toEqual(["*"]);
    expect(boundedEffectResources(["", "a"])).toEqual(["*"]);
    expect(boundedEffectResources(["*"])).toEqual(["*"]);
    expect(boundedEffectResources(["a", "a", "b"])).toEqual(["a", "b"]);
    expect(boundedEffectResources(undefined)).toEqual(["*"]);
    const summarize = (resources: string[]) => summarizeEffects([registrationEffect({ resources, ordering: "ordered" })]);
    expect(effectConflictsBetween(summarize(many), summarize(["shared"]))).toEqual([
      { resources: ["*"], reason: "unknown_resource" },
    ]);
  });

  it("checks numeric comparisons without U32 truncation and fails malformed Nat boundaries closed", () => {
    for (const count of [0, 1, 63, 64, 65, 2 ** 32, Number.MAX_SAFE_INTEGER]) {
      expect(kernel.footprintFits(BigInt(count), 64n, true)).toBe(count <= 64);
      expect(acceptSummaryBounds(count, count, count, count)).toBe(true);
      expect(acceptSummaryBounds(count + 1, count, 0, 0)).toBe(false);
    }
    for (const bad of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(acceptSampleAccounting(bad, 0, 0, 0)).toBe(false);
      expect(acceptSummaryBounds(bad, 32_768, 0, 0)).toBe(false);
    }
  });

  it("rejects a crossing pair, stale marker, ineligible cut, or oversize tail, including late batches", () => {
    const base = { eligible: true, afterPrevious: true, retained: 9, budget: 10, boundary: 5 };
    const safe = { first: 0, last: 4, hasCall: true, hasResult: true };
    const cross = { ...safe, last: 5 };
    expect(acceptCompactionCut(base, [safe])).toBe(true);
    expect(acceptCompactionCut(base, [cross])).toBe(false);
    expect(acceptCompactionCut(base, [{ ...cross, hasResult: false }])).toBe(true);
    expect(acceptCompactionCut({ ...base, eligible: false }, [])).toBe(false);
    expect(acceptCompactionCut({ ...base, afterPrevious: false }, [])).toBe(false);
    expect(acceptCompactionCut({ ...base, retained: 11 }, [])).toBe(false);
    expect(acceptCompactionCut(base, [...Array.from({ length: 10_000 }, () => safe), cross])).toBe(false);
    expect(acceptCompactionCut(base, [{ ...safe, first: -1 }])).toBe(false);
  });

  it("conserves addressed samples over all small sizes and limits", () => {
    for (let total = 0; total <= 30; total++) for (let limit = 0; limit <= 12; limit++) {
      const source = Array.from({ length: total }, (_, i) => ({ entryId: `e${i}` }));
      const sample = sampleAddressed(source, limit);
      expect(acceptSampleAccounting(total, sample.values.length, sample.omitted, limit)).toBe(true);
      expect(sample.values.length + sample.omitted).toBe(total);
      if (sample.omitted > 0) {
        expect(source.some((entry) => entry.entryId === sample.omittedFirstEntryId)).toBe(true);
        expect(source.some((entry) => entry.entryId === sample.omittedLastEntryId)).toBe(true);
      }
    }
    expect(acceptSampleAccounting(10, 4, 5, 4)).toBe(false);
  });

  it("checks chunk continuity, exact completion, and progress", () => {
    for (let total = 0; total < 8; total++) for (let start = 0; start <= total; start++) for (let end = start; end <= total; end++) {
      const range = { start, end, total, complete: end === total };
      expect(acceptMemoryChunk(range, end - start, start, total)).toBe(end > start || end === total);
      expect(acceptMemoryChunk({ ...range, complete: !range.complete }, end - start, start, total)).toBe(false);
      expect(acceptMemoryChunk(range, end - start, start + 1, total)).toBe(false);
    }
    expect(acceptMemoryChunk({ start: 0, end: 1, total: 2, complete: false }, 2, 0, 2)).toBe(false);
  });

  it("checks post-trimming text against source and verifies the actual continuation", () => {
    const source = [{ index: 4, text: "a😀bc" }];
    const first = { index: 4, text: "a😀", textRange: { start: 0, end: 3, total: 5, complete: false } };
    expect(acceptsExpansionPage([first], source, 0, 0, { position: 0, textOffset: 3 })).toBe(true);
    const last = { index: 4, text: "bc", textRange: { start: 3, end: 5, total: 5, complete: true } };
    expect(acceptsExpansionPage([last], source, 0, 3, { position: 1, textOffset: 0 })).toBe(true);
    expect(acceptsExpansionPage([{ ...first, text: "bad" }], source, 0, 0, { position: 0, textOffset: 3 })).toBe(false);
    expect(acceptsExpansionPage([first], source, 0, 0, { position: 1, textOffset: 0 })).toBe(false);
    expect(acceptsExpansionPage([], source, 0, 0, { position: 0, textOffset: 0 })).toBe(false);
  });

  it("requires every certificate condition and consumes an active token only once", () => {
    for (const row of booleans(8)) {
      expect(kernel.certificateAccepted(bendList(row))).toBe(row.every(Boolean));
      const fact = (i: number) => ({ valid: row[i]!, error: `condition ${i}` });
      const facts = [fact(0), fact(1), fact(2), fact(3), fact(4), fact(5), fact(6), fact(7)] as const;
      if (row.every(Boolean)) expect(() => assertCertificateFacts(facts)).not.toThrow();
      else expect(() => assertCertificateFacts(facts)).toThrow(`condition ${row.indexOf(false)}`);
    }
    expect(() => assertCertificateFacts([] as unknown as Parameters<typeof assertCertificateFacts>[0])).toThrow("Invalid Schema");
    const first = kernel.consume(true);
    expect(first).toEqual({ $: "Tuple", fst: true, snd: false });
    expect(kernel.consume(first.snd)).toEqual({ $: "Tuple", fst: false, snd: false });
  });
});
