# Jev: typed System One programs

Jev supplies small semantic judgments, not autoregressively generated text. Fabric lets the reasoning LLM author a TypeScript program and input/output schemas, then run that program in a persistent QuickJS context. The program may observe, ask Jev, act, maintain local state, and loop without another reasoning-model turn.

For guided authoring, invoke `/skill:fabric-jev <task>`. It is user-opt-in and available in both kernel skill trees. Python callers use `tools.call` dictionaries; the Jev program artifact itself remains TypeScript in QuickJS, without changing the outer Fabric kernel. See [skills](skills.md).

## Authentication

On Pi 0.85.1 or newer, `/login jev` prompts privately for a TypeSafe API key and stores an ordinary API-key credential under `jev` in Pi's `auth.json`. `/logout` removes it. Jev registers an **auth-only provider with no chat models**; it does not appear as a selectable text-generating model.

Resolution order:

1. Pi's provider authentication (`auth.json`, then `TYPESAFE_API_KEY`, including supported Pi runtime overrides).
2. `TYPESAFE_API_KEY` directly when running without Pi's auth service.
3. An explicitly configured host-side command, if neither is available.

For Localterm, set this in your trusted `fabric.json` (never put the resolved secret into model-visible code):

```json
{
  "jev": {
    "credentialCommand": ["localterm", "secret", "get", "typesafe_api_key"]
  }
}
```

The command uses argv, not a shell. It runs only when inference needs a key, with a timeout and bounded private output. Successful command credentials are cached until provider reload. Pi credentials are resolved afresh, so login/logout changes are honored. The key is never placed in the guest, request body, browser, or returned diagnostics. HTTP errors expose status codes, not response bodies or headers. Requests use the fixed TypeSafe HTTPS endpoint and reject redirects.

`await jev.status()` reports configuration presence without running the command or making an authentication request. `verified: false` means this status operation did not verify a credential; presence does not prove validity. Missing auth does not prevent deterministic programs from running.

## Auto-mode tool safety

Jev can also serve as the host's auto-approval classifier, independently of programs and observers. Choose **Approvals → Auto model → Jev (TypeSafe safety classifier)** in `/fabric settings`, or set `approvals.model` to `"jev/jev-latest"` and the relevant risk policies to `"auto"`. Authenticate with `/login jev`, `TYPESAFE_API_KEY`, or the trusted credential command above.

The host uses a typed Noul safety judgment, not generated text or a chat-model adapter. Only probabilities >= 0.99 auto-allow; uncertainty and errors require explicit approval. This is a probabilistic advisor, not a hard security boundary or a 99% correctness guarantee. Read [auto approval configuration](configuration.md#jev-as-the-auto-mode-classifier) for the bounded current-turn evidence, outbound data disclosure, credential behavior, timeout and usage rules. Jev remains absent from ordinary chat-model pickers.

## Direct judgments

```ts
const result = await jev.evaluate({
  state: { message: "Please refund the duplicate charge." },
  questions: {
    route: {
      type: "choice",
      instructions: "Which team should handle the request in `message`?",
      criteria: {
        billing: "Invoices, charges, refunds",
        technical: "Broken software",
        other: "None of these teams fits",
      },
    },
    refund: {
      type: "noul",
      instructions: "Does `message` explicitly request a refund?",
    },
  },
});
return { team: result.answers.route.choice, refundProbability: result.answers.refund.noul };
```

- **Choice:** selects a supplied option; returns its distribution and concentration-based confidence. Include a no-match option where needed.
- **Noul:** probability of yes; no separate confidence value.
- **Score:** probability-weighted position on 2–10 ordered descriptive levels, not necessarily a 0–1 score.
- Questions are independent and share the same state. Batch independent/speculative questions; a later answer cannot be referenced inside that same request.
- IDs are for code, not model instructions. Put the full judgment in `instructions`.
- Keep exact rules, arithmetic, source extraction, action execution, and permissions in code. Confidence is neither truth nor authorization.
- State is sent to TypeSafe. Bound and minimize browser/application data; do not send secrets or unrelated private content.

Fabric accepts up to 128 questions and 255 Choice options per question, subject to the configured request byte cap and upstream limits. Structured JSON instructions/rubrics are supported. Service failures are not automatically retried: a controller must decide whether a retry is affordable and its observation is still fresh. For HTTP 429/529, back off rather than spin.

## Foreground and background

`wait` is canonical for both providers. `jev.join({id})` aliases `jev.wait({id})`, just as `agents.join({id})` aliases `agents.wait({id})`. Each alias preserves its provider's result, cancellation, and notification behavior.

Both entry points accept `{ program, input }`; only `spawn` additionally accepts `observe`. The program is an ordinary serializable artifact that you can save and reuse.

```ts
const specification = {
  name: "route-tickets",
  inputSchema: {
    type: "array",
    items: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
  outputSchema: { type: "array", items: { enum: ["billing", "technical", "other"] } },
  requires: ["jev.evaluate"],
  limits: { timeoutMs: 60000, maxEvaluations: 20, maxToolCalls: 100, maxTokens: 20000 },
  code: `
    const routes = [];
    for (const ticket of input) {
      const judgment = await jev.evaluate({
        state: ticket,
        questions: {
          route: {
            type: "choice",
            instructions: "Which team handles the request in this ticket's text?",
            criteria: { billing: "Invoices and refunds", technical: "Broken software", other: "Neither" },
          },
        },
      });
      routes.push(judgment.answers.route.choice);
      await program.emit({ processed: routes.length });
    }
    return routes;
  `,
};
const run = await jev.run({ program: specification, input: [{ text: "I was billed twice" }] });
if (run.state !== "completed") throw new Error(run.error ?? run.state);
return run.result;
```

Use named Fabric payloads when large code strings are awkward to quote. In a Jev program:

- `input` contains the validated JSON input.
- `jev.evaluate(...)` makes typed judgments; it must be included in `requires`.
- `program.sleep(ms)` yields and is cancellable. Use it to pace polling or backoff.
- `program.emit(value)` records a bounded progress event.
- With `observe` on spawn, `program.nextEvent()` waits for Main lifecycle events without polling.
- `program.advise({eventId,message})` supplies the run ID to the policy-checked `jev.advise` action; declare that exact capability and opt into delivery.
- `tools.call({ ref, args })` and ordinary Fabric provider proxies call only exact `requires` refs. Discovery is not a way to acquire additional authority.
- The same QuickJS context persists for the whole run: local variables and data structures survive every iteration. No host imports, `process`, or direct `fetch` are available.

A reactive controller can use `while (true)` with these primitives. Observe fresh state, construct questions/candidate IDs, evaluate, verify applicability, act, and observe again. Revalidate target IDs/revisions before applying a decision. Define a no-match or escalation path. There is no mandatory model-generated planning step in the loop and no built-in 10 Hz guarantee: end-to-end rate includes observation, inference, and action latency.

```ts
const task = await jev.spawn({ program: specification, input: [{ text: "Settings crashes" }] });
// Main can do other work now.
const progress = await jev.status({ id: task.id, after: 0 });
const terminal = await jev.wait({ id: task.id });
// Or: await jev.stop({ id: task.id });
```

`run` and `wait` return a **run envelope**, not the bare output: `state`, `result` or `error`, usage, counts, logs, timestamps, and progress events. States are `running`, `completed`, `failed`, `cancelled`, or `timed_out`. Input/schema/typecheck/capability errors reject before launch; execution/output-validation failures become terminal envelopes.

Foreground cancellation cancels the run. Cancelling a `wait` only cancels that wait. A spawned run is independent of the spawning tool's cancellation once launch succeeds, but belongs to this session's Jev provider. Reload/unload/shutdown cancels it. It is **not durable across Pi restarts**, and stop is not rollback of already-issued effects.

Status retains the latest 64 events (4 KiB each); use `sequence` and `nextSequence` to detect gaps. Logs are capped at 4 KiB; program input and final JSON output are each capped at 32 KiB. Terminal runs are retained in a bounded in-memory history; old IDs eventually expire. There is no unlimited hidden transcript or per-tick reasoning agent.

## Main-turn advisors and supervisors

`jev.spawn({program,input,observe})` can subscribe to the owning Main session. This is an **event-driven sidecar**, not another reasoning agent or a polling loop. It works with mesh disabled. It is not a mesh participant, a cross-session subscription, or restart-durable storage; do not pass its run ID to `agents.subscribe`.

The program retains local state, awaits `program.nextEvent()`, asks typed questions, then records a judgment with `program.emit`. To intervene, explicitly configure `observe.delivery` and declare `jev.advise` in `requires`. `program.advise({eventId,message})` supplies the current run ID; the public equivalent is `jev.advise({id,eventId,message})`. Observer launch also requires read approval for future Main event access. Advice is an `agent`-risk emission and passes normal approvals, authorization, and pinned capability checks. Jev selects judgments; program code writes the message and policy.

The example deliberately opts into selected text and steering. The 0.9 threshold is illustrative and needs evaluation on representative tasks. For a record-only advisor, omit `delivery`, remove `jev.advise` from `requires`, and omit the `program.advise` call. Neither enabling Jev nor omitting `include` grants transcript access.

```ts
const observer = await jev.spawn({
  input: null,
  observe: {
    events: ["turn_end"], include: ["assistantText", "toolResults"],
    maxChars: 4096, queueSize: 8,
    delivery: "steer", triggerTurn: false, maxAdvice: 2,
  },
  program: {
    name: "verification-advisor",
    inputSchema: {type:"null"}, outputSchema: {type:"null"},
    requires: ["jev.evaluate", "jev.advise"],
    limits: {timeoutMs:600000, maxEvaluations:40, maxToolCalls:200, maxTokens:20000},
    code: `
  for (let i = 0; i < 40; i++) {
    const event = await program.nextEvent();
    if (event.truncated) {
      await program.emit({eventId:event.id, review:"truncated context"});
      continue;
    }
    const result = await jev.evaluate({
      state: {turn:event.payload},
      questions: {
        contradiction: {
          type: "noul",
          instructions: "Does assistantText claim completion while toolResults explicitly show an unresolved relevant failed check? Missing context alone is not evidence of failure.",
        },
      },
    });
    const probability = result.answers.contradiction.noul;
    const advice = probability >= 0.9
      ? await program.advise({eventId:event.id, message:"Check the reported failing verification before claiming completion."})
      : null;
    await program.emit({eventId:event.id, probability, advice});
  }
  return null;
`,
  },
});
return {id:observer.id, state:observer.state};
```

**Return the ID immediately. Do not wait/join an active observer inside Main's turn:** Main must finish turns to supply events. Foreground `jev.run` with `observe` is rejected. Inspect `jev.status({id})` occasionally or use `jev.stop({id})` to terminate it. Existing duration, inference, token, CPU, and host-call budgets still apply, including while waiting for an event. No automatic inference is performed by the event bridge.

### Observation and data-sharing contract

- `events`: a nonempty subset of `input`, `turn_end`, `tool_error`, `agent_end`, `agent_settled`. These are local host-event names, not mesh `pi.*` names. No replay of events before launch.
- `include`: defaults to `[]` (operational metadata only). `inputText` selects raw input-event text; `assistantText` selects the completed turn's visible text; `toolResults` selects bounded tool-result text and error metadata from `turn_end`/`tool_error`. Each applies only where that event carries it. Settlement events do not implicitly carry a transcript. Keep goals/history in bounded explicit input or the program's own prior observations.
- Never automatically includes thinking, system prompts, request headers, images, tool arguments, tool-result `details`, or session history. Common credential patterns are redacted as defense in depth, **not a guarantee that opted-in free text contains no secrets**. Obtain consent before sending selected text to TypeSafe and treat it as untrusted evidence.
- `maxChars`: 256–8,192, default 4,096, bounds the projected payload; `truncated` flags incomplete evidence. A truncated payload may be a string instead of an object. Extraction also caps content blocks and tool-result count. Do not infer success or safety from missing/truncated evidence.
- `queueSize`: 1–32, default 8; oldest queued events are dropped on overflow. `maxEventAgeMs`: 100–300,000, default 30,000; expired queued events are discarded. This is bounded best-effort observation, not a lossless audit stream. `nextEvent` allows only one pending consumer; consume/classify sequentially.
- Each event has `{id,sequence,event,source:"main",sessionId,revision,at,payload,truncated}`. `status.observation` reports subscribed events, received/consumed/dropped/queued counts, and delivered/suppressed advice; progress `status.events` remains the separate 64-entry `program.emit` ring.

### Delivery, freshness, and interruption

Delivery defaults to off. Opt into `"steer"` or `"followUp"`; `triggerTurn` defaults to false. `maxAdvice` bounds delivery attempts for the run (feedback/stale suppression does not consume a delivery attempt) (1–16, default 4). Advice must be sent before requesting the next event; it needs the last consumed event ID and must still match the latest completed-turn/task/context revision and age limit. A next turn may be in flight; a newer completed turn, real input, compaction, or cancellation invalidates old advice. The check is at enqueue time, not a guarantee that context cannot change before Main consumes a queued message.

There is at most **one delivery attempt across all Jev observers per external user input**. Automatic continuations and extension-injected input do not reset this feedback latch. Duplicate, stale, disabled, over-budget, feedback-gated, or failed deliveries return `{delivered:false,reason}`; failures are not replayed. This prevents an advisor from repeatedly waking/steering Main based on its own intervention. Additional turns may still be classified and recorded within budget. Broader separately granted tools retain their own authority; these safeguards specifically govern `jev.advise`.

Main abort (including RPC/SDK abort), Escape when `ui.haltOnEscape` is enabled, tree navigation, and provider reload/unload/shutdown cancel observing runs and discard their inboxes. Cancellation does not resurrect them on the next input; create a replacement only when requested. Ordinary non-observing spawned programs keep their existing detachment semantics. Cancelling only a wait is still not a stop, but a separate Main abort also cancels its observers. These are asynchronous post-turn advisors, **not pre-execution safety gates** and not rollback of effects already issued.

## Schemas and limits

Input and output schemas are checked at runtime. The supported JSON Schema subset is `type` (one type), `properties`, `required`, `additionalProperties`, `items`, `enum`, `const`, `anyOf`, `oneOf`, `allOf`, numeric/string/array/object min/max bounds, `description`, and `title`. References, regexes, unknown keywords, and excessive depth/size are rejected rather than silently trusted. Use `anyOf` for unions. `{}` permits any finite JSON value. Return `null` explicitly for programs without a result; `undefined` is not JSON.

Program TypeScript gets semantic diagnostics before execution. Runtime validation remains authoritative; TypeScript annotations are not a security boundary. The guest has at most 64 MiB memory (or the lower configured executor limit), 128 pending timers, and a 100 ms uninterrupted CPU limit. Awaiting host work or timers yields a fresh CPU slice; an infinite synchronous loop is terminated without freezing Pi for the whole run deadline.

Default per-run limits: **60 seconds, 100 evaluations, 1,000 host calls, 100,000 reported tokens**. `program.limits` can request different values, clamped to trusted host ceilings:

```json
{
  "jev": {
    "enabled": true,
    "model": "jev-latest",
    "requestTimeoutMs": 15000,
    "maxRequestBytes": 131072,
    "maxConcurrentRuns": 4,
    "maxRetainedRuns": 64,
    "maxDurationMs": 900000,
    "maxEvaluations": 1000,
    "maxToolCalls": 10000,
    "maxTokens": 1000000
  }
}
```

Duration can be configured up to 24 hours. Evaluation slots are reserved before dispatch, including failed requests. One evaluation may be in flight per program; batch independent questions rather than building an inference backlog. Other granted tool calls may run concurrently. Token usage is reported **after** inference: exceeding the token threshold stops the program before it can use that answer, but the final request can overshoot the threshold and still incurs charges. This is not a hard dollar-spend limit. Request-size and evaluation-count limits are the pre-dispatch bounds. Failed requests with no usage report may still have incurred upstream charges.

Every external action keeps Fabric argument validation, approvals, Schema policy, and a pinned capability generation. A restricted caller cannot widen its own capability view by spawning a program. Recursive Jev lifecycle calls are denied inside programs. Jev is unavailable in Schema enforce and managed-host modes. Other deliberately granted capabilities can be powerful: **granting `pi.bash` or an unrestricted evaluator is not a read-only sandbox** and can defeat data-isolation assumptions. Prefer narrow application connectors.

## Browser Harness JS

The optional `browser-harness` component imports your trusted Browser Harness SDK and maintains one connection. It is separate from Jev and usable through ordinary Fabric calls. Nothing scans or connects to your browser merely because Jev is enabled.

```json
{
  "components": [{
    "id": "browser",
    "component": "browser-harness",
    "config": {
      "modulePath": "../browser-harness-js/skills/cdp/sdk/session.ts",
      "wsUrl": "ws://127.0.0.1:9222/devtools/browser/REPLACE_WITH_YOUR_DEBUG_ID",
      "allowedMethods": [
        "Target.getTargets", "Target.attachToTarget",
        "Accessibility.getFullAXTree", "Runtime.evaluate", "Input.dispatchMouseEvent"
      ]
    }
  }]
}
```

Use a dedicated authorized browser/debugging endpoint. Native TypeScript loading requires a compatible Node runtime (Pi's Node 24 baseline supports the SDK's type-strippable TS). The module is trusted host code, not guest code. `autoAllow` is always false. This adapter uses explicit CDP WebSocket connections, not automatic extension-relay discovery.

```ts
await tools.call({ ref: "browser.connect" });
const attached = await tools.call({
  ref: "browser.cdp",
  args: { method: "Target.attachToTarget", params: { targetId: "YOUR_TARGET", flatten: true } },
}) as { sessionId: string };
const observation = await tools.call({
  ref: "browser.cdp",
  args: { method: "Accessibility.getFullAXTree", sessionId: attached.sessionId },
});
```

A Jev program uses `requires: ["jev.evaluate", "browser.connect", "browser.cdp"]`. Page-scoped calls require explicit `sessionId`; there is no shared active-tab pointer to race between programs. Host `allowedMethods` are enforced and become part of the pinned action descriptor. CDP is always marked `execute`, including `Runtime.evaluate`: arbitrary page JavaScript cannot be made read-only by a label. Method grants are not origin/target restrictions. Calls have a timeout and at most 16 outstanding wire requests; cancelling a sent command cannot undo its browser effect.

For tighter controls, expose a small application-specific Fabric provider instead of general CDP. Build compact records/candidate controls from observations, let Jev judge them, map selected IDs back to observed nodes in code, and verify the result. Screenshots are not part of this typed text/JSON adapter's Jev request contract.

## Verification

Offline targeted suites live in `tests/jev-*.test.ts`. Live tests are opt-in and operate only on synthetic text/observations:

```sh
PI_FABRIC_JEV_LIVE=1 bunx vitest run tests/jev-live.test.ts
# Explicitly opt into the private Localterm resolver:
PI_FABRIC_JEV_LIVE=1 PI_FABRIC_JEV_LOCALTERM=1 bunx vitest run tests/jev-live.test.ts
```

After `bun run build`, `bun run test:jev:dist` checks the compiled public entry point, auth-only registration, foreground CDP composition with a simulated session, and background stop/wait, agent/Jev join aliases, and event-driven Main advice.

No real browser state or secrets are printed by these probes. Live tests exercise all three primitives, foreground/background inference loops, and a feedback controller using changing synthetic screen observations and source control IDs. Unit tests exercise the Browser Harness adapter with an injected session; they do not attach to a personal browser.

Public host APIs and types are exported from `pi-fabric/jev`. Fabric lifecycle and trust semantics are detailed in [components.md](components.md). Current TypeSafe contracts: [API](https://docs.typesafe.ai/api), [Choice](https://docs.typesafe.ai/primitives/choice), [Noul](https://docs.typesafe.ai/primitives/noul), [Score](https://docs.typesafe.ai/primitives/score), and [confidence](https://docs.typesafe.ai/confidence).
