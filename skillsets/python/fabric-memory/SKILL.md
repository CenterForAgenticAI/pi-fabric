---
name: fabric-memory
description: Search past Pi sessions, inspect their entry structure, and read integrity-bound evidence with the Fabric memory provider.
disable-model-invocation: true
---

# Fabric memory

Use the provider for previous decisions, session history and prior failures.
For facts available in the current repository, inspect files or git history.

Read `<skill-dir>/../../../docs/memory-recall.md` for the provider contract;
translate its examples into Python dictionaries as below. Inspect exact schemas
with `tools.describe({"ref": "memory.recall"})` and the corresponding
`memory.outline`, `memory.expand`, or `memory.sessions` ref.
Use explicit paging loops in this kernel, not TypeScript callback helpers.

## Scope and branches

Recall defaults to the current session. Specify `scope: "project"` or
`scope: "global"` for past sessions, or `scope: "session:<id-or-path>"` for one.
Branches default to the active parent-linked path; `branches: "all"` includes
abandoned branches. Keep the branch mode on follow-up calls.

```python
result = await memory.recall({
    "query": "release failure", "scope": "global", "pageSize": 5,
})
for hit in result["hits"]:
    # Entry hits expand; cold session hits recall within that session.
    print(await tools.call(hit["follow"]))
if result.get("next"):
    print(await tools.call(result["next"]))
```

Pass `follow` and `next` intact. Their arguments bind the source hash and
lineage; rebuilding a selector from a snippet drops these checks.

## Structure before text

```python
catalog = await memory.sessions({"scope": "project"})
for session in catalog.get("sessions", [])[:1]:
    outline = await memory.outline({"session": session["file"], "role": "user"})
    if outline["entries"]:
        row = outline["entries"][0]
        page = await memory.expand({
            "session": session["file"], "indices": [row["index"]], "role": "user",
            "expectedSourceHash": outline["sourceHash"],
            "expectedLineageFingerprint": outline["lineageFingerprint"],
        })
        while True:
            print(page["entries"])
            if not page.get("next"):
                break
            page = await tools.call(page["next"])
```

Outline returns at most 200 rows. `total` counts matching rows before the cap;
`entryCount` counts the unfiltered session. Check `truncated` and `coverage`.
Expand supports exact indices, entry IDs, operation addresses or an inclusive
`entryRange`. `before` and `after` require exactly one anchor. `role` filters
the resolved selection and is retained in `next.args`.
Expanded entries can be partial: `textRange` names the returned text interval.
Follow `next` and join chunks with the same entry index when full text is needed.
Stopping early is not evidence of the session's end.

## Shared sources and coverage

Use `memory.sessions({"source": "archive"})` for a configured source. Pass its
session key or displayed file into source-qualified reads; do not assume a
local scope includes another source. There is no filesystem fallback when
`source` is set. Do not combine it with `scope: "global"`.

Literal recall matches any term by default; `queryMatch: "all"` requires all
terms in a hot entry. `queryMode: "phrase"` and `"regex"` have different cold
coverage limits. A cold candidate is navigation, not full-entry evidence.

An empty result with `coverage.complete == False` is not a no-match proof.
Inspect reasons, narrow the search, or read the selected session directly.
A stale-pointer refusal means repeat discovery and use its new binding.
Keep projections small; do not parse session JSONL to bypass these checks.
