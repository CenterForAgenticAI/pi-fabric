---
name: fabric-memory
description: Search past Pi sessions, inspect their entry structure, and read integrity-bound evidence with the Fabric memory provider.
disable-model-invocation: true
---

# Fabric memory

Use the provider for previous decisions, session history and prior failures.
For facts available in the current repository, inspect files or git history.

Read `<skill-dir>/../../../docs/memory-recall.md` for the full contract.
Inspect exact schemas with `tools.describe({ ref: "memory.recall" })` and the
corresponding `memory.outline`, `memory.expand`, or `memory.sessions` ref.
`memory.walk` is a TypeScript guest helper, not a provider action.

## Scope and branches

Recall defaults to the current session. Specify `scope: "project"` or
`scope: "global"` for past sessions, or `scope: "session:<id-or-path>"` for one.
Branches default to the active parent-linked path; `branches: "all"` includes
abandoned branches. Keep the branch mode on follow-up calls.

```ts
const result = await memory.recall({
  query: "release failure", scope: "global", pageSize: 5,
});
for (const hit of result.hits) {
  // Entry hits expand; cold session hits recall within that session.
  const evidence = await tools.call(hit.follow);
  print(evidence);
}
if (result.next) print(await tools.call(result.next));
```

Pass `follow` and `next` intact. Their arguments bind the source hash and
lineage; rebuilding a selector from a snippet drops these checks.

## Structure before text

```ts
const catalog = await memory.sessions({ scope: "project" });
const session = catalog.sessions?.[0]?.file;
if (session) {
  const outline = await memory.outline({ session, role: "user" });
  const first = outline.entries[0];
  if (first) print(await memory.expand({
    session, indices: [first.index], role: "user",
    expectedSourceHash: outline.sourceHash,
    expectedLineageFingerprint: outline.lineageFingerprint,
  }));
}
```

Outline returns at most 200 rows. `total` counts matching rows before the cap;
`entryCount` counts the unfiltered session. Check `truncated` and `coverage`.
Expand supports exact indices, entry IDs, operation addresses or an inclusive
`entryRange`. `before` and `after` require exactly one anchor. `role` filters
the resolved selection and is retained in `next.args`.

```ts
const catalog = await memory.sessions({ scope: "project" });
const session = catalog.sessions?.[0]?.file;
if (session) await memory.walk({ session, role: "user" }, async (entry) => {
  print({ index: entry.index, text: entry.text });
});
```

Walk reassembles text chunks. Returning `false` stops early; the last visited
index is then not evidence of the session's end.

## Shared sources and coverage

Use `memory.sessions({ source: "archive" })` for a configured source. Pass its
session key or displayed file into source-qualified reads; do not assume a
local scope includes another source. There is no filesystem fallback when
`source` is set. Do not combine it with `scope: "global"`.

Literal recall matches any term by default; `queryMatch: "all"` requires all
terms in a hot entry. `queryMode: "phrase"` and `"regex"` have different cold
coverage limits. A cold candidate is navigation, not full-entry evidence.

An empty result with `coverage.complete === false` is not a no-match proof.
Inspect reasons, narrow the search, or read the selected session directly.
A stale-pointer refusal means repeat discovery and use its new binding.
For expanded entries check `textRange.complete` and follow `next` until null.
Keep projections small; do not parse session JSONL to bypass these checks.
