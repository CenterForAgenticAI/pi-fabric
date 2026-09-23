import { describe, expect, it } from "vitest";
import { resourceConflict, resourceNormalize, resourceSource } from "../src/verified/generated/kernel.js";
import { boundedEffectResources, decodeResourceScope, encodeResourceNames } from "../src/verified/resources.js";
import { effectConflictsBetween, summarizeEffects } from "../src/components/effect-policy.js";

const source = (names: readonly unknown[] | undefined) => resourceSource(encodeResourceNames(names));
const normalize = (names: readonly unknown[] | undefined, proposal: readonly unknown[]) => resourceNormalize(source(names), encodeResourceNames(proposal));
const decoded = (names: readonly unknown[] | undefined, proposal: readonly unknown[]) => decodeResourceScope(normalize(names, proposal));
const rawConflict = (left: readonly unknown[] | undefined, right: readonly unknown[] | undefined, lo: boolean, ro: boolean): boolean => {
  const unknown = (names: readonly unknown[] | undefined) => !names?.length || names.some(name => typeof name !== "string" || !name.length || name === "*");
  return (lo || ro) && (unknown(left) || unknown(right) || left!.some(name => right!.includes(name)));
};

describe("verified full-declaration resource policy", () => {
  it("checks the omitted 65th identity against the original, not a producer count", () => {
    const original = [...Array.from({ length: 64 }, (_, i) => `r${i}`), "shared"];
    const normalized = normalize(original, original.slice(0, 64));
    expect(normalized).toEqual({ $: "Unknown" });
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
    expect(decoded(["a"], Array(65).fill("a"))).toEqual(["*"]);
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
      expect(resourceNormalize(normalized, encodeResourceNames(proposal))).toEqual(normalized);
      const names = decodeResourceScope(normalized);
      expect(boundedEffectResources(names)).toEqual(names);
    }
    const sixtyFour = Array.from({ length: 64 }, (_, i) => `r${i}`);
    expect(boundedEffectResources(sixtyFour)).toEqual(sixtyFour);
  });
  it("preserves every UTF-16 code unit, including NUL and lone surrogates", () => {
    const units = Array.from({ length: 65536 }, (_, i) => String.fromCharCode(i)).join("");
    expect(decodeResourceScope({ $: "Exact", names: encodeResourceNames([units]) })).toEqual([units]);
    const names = ["\0", "\0*", "a\0b", "\ud800", "\udfff", "\ufffd", "😀", "é", "e\u0301"];
    for (const left of names) for (const right of names) {
      expect(resourceConflict(source([left]), source([right]), true, false)).toBe(left === right);
      expect(boundedEffectResources([left, right])).toEqual([...new Set([left, right])]);
    }
  });
  it("matches unbounded raw semantics and preserves conflicts for arbitrary proposals", () => {
    const originals: Array<readonly unknown[] | undefined> = [undefined, [], [""], ["*"], [0], ["a"], ["b"], ["a", "b"], ["a", "a"], ["a".repeat(257)]];
    const proposals = [[], ["a"], ["b"], ["a", "b"], ["extra"], ["*"], ["a".repeat(256)]];
    const cases = originals.map(names => ({ names, raw: source(names), normalized: proposals.map(proposal => normalize(names, proposal)) }));
    for (const left of cases) for (const right of cases) for (const lo of [false, true]) for (const ro of [false, true]) {
      const conflict = resourceConflict(left.raw, right.raw, lo, ro);
      expect(conflict).toBe(rawConflict(left.names, right.names, lo, ro));
      for (const nl of left.normalized) for (const nr of right.normalized) if (conflict) expect(resourceConflict(nl, nr, lo, ro)).toBe(true);
    }
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
