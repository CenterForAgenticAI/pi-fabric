# Background tasks and monitors

Fabric-managed `pi.bash` and `pi.powershell` commands have session-owned job IDs.
`background: true`, the shell hang threshold, or Ctrl+B twice detaches a command;
an explicit shell `timeout` remains a hard cap. Completed jobs have terminal states
(`exited`, `failed`, `killed`, `timed_out`), not the old `spilled` state. `exited`
means exit code zero, not that the user's assignment is verified.

```ts
const result = await pi.bash({cmd: "bun run build", background: true, description: "Build bundle"});
return result; // details.taskId, pid, logPath when detached
```

Completion sends a bounded, batched automated event to the **owning Pi session**.
The same mechanism works inside a Fabric-enabled child: it does not route child
shell output directly into the parent's Main. No LLM is used to wait for a process.
Events are outcomes, not user input or approval. Idle wakeups do not compete with
already queued messages. Aborted/error turns suspend wakeups until new user input;
branch navigation discards delivery from old-frontier jobs. Session shutdown/reload
closes the inbox before aborting jobs, so cleanup cannot start a new turn.
Print-mode processes do not stay alive indefinitely just to receive late events.

## Agent awareness and yielding

Before each model request, Fabric projects one bounded live-task reminder into
context, independently of the returned `fabric_exec` value. Even if a program
discards the nested shell result, the owning agent can see that work is running.
The reminder is reconstructed from live session state after context compaction;
it is not a persisted transcript entry and **never triggers a turn** itself.
Unchanged task state keeps the same message; elapsed time and process output do
not churn it. It includes at most eight task IDs and short, quoted labels, with
an omitted count for additional jobs.

For ordinary detached commands and wake-enabled monitors, it tells the agent to
continue independent work or **end the turn if it needs their results**. Completion
(or a matching monitor event) can resume the owning agent; polling and sleep loops
are unnecessary. UI-only monitors are explicitly marked **no automatic wakeup**,
including on completion, so the agent must not yield expecting them to resume it.
Pending required results are not evidence that the assignment is complete.

Foreground, completed, stopping, and abandoned-branch jobs are excluded. Abort/error
suspension suppresses the reminder until new input, just like automatic delivery.
Reload/session shutdown removes the context hook along with the inbox. Awareness
works without a terminal and does not restore processes across Pi restarts.

## Inspection and control

- `/fabric tasks` or **Ctrl+Alt+T** opens the lazy inspector. A single task opens
  directly. `/fabric tasks <id-or-unique-prefix>` opens a specific task.
- The widget shows up to three tasks, elapsed time, and the command or short
  description. It stays alive after the Fabric program returns. Completion hints
  expire after 30 seconds; retained jobs remain in the inspector.
- Enter opens detail; arrows/PageUp/PageDown scroll the bounded output tail; G
  follows the tail; x twice within three seconds stops; Esc backs out/closes.
- Elapsed time and time since last output are separate. A quiet shell is not
  automatically classified as stuck. Opening/closing the inspector doesn't stop it.
- `ui.enabled` and `ui.widget` retain their existing meaning. Rendering is TUI-only;
  task tools and notifications do not require a terminal.

Tasks are a discoverable provider, **not a new sandbox global**:

```ts
return await tools.call({ref: "tasks.list", args: {}});
return await tools.call({ref: "tasks.get", args: {id: taskId}});
return await tools.call({ref: "tasks.stop", args: {id: taskId}});
```

`get` returns metadata and an 8KB output tail and acknowledges pending agent delivery.
`stop` targets a stored job's abort controller, never an arbitrary or recycled PID.
Stopping a task does not wake the agent. Tasks are local to this runtime; IDs and
live processes are not restored across Pi restarts. Up to 256 completed handles
are retained for at most 24 hours. Logs use Fabric's private scratch retention.
The 1MiB in-memory tail and 8MiB disk log limits remain unchanged: a log is **not a
full-output archive**, and truncation is disclosed.

## Opt-in monitors

```ts
return await pi.bash({
  cmd: "./scripts/watch-ci.sh", // emits a line only when something interesting changes
  description: "Watch CI",
  monitor: {
    delivery: "wake", // REQUIRED: "ui" or "wake"
    match: "CI:",     // optional case-sensitive literal substring, not regex
    timeoutMs: 300000,
    intervalMs: 5000,
  },
});
```

A monitor implies background execution; `background: false` is rejected. The
ordinary shell runner, extension hooks, middleware filters, approvals and explicit
shell timeout still apply. `delivery: "ui"` only updates task inspection, including
completion; it never wakes the model. `"wake"` additionally delivers coalesced line
events and completion to the owning agent. Main configures/starts/stops/renews the
watch, while the process does the polling or subscribes to an external source.
Unchanged polls require **zero LLM turns** when the script emits nothing.

Limits:

- Five-minute default lifetime; 1 second minimum, 30 minutes maximum. Expiration
  stops the command and produces one terminal outcome. Renewal is a new explicit
  call; there is no automatic restart or hidden supervisor LLM.
- At most eight concurrent monitors per session. Output batches are spaced by
  `intervalMs` (1–60 seconds, default 5 seconds). This is a **delivery** interval,
  not the script's polling interval.
- UTF-8 chunks are framed incrementally. Lines retain their first 2048 characters;
  matching applies to that bounded prefix. Empty lines and adjacent duplicate
  matching lines are suppressed. Events keep at most eight 500-character previews
  per batch; overflow is disclosed. A busy owner receives the newest batch per
  task, not every historical line. Retained raw output is available in the log.
- Main interruption cancels monitors and suppresses automatic wakeups. Ordinary
  detached commands retain their existing lifetime; their outcomes wait for input.
- Events and output are untrusted data. `wake` can incur model turns; use `ui` for
  human-only observation and emit only meaningful changes for agent-facing watches.

Opaque captured shell overrides do not gain Fabric monitors: Fabric must not bypass
an SSH backend or security gate. Compatible [bash middleware](shell-middleware.md)
keeps its filtering/protection. PowerShell monitors require the host's tracked shell
operations API. The tasks provider is installed with the native Pi provider in full
code mode (and schema enforce, whose authorization rules still apply), not in
orchestration-only mode or closed-world managed hosts.
