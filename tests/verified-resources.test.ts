import { describe, expect, it } from "vitest";
import {
  boundedEffectResources, decodeResourceScope, resourceConflictOf as resourceConflict, resourceNormalize, resourceSource,
} from "../src/verified/resources.js";
import { effectConflictsBetween, summarizeEffects } from "../src/components/effect-policy.js";

const source = (names: readonly unknown[] | undefined) => resourceSource(names);
const normalize = (names: readonly unknown[] | undefined, proposal: readonly unknown[]) => resourceNormalize(names, proposal);
const decoded = (names: readonly unknown[] | undefined, proposal: readonly unknown[]) => decodeResourceScope(normalize(names, proposal));
describe("verified full-declaration resource policy", () => {
  it("checks the omitted 65th identity against the original, not a producer count", () => {
    const original = [...Array.from({ length: 64 }, (_, i) => `r${i}`), "shared"];
    const normalized = normalize(original, original.slice(0, 64));
    expect(normalized).toEqual({ exact: false, names: [] });
    expect(resourceConflict(source(original), source(["shared"]), true, false)).toBe(true);
    expect(resourceConflict(normalized, source(["shared"]), true, false)).toBe(true);
    expect(boundedEffectResources(original)).toEqual(["*"]);
  });
  it("rejects shortened, omitted, injected, empty, wildcard, and over-budget proposals", () => {
    expect(decoded(["a", "b"], ["a"])).toEqual(["*"]);
    expect(decoded(["a"], ["a", "injected"])).toEqual(["*"]);
    expect(decoded(["path:abcdef"], ["path:abc"])).toEqual(["*"]);
    expect(decoded(["a"], [])).toEqual(["*"]);
    expect(decoded(["a"], ["*"])).toEqual(["*"]);
    // The bound counts distinct names: repeated entries are one name of the set.
    expect(decoded(["a"], Array(65).fill("a"))).toEqual(["a"]);
    const distinct = Array.from({ length: 65 }, (_, i) => `r${i}`);
    expect(decoded(distinct, distinct)).toEqual(["*"]);
    expect(decoded(distinct.slice(0, 64), distinct.slice(0, 64))).toEqual(distinct.slice(0, 64));
    expect(decoded(["a".repeat(257)], ["a".repeat(256)])).toEqual(["*"]);
    expect(decoded(["a".repeat(257)], ["a".repeat(257)])).toEqual(["*"]);
    expect(decoded(["a".repeat(256)], ["a".repeat(256)])).toEqual(["a".repeat(256)]);
    expect(decoded(["*", "a"], ["a"])).toEqual(["*"]);
    expect(decoded([null, "a"], ["a"])).toEqual(["*"]);
  });
  it("admits exact set-preserving deduplication and rechecks idempotently", () => {
    const original = ["b", "a", "b"];
    expect(decoded(original, ["b", "a"])).toEqual(["b", "a"]);
    expect(decoded(original, ["a", "b"])).toEqual(["a", "b"]);
    for (const proposal of [["b", "a"], ["a", "b"], ["b"], []]) {
      const normalized = normalize(original, proposal);
      const names = decodeResourceScope(normalized);
      expect(resourceNormalize(names, proposal)).toEqual(normalized);
      expect(boundedEffectResources(names)).toEqual(names);
    }
    const sixtyFour = Array.from({ length: 64 }, (_, i) => `r${i}`);
    expect(boundedEffectResources(sixtyFour)).toEqual(sixtyFour);
  });
  it("preserves every UTF-16 code unit, including NUL and lone surrogates", () => {
    const units = Array.from({ length: 65536 }, (_, i) => String.fromCharCode(i)).join("");
    expect(decodeResourceScope(source([units]))).toEqual([units]);
    expect(decoded([units], [units])).toEqual(["*"]);
    const names = ["\0", "\0*", "a\0b", "\ud800", "\udfff", "\ufffd", "😀", "é", "e\u0301"];
    for (const left of names) for (const right of names) {
      expect(resourceConflict(source([left]), source([right]), true, false)).toBe(left === right);
      expect(boundedEffectResources([left, right])).toEqual([...new Set([left, right])]);
    }
  });
  it("maps source classifications and ordering fields into conflict decisions", () => {
    // Universal refinement and conflict laws live in proofs/resources.ts. These
    // fixed vectors exercise the interning codec and both ordering positions.
    const cases = [
      [["a"], ["a"], true, false, true],
      [["a"], ["b"], true, true, false],
      [["a"], ["a"], false, false, false],
      [["*"], ["b"], true, false, true],
      [["a"], ["*"], true, false, true],
      [undefined, ["a"], false, true, true],
      [[], ["a"], false, false, false],
      [[0], ["a"], false, true, true],
    ] as const;
    for (const [left, right, lo, ro, expected] of cases) {
      expect(resourceConflict(source(left), source(right), lo, ro)).toBe(expected);
    }
    expect(resourceConflict(normalize(["a", "b", "a"], ["b", "a"]), source(["a"]), true, false)).toBe(true);
    expect(resourceConflict(normalize(["a", "b"], ["a"]), source(["b"]), true, false)).toBe(true);
  });
  it("handles long declarations without backend recursion overflow", () => {
    expect(boundedEffectResources(Array(20_000).fill("same"))).toEqual(["same"]);
    expect(boundedEffectResources([...Array(20_000).fill("same"), "late"])).toEqual(["same", "late"]);
    expect(boundedEffectResources(Array.from({ length: 20_000 }, (_, i) => `r${i}`))).toEqual(["*"]);
  });
  it("uses full effect declarations rather than diagnostic summary flags", () => {
    const left = summarizeEffects([{ label: "left", kind: "transactional", ordering: "ordered", resources: ["shared"] }]);
    const right = summarizeEffects([{ label: "right", kind: "transactional", ordering: "commutative", resources: ["shared"] }]);
    left.hasEffects = false;
    left.hasNoncommutative = false;
    left.resourceNoncommutative.clear();
    right.resourceNoncommutative.clear();
    expect(effectConflictsBetween(left, right)).toEqual([{ resources: ["*"], reason: "unknown_resource" }]);
  });
  it("finds late group conflicts and keeps quiet/all-commutative effects independent", () => {
    const quiet = { label: "quiet", kind: "none" as const, ordering: "unknown" as const, resources: ["*"] };
    const effect = (name: string, ordered = true) => ({ label: name, kind: "transactional" as const, ordering: ordered ? "ordered" as const : "commutative" as const, resources: [name] });
    const left = [...Array(30).fill(quiet), effect("left"), effect("shared")];
    const right = [...Array(30).fill(quiet), effect("right"), effect("shared", false)];
    expect(effectConflictsBetween(summarizeEffects(left), summarizeEffects(right))).toEqual([{ resources: ["shared"], reason: "shared_resource" }]);
    expect(effectConflictsBetween(summarizeEffects([quiet]), summarizeEffects([effect("a")]))).toEqual([]);
    expect(effectConflictsBetween(summarizeEffects([effect("*", false)]), summarizeEffects([effect("a", false)]))).toEqual([]);
  });
});
