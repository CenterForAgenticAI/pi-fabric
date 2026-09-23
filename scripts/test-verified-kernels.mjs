#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const env = { ...process.env, BEND_NO_TELEMETRY: "1" };
const bend = process.env.BEND_BIN || "bend";
if (execFileSync(bend, ["version"], { encoding: "utf8", env }).trim() !== "bend 2.0.25") throw new Error("Bend 2.0.25 required");
const inputs = JSON.parse(readFileSync(join(root, "src/verified/generated/manifest.json"), "utf8")).inputs;
const originals = Object.fromEntries(Object.keys(inputs).filter((path) => path.endsWith(".bend")).map((path) => [path, readFileSync(join(root, path), "utf8")]));
const mutations = [
  ["deny valid sources", "proofs/resources.bend", "select(nonempty(names) && identitiesValid(names, True{}), names)", "Unknown{}"],
  ["lost original resource", "proofs/resources.bend", "covered(original, candidate, True{}) && covered(candidate, original, True{})", "True{} && covered(candidate, original, True{})"],
  ["injected resource", "proofs/resources.bend", "covered(original, candidate, True{}) && covered(candidate, original, True{})", "covered(original, candidate, True{}) && True{}"],
  ["truncated identity", "proofs/resources.bend", "case Nil{} Con{h, t}:\n      False{}", "case Nil{} Con{h, t}:\n      equal"],
  ["oversized candidate", "proofs/resources.bend", "bounded(candidate, 64n)", "bounded(candidate, 65n)"],
  ["overlong identity", "proofs/resources.bend", "nameBounded(name, 256n)", "nameBounded(name, 257n)"],
  ["forgotten unknown", "proofs/resources.bend", "case Unknown{}:\n      Unknown{}", "case Unknown{}:\n      Exact{Nil{}}"],
  ["dropped effect group", "proofs/resources.bend", "groups(t, ys, found || against(ys, h, False{}))", "groups(t, ys, found)"],
  ["deny every exact footprint", "proofs/resources.bend", "case True{}:\n      Exact{candidate}", "case True{}:\n      Unknown{}"],
  ["invalid source admitted", "proofs/resources.bend", "select(nonempty(names) && identitiesValid(names, True{}), names)", "select(True{}, names)"],
  ["open law", "PROOF.bend", "def Laws.canonical_identity(plan, changed, accepted):\n  {==}", ""],
  ["footprint overflow", "proofs/kernel.bend", "all(footprintConditions(count, limit, valid))", "True{}"],
  ["stale lifecycle publication", "proofs/kernel.bend", "[Bool.not(retired), epoch, owner, Bool.not(closed)]", "[Bool.not(retired), True{}, owner, Bool.not(closed)]"],
  ["crossing tool pair", "proofs/kernel.bend", "Bool.not(paired) || Nat.is_le(boundary, first) || Nat.is_lt(last, boundary)", "True{}"],
  ["false chunk completion", "proofs/kernel.bend", "Bool.not(Bool.xor(complete, Nat.is_eq(end, total)))", "True{}"],
  ["canonical mutation", "proofs/kernel.bend", "all(normalizationConditions(canonical, plan, changed, accepted))", "True{}"],
  ["uncommitted visibility", "proofs/kernel.bend", "committed || (pending && marker)", "committed || pending"],
  ["invalid head version", "proofs/kernel.bend", "all([sequence, version, committed || (pending && marker)])", "all([sequence, True{}, committed || (pending && marker)])"],
  ["reusable certificate", "proofs/kernel.bend", "(active, False{})", "(active, True{})"],
];
const temp = mkdtempSync(join(tmpdir(), "fabric-bend-negative-"));
try {
  mkdirSync(join(temp, "proofs"));
  for (const [name, path, before, after] of mutations) {
    if (!originals[path].includes(before)) throw new Error(`Mutation anchor disappeared: ${name}`);
    for (const [file, source] of Object.entries(originals)) {
      writeFileSync(join(temp, file), file === path ? source.replace(before, after) : source);
    }
    const result = spawnSync(bend, [join(temp, "PROOF.bend"), "--check-only"], { encoding: "utf8", env, timeout: 30_000 });
    const output = (result.stdout ?? "") + (result.stderr ?? "");
    if (result.error || result.signal || result.status !== 1 || !/Error:/.test(output) || /unknown:|a declared constructor|syntax/i.test(output)) {
      throw new Error(`Expected a proof rejection for ${name}, got ${result.status}: ${result.error ?? output}`);
    }
  }
  console.log(`${mutations.length} negative proof probes rejected invalid kernels/open laws without changing the specification.`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
