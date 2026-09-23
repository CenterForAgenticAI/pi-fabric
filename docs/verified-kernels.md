# Verified policy kernels

Fabric executes JavaScript compiled from `proofs/kernel.bend`. This is not a
parallel reference model: the production acceptance points call that generated
code. TypeScript retains host integration, source observation, optimized
candidate production, and diagnostics. There is no handwritten fallback when a
kernel rejects a candidate.

`LAWS.bend` is the specification review boundary. `PROOF.bend` supplies the
proofs. Review changes to the laws independently of changes to implementations;
never weaken a claim just to make a changed implementation check. These initial
specifications still need human review. Independent predicates in the law file
prevent changing the kernel's condition builder from silently changing its law.

## Acceptance ledger

All six candidate areas have a production bridge. The proof boundary is a set
of small policy kernels, **not a proof of every subsystem invariant**.

| Area | Executed/checked policy | Authoritative production path | Evidence |
| --- | --- | --- | --- |
| Effect independence | Exact named/unknown conflict decisions; symmetry of unknown conflict; exact footprints require valid bounded metadata | `components/effect-policy.ts`, `components/effect-scope.ts`, `core/action-registry.ts` | `footprint_sound`, `unknown_conflict_exact`, `unknown_conflict_symmetric`, `known_conflict_exact`; policy/registry/component regression tests |
| Component lifecycle | Publication eligibility requires current epoch/owner, non-retirement, open supervisor; ordinary provider close requires retirement and no owners/retainers/calls; one-use disposer admission; cleanup failure chooses quarantine | `components/supervisor.ts`, `core/provider-bindings.ts`, `components/effect-scope.ts` | `transition_sound`, `close_sound`, `cleanup_failure_quarantines`, `consume_retires`; existing async lifecycle tests |
| Compaction | Every successful proposed cut satisfies eligibility, prior-marker ordering, estimated tail budget and every matched call/result span; rendered byte/estimated-token bounds; retained-plus-omitted sample accounting | `compaction/hook.ts`, `compaction/bounds.ts` | `span_sound`, `spans_sound`, `cut_sound`, `summary_bounds`, `sample_accounting`; compaction and bridge tests |
| Memory | Active selection cannot admit a non-member unless all-branch selection is explicit; source/lineage bindings must both match; chunks have exact lengths, contiguous offsets, truthful completion and progress; truncated coverage cannot be complete | `memory/normalize.ts`, `memory/expand-service.ts`, `memory/digest.ts`, `memory/index.ts` | `active_lineage_only`, `explicit_all_lineages`, `pointer_sound`, `chunk_sound`, `coverage_sound`; source-bound pagination/lineage/integrity tests |
| Entropy normal forms | Canonical arguments stay original; candidate acceptance requires a proved plan, an actual change, and acceptance by the unchanged schema | `entropy/normal-form.ts` | `normalization_sound`, `canonical_identity`; identity/idempotence/forged-plan tests |
| State and Schema | Pending protocol-2 heads need a commit marker; valid committed heads survive marker eviction; certificate checks all hold; consumption produces an inactive token | `state/store.ts`, `schema/controller.ts` | `head_sound`, `pending_without_marker_hidden`, `committed_head_visible`, `certificate_sound`, `consume_once`, `consume_retires`; state/schema protocol tests |

`all_sound` and `all_complete` establish the conjunction checker by induction,
not just a finite truth table. `spans_sound` separately lifts per-span evidence
over arbitrary finite lists. Tests enumerate small domains and exercise large
numeric values to check the compiler ABI and TypeScript boundary; those tests
are not presented as universal proofs.

### Conservative footprints

An exact footprint preserves full resource identities. Missing, invalid,
wildcard, overlong (>256 UTF-16 code units), or oversized (>64 distinct names)
metadata becomes `["*"]`. Names are never shortened and excess names are never
dropped. This changes the previous lossy behavior: a conflict at position 65
can no longer disappear. Both registry call policy and component lifetime
policy share normalization and conflict decisions.

The TypeScript adapter counts distinct identities, supplies the flags, and
constructs the diagnostic resource list. Those observations are trusted adapter
code, covered by direct and production-path regression tests. The proofs do not
show that an author has truthfully declared every real resource or that a
`commutative` label describes the actual host effect.

### Producer/checker boundaries

The compactor's optimized TypeScript selector still proposes cuts. `computeCut`
checks every successful result, including the legacy and compact-all paths,
before it can become `firstKeptEntryId`. Checks use the live entries and complete
call/result span set. Span batches of at most 128 bound backend list
construction; every batch must pass. Candidate-selection optimality is still
test-backed, not formally proved. Token guarantees concern the structural
estimator and supplied calibration, not an undocumented provider tokenizer.

Memory checks the actual outgoing page **after** envelope trimming. The bridge
compares each text chunk with the selected normalized source slice, checks its
range through Bend, and checks the proposed continuation against the resulting
cursor. Source reads/hashes, parent-graph reconstruction, normalization,
Unicode slicing and page composition remain host responsibilities. The exact
claim concerns normalized text, not byte-for-byte JSONL reconstruction. A source
or lineage change fails closed rather than reinterpreting an old pointer.

Entropy's schema validator and plan derivation remain TypeScript. Their actual
results feed the compiled acceptance decision; the original object is returned
on refusal. Validated output plus the canonical-identity gate establishes the
operational idempotence argument under the validator assumption. This is not a
proof of TypeBox or of JavaScript numeric-string conversion.

Schema's eight evidence facts are a fixed-length tuple at the adapter boundary.
The compiled conjunction checks all eight before mutation. The consumed status
comes from the compiled token transition and is persisted with the existing
compare-and-swap. At-most-once use across processes depends on that CAS protocol
and the mesh store, not on an in-memory Boolean alone. Filesystem rollback and
postcondition commands are not formally verified.

### Lifecycle limits

The compiled predicates own the eligibility and cleanup-outcome decisions; this
is **not** a rewrite of the asynchronous supervisor as a fully proved reducer.
Epoch allocation, faithful event observation, publication sequencing, retained
view accounting, force-close/shutdown behavior, inverse-stack LIFO/once-only
execution, and fairness are still TypeScript protocols checked by integration
tests. Arbitrary inverses, ambient effects, liveness, schedule confluence, and
author-defined observational equivalence are not claimed as Bend theorems.

## Reproducible bridge

The contributor toolchain pins **Bend 2.0.25**. Installed Fabric needs neither
Bend nor a Bend loader. Linux CI downloads that exact release archive and checks
its SHA-256 before running proofs. Windows tests execute the checked-in generated
JS and ABI; native Bend currently requires Linux, macOS, or WSL.

```sh
bend PROOF.bend --check-only
bun run proof:generate    # prove, compile, regenerate JS + declarations + receipt
bun run proof:check       # reprove, reproduce byte-for-byte, reject negative mutations
bun run proof:artifact    # compiler-free source/bridge/artifact freshness check
bunx vitest run tests/verified-kernels.test.ts
bun run typecheck
bun run build
bun run proof:dist        # probe the actual bundled registry/compactor and kernel
```

`BEND_BIN` may explicitly select a trusted compiler executable. Generation sets
`BEND_NO_TELEMETRY=1`. It never installs or updates Bend automatically.

Bend's CLI emits executable JavaScript, not a library switch. A pure `IO.pure`
main keeps the kernel definitions reachable for compilation. The build bridge:

1. Checks the entire root proof file and its imported laws.
2. Refuses unsafe declarations, holes, foreign effects, remote imports, and
   untracked local proof dependencies.
3. Compiles the same kernel source that those laws import.
4. Parses the emitted program and requires the exact pinned CLI footer.
5. Removes only its two invocation statements and exports the compiler-produced
   definitions through Bend's own trampoline, checking names and arities.
6. Tree-shakes unused runtime code and rejects host IO/imports in the result.
7. Writes generated JS, ABI declarations, and a SHA-256 receipt over the proof
   sources, ABI, bridge, and generated artifacts.

No algorithm is translated into handwritten JS. The small bridge, ABI
conversions, Bend checker/compiler/Base, esbuild, and JS engine are part of the
trusted computing base. Source `Nat` values cross as nonnegative safe-integer
`BigInt`s; adapters reject NaN, infinities, fractions and unsafe integers rather
than silently truncating. Booleans and tagged records/lists follow the emitted
ABI. Tests exercise those representations on both CI platforms.

Every build checks artifact freshness before bundling. Linux CI and `prepack`
add fresh checking and byte-for-byte regeneration, so editing a receipt is not a
substitute for proving the code. The standalone generated JS, declarations and receipt are
copied into `dist/verified/generated/`. Laws, proofs, kernel source and Bend's
license are included in the package for inspection. The receipt is a freshness
record, **not a standalone independently verified proof certificate**.

Negative probes delete a proof or deliberately break footprint bounds, epoch
checks, tool-pair closure, chunk completion, canonical identity, commit-marker
visibility, and one-use consumption. The pinned compiler must reject each
mutation while the specification remains unchanged.

## What remains outside the claims

- Semantic remembering, arbitrary prose retention, retrieval ranking quality,
  secret detection, and recovery after source deletion.
- Full correctness of parsers, schemas, hashing, source observations, graph
  reconstruction, or filesystem transactions.
- Full lifecycle confluence, eventual settling, or rollback correctness for
  arbitrary provider code.
- Validation of user intent, success of host operations, and security against a
  malicious trusted host or provider.

These boundaries are deliberate. Executed kernels and mandatory result checks
remove the parallel-model gap for the specified decisions; they do not turn
unverified host observations or adapters into proved facts.
