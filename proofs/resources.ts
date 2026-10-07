// Effect resource scopes. A resource name is interned to a natural: 0 is the
// empty (or malformed) name, 1 is the wildcard "*", and every other string gets
// its own id. A scope is a set of ids; `Len` carries each name's UTF-16 length.
// The codec interns a proposal's names first, so ids 2..65 hold up to 64 names.
import { all, bool, everyKey, nat, oneOf, rule, when, yes } from "gdp-wired";
import type { Kernel } from "./kernel.js";

export const EMPTY = 0, WILDCARD = 1, LIMIT = 64, NAMES = 2 + LIMIT, LENGTH = 256;

export type ResourceBug =
  | "skips backward coverage" | "admits the wildcard" | "keeps an unknown source"
  | "admits long names" | "ignores the bound" | "commutative effects conflict" | "unknown scopes are independent";

/* eslint-disable @typescript-eslint/no-explicit-any */
const same = (a: any, b: any) => everyKey((k) => a.at(k).eq(b.at(k)));

export const scope = (bug?: ResourceBug) => rule("resource scope")
  .inputs({ op: oneOf("source", "normalize"), first: nat })
  .state({ exact: 0 })
  .maps({ Names: 0 })
  .carries("Given", "Len")
  .flags(({ Given, Len, Names }) => ({
    bits: everyKey((k) => Given.at(k).atMost(1)),
    identities: everyKey((k) => Given.has(k).implies(k.ne(EMPTY).and(bug === "admits the wildcard" ? yes : k.ne(WILDCARD)))),
    // One condition per key: the candidate names exactly the scope, and each
    // name is a valid identity within the 64-name window and 256 code units.
    fits: everyKey((k) => (bug === "skips backward coverage" ? Names.has(k).implies(Given.has(k)) : Given.has(k).iff(Names.has(k)))
      .and(Given.has(k).implies(all(k.ne(EMPTY), k.ne(WILDCARD), bug === "ignores the bound" ? yes : k.lt(NAMES), bug === "admits long names" ? yes : Len.at(k).atMost(LENGTH))))),
  }))
  .flags(({ op, exact, first, Given, identities, fits }) => ({
    accepted: Given.has(first).and(op.match({
      source: () => identities,
      normalize: () => (bug === "keeps an unknown source" ? yes : exact.eq(1)).and(fits),
    })),
  }))
  .assume(({ bits }) => bits)
  .step(({ accepted, Given, Names }) => ({
    exact: when(accepted, 1, 0),
    Names: Names.each((k) => when(accepted, Given.at(k), 0)),
  }));

export const conflict = (bug?: ResourceBug) => rule("resource conflict")
  // `witness` names a shared resource for the completeness law; the step never reads it.
  .inputs({ leftEffect: bool, rightEffect: bool, leftExact: bool, rightExact: bool, leftOrdered: bool, rightOrdered: bool, witness: nat })
  .state({ conflict: 0 })
  .carries("Left", "Right")
  .flags(({ Left, Right }) => ({
    bits: everyKey((k) => Left.at(k).atMost(1).and(Right.at(k).atMost(1))),
    shared: Left.disjointFrom(Right).not(),
    // The specification's disjointness, stated apart from `shared`; the step never reads it.
    apart: everyKey((k) => Left.has(k).implies(Right.has(k).not())),
  }))
  .assume(({ bits }) => bits)
  .step(({ leftEffect, rightEffect, leftExact, rightExact, leftOrdered, rightOrdered, shared }) => ({
    conflict: when(all(leftEffect, rightEffect, bug === "commutative effects conflict" ? yes : leftOrdered.or(rightOrdered),
      bug === "unknown scopes are independent" ? leftExact.and(rightExact, shared) : leftExact.and(rightExact).not().or(shared)), 1, 0),
  }));

export const resourceKernels = (bug?: ResourceBug): Kernel[] => {
  const s = scope(bug), c = conflict(bug);
  const valid = (Names: any, first: any) => Names.has(first).and(everyKey((k) => Names.has(k).implies(k.ne(EMPTY).and(k.ne(WILDCARD)))));
  return [{
    id: "resourceScope",
    rule: s,
    laws: [s.law("scope names are a set", ({ Names }) => everyKey((k) => Names.at(k).atMost(1)))],
    stepLaws: [
      s.stepLaw("resource_source_refinement: an exact source keeps every declared name, and only those",
        ({ Given }, a) => a.exact.eq(1).implies(same(a.Names, Given)), ({ op }) => op.is("source")),
      s.stepLaw("resource_source_valid: an exact source is nonempty, with no empty or wildcard identity",
        ({ first }, a) => valid(a.Names, first), ({ op, accepted }) => op.is("source").and(accepted)),
      s.stepLaw("resource_source_complete: every nonempty source of valid identities is exact",
        ({ Given }, a) => a.exact.eq(1).and(same(a.Names, Given)), ({ op, first, Given, identities }) => op.is("source").and(Given.has(first), identities)),
      s.stepLaw("resource_refinement: normalization keeps a scope's names in both directions or widens it to unknown",
        ({ exact, Names }, a) => a.exact.eq(1).implies(exact.eq(1).and(same(a.Names, Names))), ({ op }) => op.is("normalize")),
      s.stepLaw("resource_output_valid: an exact normal form is nonempty, at most 64 valid names of at most 256 code units",
        ({ first, Len }, a) => valid(a.Names, first).and(everyKey((k) => a.Names.has(k).implies(k.atLeast(2).and(k.lt(NAMES), Len.at(k).atMost(LENGTH))))),
        ({ op, accepted }) => op.is("normalize").and(accepted)),
      s.stepLaw("resource_unknown: a refused scope is unknown and names nothing",
        (_, a) => a.exact.eq(0).and(everyKey((k) => a.Names.at(k).eq(0))), ({ accepted }) => accepted.not()),
      s.stepLaw("resource_precision: a valid bounded set-equivalent proposal is accepted as given (so the identity proposal is unchanged)",
        ({ Given }, a) => a.exact.eq(1).and(same(a.Names, Given)), ({ op, exact, first, Given, fits }) => op.is("normalize").and(exact.eq(1), Given.has(first), fits)),
      // resource_recheck_idempotent: a first normalization's output is valid,
      // bounded and equal to its proposal (output_valid, refinement), so a recheck
      // with the same proposal is precision's identity case.
    ],
  }, {
    id: "resourceConflict",
    rule: c,
    stepLaws: [
      c.stepLaw("resource_pair_sound: quiet effects never conflict, nor do two commutative ones",
        (_, a) => a.conflict.eq(0), ({ leftEffect, rightEffect, leftOrdered, rightOrdered }) => leftEffect.and(rightEffect, leftOrdered.or(rightOrdered)).not()),
      c.stepLaw("resource_conflict_exact: exact disjoint scopes never conflict",
        (_, a) => a.conflict.eq(0), ({ leftExact, rightExact, apart }) => all(leftExact, rightExact, apart)),
      c.stepLaw("resource_conflict_complete: an ordered pair of effects with an unknown scope conflicts",
        (_, a) => a.conflict.eq(1), ({ leftEffect, rightEffect, leftOrdered, rightOrdered, leftExact, rightExact }) =>
          all(leftEffect, rightEffect, leftOrdered.or(rightOrdered), leftExact.and(rightExact).not())),
      c.stepLaw("resource_pair_complete: an ordered pair of effects sharing a named resource conflicts",
        (_, a) => a.conflict.eq(1), ({ leftEffect, rightEffect, leftOrdered, rightOrdered, witness, Left, Right }) =>
          all(leftEffect, rightEffect, leftOrdered.or(rightOrdered), Left.has(witness), Right.has(witness))),
    ],
  }];
};
export const RESOURCE_BUGS: ResourceBug[] = [
  "skips backward coverage", "admits the wildcard", "keeps an unknown source", "admits long names",
  "ignores the bound", "commutative effects conflict", "unknown scopes are independent",
];
