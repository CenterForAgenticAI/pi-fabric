# Programmatic compaction

A model, skill, or peer can **ask** the host to compact its context at a safe
boundary. The request also works on a running agent's context.

One gated channel carries the request to the host. The host selects the safe
time. Fabric performs deterministic compaction without another model call,
which keeps repeated results testable. Each request records a labeled
**advisory** intent. The host later performs the **committed** context change.

## Advisory and committed steps

The model runs inside the context that it requests to compact. A direct change
during the active turn could race with in-flight tool work or unresolved state.
Fabric records the request through a typed, validated write path. An open status
path reports its state.

1. **Advisory.** `compact.request` (host) or `agents.compact` (child) only
   *records an intent*. The request never touches the context. It is a
   write-risk, schema-validated declaration: "Compact this context with these
   instructions. Reason: <reason>."

2. **Committed.** At a boundary it knows to be safe, the host forwards the
   intent to `ExtensionContext.compact()` for the host session, or to the
   child pi's `compact` RPC frame for a child. The host boundary is
   `agent_settled`: the handler awaits Pi's callback completion or error
   before Pi publishes its public settled event. For a child, the worker waits
   for the child's own `agent_settled`. It then sends a correlated compact
   request and keeps the RPC channel open until it observes both the response
   and `compaction_end`. The worker never sends compact while the child turn
   is active.

Exactly one write path leads from intent to action. The model cannot compact
the running context directly. It can only ask. The controller stores one replaceable
request. A new request replaces the pending one, so the slot always holds the
latest instructions.

## Compaction properties

| Property | Fabric behavior |
| --- | --- |
| The context is a cache for the store. | Compaction changes the cache through an explicit, labeled transition. `status()` records the intent and last commit outside the context, where they survive compaction. |
| Derived views are pure functions of the log. | `CompactStatus` reads the controller's recorded intents and commits. It never reads the compacted context itself. |
| The host enforces transition boundaries. | The model requests compaction. The host commits at `agent_settled`. `maybeCommit` and the `agent_settled` handler contain the boundary gate. |
| A task boundary can carry a compaction request. | The model selects the request time and instructions. The host selects a safe commit time. Pi core keeps its token-threshold trigger. |

## API surface

### Host session: the `compact` provider

The provider is always available, with no config guard. Fabric exposes it
through `fabric_exec` as `compact.request`, `compact.status`,
`compact.pressure`, `compact.carry`, and `compact.cancel`.

```ts
// Record an advisory intent. Replaces any pending one and returns
// immediately. The host commits it at the next agent_settled boundary.
await compact.request({
  reason: "the file map and the failing test are the only live state",
  instructions: "Keep the failing test name and the file map; drop the rest.",
  preserve: ["Auth regression is still open", "tests/auth.test.ts"], // optional
  requestedBy: "model", // optional, default "model"
  seed: "Start phase 2: wire the API", // optional, next prompt after the commit
});

// Read the pending intent and the last committed/failed compaction info.
const status = await compact.status();
// { pending?: { reason?, instructions?, preserve?, seed?, requestedBy, requestedAt },
//   last?:   { at, requestedBy, status: "committed"|"cancelled"|"failed",
//             summary?, tokensBefore?, estimatedTokensAfter?, error?, seeded? },
//   lastAuto?: { at, trigger: "headroom"|"tokens"|"ratio", committed },
//   owner: "fabric"|"pi"|"external"|"none",
//   outputReserveTokens,
//   claim?: { name, version, branchSummary, actions }, // under a claim
//   ownerStatus? }                                      // owner's own report

// Read context pressure. Never compacts; the program decides what to do.
const pressure = await compact.pressure();
// { tokens, contextWindow, fraction, headroomTokens,
//   band: "ok"|"warn"|"urgent"|"unknown", outputReserveTokens,
//   thresholdFraction?, thresholdTokens?, owner,
//   claim?: { name, version },                          // under a claim
//   ownerPressure?: { stage, thresholds? } }            // owner's ladder

// Keep a bounded focus list in every Fabric summary until it is cleared.
await compact.carry({ add: ["Auth regression is still open"] });
await compact.carry({ remove: ["Auth regression is still open"] });
await compact.carry({ clear: true });
const { items } = await compact.carry(); // no arguments reads

// Clear a pending intent before the host commits it.
await compact.cancel();
```

Risk classes: `request`, `carry`, and `cancel` are `write` (they change host
session state). `status` and `pressure` are `read`, carry no effect, and are
eligible for speculative pre-launch and for Schema enforce mode.

#### Pressure

`compact.pressure()` reads Pi's `getContextUsage()` and the active model.
`fraction` is `tokens / contextWindow`, and `headroomTokens` is
`contextWindow - tokens`. `band` compares `fraction` with
`compaction.pressureBands` (default `{ warn: 0.6, urgent: 0.8 }`). The band is
also `urgent` whenever `compaction.outputReserveTokens` is set and the
headroom is below it. When Pi has no token count, for example right after a
compaction and before the next response, the numeric fields are `null` and
the band is `unknown`. `thresholdTokens` or `thresholdFraction` reports the
active model's configured Fabric threshold; the token threshold wins when
both exist. `owner` is the [observed compaction owner](compaction.md#compaction-ownership).

#### Carry-forward focus

`compact.carry` maintains a list that Fabric's deterministic compactor renders
under `[Carry Forward]` in **every** summary until it is cleared. It is the
persistent counterpart of the one-shot `preserve` field. Arguments apply in
this order: `clear` empties the list, `items` replaces it, `remove` drops exact
matches, and `add` appends items that are not already present. The result must
fit the `preserve` limits: at most 16 non-empty items of 2048 characters and
2048 UTF-8 bytes each. A violation rejects the call and leaves the list
unchanged.

Fabric persists each change as a `pi-fabric-compact-carry` session custom
entry. The latest entry on the active branch is the current list, so reload,
restart, and tree navigation restore it without extra state, and a branch
keeps its own list. A malformed latest entry reads as an empty list. Custom
entries never enter the model context. The rendered block is bounded to
3 KiB like the request block; compaction details record
`carry: { count, renderedOmittedBytes }`. With `compaction.engine: "pi"`, or
when an extension wins compaction by load order without a claim, the list is
stored but not rendered. Under a [compaction owner claim](#compaction-owner-claim)
the list belongs to the owner and Fabric stores nothing.

With only `instructions` present, Fabric forwards it as ordinary Pi
`customInstructions`. Manual `/compact` text and programmatic requests then
get the same Fabric rendering. When `preserve` is present, the controller
encodes `{version: 1, instructions?, preserve}` behind an exact versioned
prefix plus JSON. The compaction and branch hooks strictly decode that shape
and render valid bounded values under `[Compaction Request]`. On tree
navigation, Pi's explicit `replaceInstructions: true` mode delegates to
Pi/default summarization. Fabric cannot execute an arbitrary replacement
summarizer prompt, so it produces no typed Fabric branch details in that mode.

The prefix is reserved. Malformed JSON or scalars, duplicate decoded protocol
keys (including escaped aliases), unknown fields or versions, invalid types,
unpaired UTF-16 surrogates, excessive structure, or exceeded limits return a
structured decode error and cancel the operation. Fabric never falls back to
prose for such a payload. A bounded structural parser performs these checks
before canonicalization, and it never uses regex to recover protocol
data. Fabric never renders a rejected payload. A context with UI/RPC notification support
receives a bounded error. The exact `__pi_vcc__` value keeps its
compaction-routing precedence, and it has no special effect on the tree hook.

`compact.request` validates its input with a bounded TypeBox schema before
argument mapping. Instructions cap at 8192 characters and 8192 UTF-8 bytes.
`preserve` accepts at most 16 items, and each item caps at 2048 characters and
2048 UTF-8 bytes. The complete encoded prefix-plus-JSON request must fit
within 16 KiB. The decoder checks aggregate source bytes before structural
parsing, then validates duplicate keys, scalars, and surrogate pairing while
parsing. It checks the preserve count before iterating or canonicalizing
items. Ordinary manual and Pi instructions remain bounded explicit text and
never become typed protocol input.

The rendered request block is separately bounded to 3 KiB. Complete items are
kept when they fit; otherwise each item receives an excerpt with an explicit
UTF-8 byte-loss marker. Compaction details set `instructionPolicy.truncated`
for rendering loss too, and `renderedOmittedBytes` records its size. Input
validation limits are not a promise that every accepted byte appears inline.

`preserve` is **one-shot**, not a persistent task ledger: it applies to this
compaction and is not automatically carried into the next one. Recent dialogue
has its own protected projection; `state.goal` remains an executable predicate,
not an automatically inferred conversational objective.

#### Commit semantics

- The host's `agent_settled` handler awaits `maybeCommit(context)`. It never
  runs mid-turn or while a turn is in flight. The returned Promise settles on
  `onComplete`, `onError`, a synchronous startup throw, or a pre-start abort.
- The call is a no-op when nothing is pending. Reentrant calls share the
  in-flight Promise and never start a second compaction.
- Fabric accepts a new `request()` during an in-flight commit, and that
  request replaces the pending intent. The in-flight commit proceeds with the
  intent it captured.
  On completion it clears *that* intent by identity, and any newer intent
  waits for the next settled boundary.
- On pi's `onComplete`, Fabric clears the intent and `last` records
  `status: "committed"` with the summary and token counts.
- On pi's `onError` with `"Compaction cancelled"`, `"Already compacted"`,
  or `"Nothing to compact (session too small)"`, Fabric clears the intent
  and `last` records `status: "cancelled"` with the raw pi message in
  `error`. No compaction happened. The too-small message is Pi rejecting a
  manual compaction whose session sits below `keepRecentTokens`, so every
  message would be kept anyway. The outcome stays observable without
  being silently dropped. Only exact messages are benign: an error merely
  containing one of the phrases stays `failed`.
- On any other error, Fabric clears the intent and `last` records
  `status: "failed"` with the message. A synchronous throw from `compact()`
  itself follows the same failure path.
- A `seed` (at most 8192 characters) is sent only after `onComplete`, as
  a plain user message with no slash-command or template expansion. Pi
  defers a prompt sent during `agent_settled` until the settle finishes, so
  the seed starts the next turn on the compacted context. `last.seeded` is
  `true` once Pi accepted it. A cancelled or failed commit never sends it.
  The seed applies to Fabric's own controller whatever summarizer runs,
  including `compaction.engine: "pi"`. A program's request then means the
  same thing with or without a claim; under a claim the owner receives the
  seed and decides when to send it.

### Compaction owner claim

Another extension can take compaction from Fabric without
`compaction.engine: "pi"`, which would also hand `/tree` summaries to Pi.
The owner emits `pi-fabric:compaction-owner:v1`
(`FABRIC_COMPACTION_OWNER_EVENT` in `pi-fabric/protocol`) from its
`session_start` handler or later:

```ts
import {
  FABRIC_COMPACTION_OWNER_EVENT,
  type FabricCompactionOwnerClaimV1,
  type FabricCompactionOwnerHandleV1,
} from "pi-fabric/protocol";

let claim: FabricCompactionOwnerHandleV1 | undefined;
const lifetime = new AbortController();
pi.events.emit(FABRIC_COMPACTION_OWNER_EVENT, {
  version: 1,
  type: "claim",
  owner: { name: "pi-context-aware", version: "1.4.0" },
  actions: {
    request: { fields: ["instructions", "preserve", "seed"], handler: (request, ctx) => focus(request) },
    carry: { fields: ["items", "add", "remove", "clear"], handler: (update, ctx) => ({ items: carry(update) }) },
    status: { handler: (ctx) => ({ stage: ladder.stage }) },
    pressure: { handler: (ctx) => ({ stage: ladder.stage, thresholds: { fold: 0.7, compact: 0.9 } }) },
    cancel: { handler: (ctx) => cancelPending() },
  },
  // branchSummary: true, // also take /tree summaries
  signal: lifetime.signal,
  reply: (result) => {
    if (result.ok) claim = result.handle;
    else ctx.ui.notify(result.error, "warning");
  },
} satisfies FabricCompactionOwnerClaimV1);
// No reply: Fabric is not loaded.
```

While the claim is held:

- Fabric's `session_before_compact` handler returns nothing, before its
  threshold deferral. Fabric produces no summary and never cancels the
  owner's compaction. The owner's own `session_before_compact` handler
  decides; when it returns nothing, Pi's summarizer runs.
- Fabric's settled-boundary threshold and headroom trigger stay off.
- `/tree` summaries stay with Fabric's configured engine unless the claim
  sets `branchSummary: true`.
- `compact.request`, `compact.carry`, and `compact.cancel` go to the owner.
  Fabric validates arguments as usual, then passes a fresh copy holding only
  the fields the owner declared. An undeclared action or field fails with an
  error naming the owner (`compaction owner pi-context-aware@1.4.0: ...`),
  and nothing is recorded, stored, or forwarded. `request` returns
  `{ requested: true, intent, claim, result? }`; `intent` describes what
  went to the owner, and Fabric records none of it. `carry` handlers return
  `{ items }`. `cancel` also clears an intent Fabric recorded before the
  claim.
- `compact.status` adds `claim: { name, version, branchSummary, actions }`
  and, when the owner supports `status`, `ownerStatus`. `compact.pressure`
  adds `claim` and `ownerPressure: { stage, thresholds? }` beside Fabric's
  band. Fabric omits its own `thresholdFraction` and `thresholdTokens`
  there because they do not trigger under a claim.
- Owner handler results must be JSON of at most 16 KiB. A handler that throws
  or returns an invalid shape fails the call with the owner's name.
- An expected owner result does not raise Fabric's ownership warning.

The handle's `fallback(event, ctx, { carry? })` returns Fabric's
deterministic summary for a `session_before_compact` event: the same
compiler, enrichers, and budget as Fabric's own hook, as
`{ ok: true, compaction }` or `{ ok: false, reason }`. Return
`{ compaction }` from the owner's handler when its model summary fails.
`carry` replaces Fabric's stored carry list and must fit the
`compact.carry` limits. The result carries Fabric's v2 details, so
`owner` reads `"fabric"` for that entry. The fallback works only while the
claim is held.

One claim at a time. A second claim gets `{ ok: false, error, holder }`,
and Fabric shows a warning that names both owners. The claim ends when:

- the holder calls `handle.withdraw()` or emits
  `{ version: 1, type: "withdraw", token: handle.token, reply? }`. Any other
  token is refused with `{ ok: false, error }` and the claim stays;
- the claim's `signal` aborts; or
- Fabric receives `session_shutdown`. Pi sends it on reload, session
  replacement (new, resume, fork), and quit, then loads every extension
  again, so the owner claims again from its next `session_start`.

Withdrawal restores Fabric's engine, thresholds, and `compact.*` behavior.
Fabric validates the claim and copies only named fields: `owner.name` and
`owner.version` (printable text, at most 128 and 64 characters), the five
known actions with their handlers and known fields, `branchSummary`, and
`signal`. Unknown keys, actions, or fields are rejected with a reply naming
the problem.

### Agent compaction: `agents.compact`

```ts
const handle = await agents.spawn({
  task: "Audit auth flows.",
  tools: ["read", "grep", "find", "ls"],
});

// Advisory: the worker queues this until the child is fully settled.
await agents.compact({ id: handle.id, instructions: "Keep the finding list." });

return await agents.wait({ id: handle.id });
```

- Fabric appends the request to the same `<runDir>/steer.jsonl` channel as
  `agents.steer`. The orchestrator, or any peer through the mesh relay, can
  request a child compaction without stopping or respawning the child, and the
  child keeps its accumulated context.
- The worker tails `steer.jsonl` and never forwards compact during an active
  child turn. It waits for `agent_settled`, then sends
  `{"id":"...","type":"compact","customInstructions":"..."}`, with the
  instructions field omitted when absent. See pi's [RPC `compact`](https://github.com/earendil-works/pi-coding-agent/blob/main/docs/rpc.md).
- The worker correlates the compact response by `id`. It observes the matching
  compaction lifecycle through `compaction_end`, records queued, in-flight,
  completed, or failed status, and only then closes stdin for one-shot
  shutdown. The worker records a rejected response, an aborted compaction,
  or a `compaction_end.errorMessage` as failed, and the child turn keeps
  running.
- Multiple requests that wait before the boundary coalesce into one request
  with the latest instructions. Requests that arrive during an in-flight
  compaction merge into one deterministic follow-on request before shutdown.
- Fabric **rejects Claude-runner children** with a clear error. The official
  Claude Code CLI exposes no compact RPC, so a fresh run is the only way to
  reset a Claude child's context. Compaction is a Pi-runner primitive.
- Risk class: `agent`.

## Audit and observability

- **Activity surface**: `compact.request` and `agents.compact` emit
  `context.activity` updates (entity + progress) inside the `fabric_exec` call
  that issued them, following the existing provider pattern. Host commits and
  child enqueues show up in the dashboard and widget.
- **Mesh**: when the mesh is enabled, the host controller publishes
  best-effort events to the durable `fabric.compact` topic on each transition.
  Recorded intents publish `kind: "requested"`, and settled intents publish
  `kind: "committed" | "cancelled" | "failed"`. Pi's benign
  `"Compaction cancelled"`, `"Already compacted"`, and `"Nothing to
  compact (session too small)"` outcomes publish with `kind: "cancelled"`.
  Other Fabric participants, such as persistent actors
  and peer sessions, can subscribe to observe compaction transitions.
  Activity-only sessions with the mesh disabled silently skip this step.
- **Status query**: `compact.status()` gives the context-independent,
  in-memory record of the pending intent, the last commit, and the last
  threshold or headroom compaction (`lastAuto`) for the current initialized
  extension session. The record survives compaction itself. Extension
  reload, session replacement, process restart, and shutdown clear it.
  `owner` and the carry list are derived from the session log and survive
  all of these.

## Configuration

None required. Programmatic compaction is a first-principles primitive and
always available. Fabric defines no `compact` config block. The
model decides when and how to ask, and the host decides when to commit, so
safety needs no configuration. The optional `compaction.pressureBands` and
`compaction.outputReserveTokens` keys tune what `compact.pressure()` reports;
see [compaction](compaction.md#headroom-trigger).

## Files

| File | Role |
| --- | --- |
| `src/core/compact-controller.ts` | Pending-intent controller with `request`, `cancel`, `status`, and `maybeCommit`. Uses a single replaceable slot, typed preserve encoding, an in-flight guard, and a quiet clear on benign no-op outcomes (cancelled, already compacted, or session too small). |
| `src/providers/compact-provider.ts` | Fabric provider that exposes a bounded TypeBox-validated `request` (write, including optional `preserve: string[]`), `status` (read), `pressure` (read), `carry` (write), and `cancel` (write). Registered always, with activity audit. |
| `src/compaction/pressure.ts` | Pure pressure projection from Pi's context usage, the active model, and config. |
| `src/compaction/carry.ts` | Carry-forward entry codec, update semantics, and summary lines. |
| `src/compaction/owner.ts` | Compaction owner classification and the once-per-session ownership warning. |
| `src/compaction/claim.ts` | Compaction owner claim registry: one holder, token withdrawal, abort-signal and shutdown release, and the deterministic fallback. |
| `src/protocol.ts` | `pi-fabric:compaction-owner:v1` message types and the validating, field-copying reader. |
| `src/fabric-state.ts` | Constructs the controller with mesh-publish hooks, registers the provider, and resets on re-init or shutdown. |
| `src/index.ts` | Invokes `state.compact.maybeCommit(context)` in the existing `agent_settled` handler. |
| `src/agents/types.ts` | Extends `AgentSteerEntry["type"]` with `"compact"` and adds the optional `instructions` field. |
| `src/agents/manager.ts` | `compact(id, instructions?)` appends a compact entry through the steer channel and rejects Claude-runner children. |
| `src/worker.ts` | Feeds compact controls into the child boundary coordinator and observes Pi RPC lifecycle events. |
| `src/agents/compact-control.ts` | Coalesces child requests, waits for `agent_settled`, correlates the compact response with `compaction_end`, records the outcome, and gates one-shot stdin close. |
| `src/providers/agents-provider.ts` | `agents.compact({id, instructions?})` action (risk: agent) with activity audit. |
