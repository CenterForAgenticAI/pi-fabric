import { randomUUID } from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { FabricPrewalkMode, FabricResultFormat } from "../config.js";
import {
  NESTED_TOOL_CALL_ID_PREFIX,
  type FabricCallAudit,
} from "../core/action-registry.js";
import type { CompactRequestIntent } from "../core/compact-controller.js";
import type { FabricExecutionResult } from "../execution-service.js";
import type {
  FabricInvocationActivityUpdate,
  FabricInvocationContext,
} from "../protocol.js";
import { snapshotHandoffSession } from "../agents/handoff.js";
import { queueHandoffCompletion } from "../agents/handoff-completion.js";
import { queueHandoffFailureContinuation } from "../agents/handoff-continuation.js";
import type {
  AgentSessionSeed,
  AgentToolResultMessage,
} from "../agents/types.js";
import {
  buildThinkingDigest,
  thinkingTransferPolicy,
  type ThinkingTransferInput,
} from "../agents/thinking-transfer.js";
import { MAX_PREWALK_PLAN_PROMPTS } from "./controller.js";
import type {
  FabricPrewalkBorrowedMain,
  FabricPrewalkClaim,
  FabricPrewalkPlanCheckpoint,
  FabricPrewalkReadiness,
  PrewalkContinuationMessage,
  PrewalkController,
} from "./controller.js";
import { prewalkPlanText } from "./plan.js";
import type { PrewalkFsDrift } from "./fs-drift.js";

const PREWALK_CONTINUE_PROMPT = [
  "Continue the existing task in this same session under the new executor model.",
  "Do not stop merely because the model changed or because the first mutation succeeded.",
  "Finish what the user actually asked for: complete the remaining implementation steps, check the matching call sites for consistency, and run the relevant verification before reporting completion. If the request was read-only — a plan, a review, an investigation — the deliverable is the answer, not a code change.",
  "Once the relevant checks pass, report completion once and stop: do not re-run unchanged passing checks, repeat finished closeout, or re-derive decisions already made — reopen work only for a failed check, contradicting evidence, or a changed request.",
  "Report completion with concrete identifiers — relay links, PR and issue numbers, commit hashes, and artifact paths verbatim so the user can follow up without digging.",
].join(" ");

// Frontier plan checkpoint: the boundary that would have handed off instead asks
// Main to record the approach first. Upstream prewalk nudges the plan on turn one,
// before any discovery; this lands on the mutation boundary, so the plan is written
// with the exploration already done and the reasoning still on the frontier model.
export const PREWALK_PLAN_MESSAGE_TYPE = "pi-fabric-prewalk-plan";

export const prewalkPlanPrompt = (model: string): string =>
  [
    `Prewalk plan checkpoint → ${model}: no plan is recorded for this task, so this boundary is withheld — the executor inherits only this transcript.`,
    "Raw reasoning replay is not guaranteed: when the executor cannot replay this model's thinking, a bounded advisory digest of its recent lines may be delivered with the continuation, but it is deliberation, not commitments, and does not replace the explicit plan.",
    "Record the plan now with prewalk.plan({ outcome, steps, verification, risks }) inside fabric_exec: the outcome, the remaining steps in execution order with the exact files, symbols, commands and checks, the risks and edge cases, and how each step is verified.",
    "Keep it concrete enough that a less capable model finishes without re-deriving the design. Then continue the task on this model — the handoff fires at the next successful mutation once the plan is recorded.",
  ].join(" ");

// Delivered as a steer so it lands before the next LLM call: the frontier model
// answers the checkpoint before it can touch another file. triggerTurn covers a
// boundary that ended Main's turn. Custom messages never fire `input`, so this can
// never be captured as the next prewalk task.
export const deliverPrewalkPlanCheckpoint = (
  pi: ExtensionAPI,
  checkpoint: FabricPrewalkPlanCheckpoint,
): boolean => {
  const { arm, mutation } = checkpoint;
  const files = Array.isArray(mutation.args?.files)
    ? (mutation.args.files as unknown[]).filter(
        (entry): entry is string => typeof entry === "string",
      )
    : [];
  try {
    pi.sendMessage(
      {
        customType: PREWALK_PLAN_MESSAGE_TYPE,
        content: prewalkPlanPrompt(arm.model),
        display: false,
        details: {
          mode: arm.mode,
          model: arm.model,
          trigger: mutation.ref,
          ...(arm.task ? { task: arm.task } : {}),
          ...(files.length > 0 ? { files } : {}),
        },
      },
      { deliverAs: "steer", triggerTurn: true },
    );
    return true;
  } catch {
    // A missed checkpoint must never fail the boundary; the caller reopens it.
    return false;
  }
};

// Forced continuation after a completed trajectory handoff: Main must not
// settle idle at the boundary. The executor's implementation is the source of
// truth — Main verifies it with real checks and reports, redoing nothing.
const PREWALK_TRAJECTORY_VERIFY_PROMPT = [
  "Prewalk trajectory handoff complete: the executor's implementation above is final — do not redo it.",
  "Continue now: run the relevant verification (matching test module, build, or an equivalent probe) and check the changed call sites for consistency, then summarize what the executor implemented and how the checks went.",
  "Relay concrete identifiers from the executor's report verbatim — links, PR and issue numbers, commit hashes, and file paths — so the user can follow up without expanding the tool result.",
  "If a check fails, fix only the failing part; keep the fix scoped. If this verification already happened in this turn, respond with the summary only.",
].join(" ");

// Forced reply after a trajectory handoff that settled without completing
// (failed / stopped / timed out): the terminating boundary suppresses Main's
// inference, so without a queued follow-up nobody would ever tell the user.
const PREWALK_TRAJECTORY_INCOMPLETE_PROMPT = [
  "Prewalk trajectory ended without completing: the executor's result above is final — do not redo its work.",
  "Tell the user now, briefly: how the executor ended, why, and what it still managed in the workspace — relay any links, PR and issue numbers, and commit hashes it produced verbatim.",
  "Propose the next step (retry, adjust, or continue manually) and stop; do not take over the implementation unprompted.",
].join(" ");

// Thrown-boundary variant for terminating boundaries: the handoff failed
// before its continuation even started (unavailable model, missing auth,
// queue failure). In-place failures keep the run alive and need no queued
// copy; trajectory boundaries still end the turn silently.
const PREWALK_FAILURE_PROMPT = [
  "A prewalk handoff at this boundary failed — the boundary result above is final; do not retry the handoff autonomously.",
  "Tell the user now, briefly: that the handoff failed and why (from the result above), relaying any identifiers verbatim, and propose the next step.",
  "The task stays re-armed where applicable; wait for the user's direction instead of redoing anything yourself.",
].join(" ");

export const PREWALK_ARMED_MESSAGE_TYPE = "pi-fabric-prewalk-armed";
const PREWALK_FAILURE_MESSAGE_TYPE = "pi-fabric-prewalk-failure";
const PREWALK_CONTINUE_MESSAGE_TYPE = "pi-fabric-prewalk-continue";

// Hidden boundary follow-ups queue best-effort after the handoff settles: the
// persisted boundary result stays authoritative, so a missed turn must never
// fail or mask the handoff outcome itself.
const queuePrewalkFollowUp = (
  extension: ExtensionAPI,
  customType: string,
  content: string,
  details: Record<string, unknown>,
): void => {
  try {
    extension.sendMessage(
      { customType, content, display: false, details },
      { deliverAs: "followUp", triggerTurn: true },
    );
  } catch {
    // Swallow: a missed follow-up turn must not fail the handoff.
  }
};

const prewalkTriggerField = (
  pending: PendingFabricHandoff,
): Record<string, unknown> => ({
  ref: pending.triggerRef,
  ...(pending.triggerSeq !== undefined ? { seq: pending.triggerSeq } : {}),
  ...(pending.triggerFiles && pending.triggerFiles.length > 0
    ? {
        files: pending.triggerFiles,
        ...(pending.triggerFilesTruncated
          ? { truncated: pending.triggerFilesTruncated }
          : {}),
      }
    : {}),
});

const prewalkContinuationId = (message: unknown): string | undefined => {
  if (typeof message !== "object" || message === null) return undefined;
  const custom = message as { role?: unknown; customType?: unknown; details?: unknown };
  if (custom.role !== "custom" || custom.customType !== PREWALK_CONTINUE_MESSAGE_TYPE) {
    return undefined;
  }
  if (typeof custom.details !== "object" || custom.details === null) return undefined;
  const details = custom.details as { mode?: unknown; continuationId?: unknown };
  // Identity filtering applies to in-place continuations only: they carry the
  // accept/settle lifecycle. The trajectory verify prompt shares this custom
  // type but has no continuation identity and must always reach Main.
  if (details.mode !== "in-place") return undefined;
  return typeof details.continuationId === "string" ? details.continuationId : "";
};

export const filterPrewalkContinuationMessages = <Message>(
  messages: Message[],
  accept: (continuationId: string) => boolean,
  pending?: { continuationId: string; message: Message },
): { messages: Message[]; changed: boolean } => {
  let changed = false;
  let delivered = false;
  const filtered = messages.filter((message) => {
    const continuationId = prewalkContinuationId(message);
    if (continuationId === undefined) return true;
    const keep = continuationId.length > 0 && accept(continuationId);
    if (keep) delivered = true;
    if (!keep) changed = true;
    return keep;
  });
  // Under one-at-a-time steering, pending user steers drain before the queued
  // continuation, so the executor's first requests would run without the task,
  // plan or digest (LQ1). Inject the canonical payload until the queued original
  // itself reaches a request; the accept callback marks the delivery, keeping
  // settlement keyed to the first sighting. Steer order is untouched —
  // injection only adds context the queue would deliver later anyway.
  if (!delivered && pending && accept(pending.continuationId)) {
    filtered.push(pending.message);
    changed = true;
  }
  return { messages: changed ? filtered : messages, changed };
};

// Planning directives (arm advisory, plan checkpoint) are phase-scoped
// guidance for the frontier model while its arm cycle is live. Once a handoff
// claims the arm — or the arm is off — carrying them into requests invites the
// executor to treat planning as still open. Persisted history is untouched:
// only the request projection drops them, mirroring the stale-continuation
// filter above and upstream prewalk's transient plan nudge.
const isPrewalkPlanningDirective = <Message>(
  message: Message,
): boolean => {
  const custom = message as { role?: unknown; customType?: unknown };
  return (
    custom !== null &&
    typeof custom === "object" &&
    custom.role === "custom" &&
    (custom.customType === PREWALK_ARMED_MESSAGE_TYPE ||
      custom.customType === PREWALK_PLAN_MESSAGE_TYPE)
  );
};

export const filterPrewalkPlanningDirectives = <Message>(
  messages: Message[],
  visible: boolean,
): { messages: Message[]; changed: boolean } => {
  if (visible) return { messages, changed: false };
  let changed = false;
  const filtered = messages.filter((message) => {
    if (!isPrewalkPlanningDirective(message)) return true;
    changed = true;
    return false;
  });
  return { messages: changed ? filtered : messages, changed };
};

// Advisory arm-time framing, delivered as a hidden nextTurn custom message:
// LLM-visible, TUI-hidden, and never fired as an `input` event, so it cannot
// be captured as the next prewalk task and never triggers a turn by itself.
export const prewalkArmedPrompt = (
  mode: FabricPrewalkMode, model: string, requirePlan = true,
): string => [
  `Prewalk armed → ${model} (${mode}): ${requirePlan
    ? "this session owes a recorded plan before handoff. Record it with prewalk.plan({ outcome, steps, verification, risks }) inside fabric_exec; after that, "
    : ""}the first successful pi.edit / pi.write / schema.commit — or file changes produced by shell commands — hands off automatically; ${
    mode === "trajectory"
      ? "the executor takes over the requested work there, and a hidden follow-up asks you to verify its work and summarize when it finishes."
      : `this session switches to ${model} and keeps working.`
  }`,
  ...(requirePlan ? [
    `A mutation boundary without a recorded plan is withheld and asks again (up to ${MAX_PREWALK_PLAN_PROMPTS} reminders), then hands off unplanned with a warning. Plan before your first edit; Fabric delivers the recorded plan directly to the executor.`,
  ] : []),
  "Reads never fire a handoff. Trigger reports mark the handoff moment only — the workspace is the source of truth, so verify file state with reads before continuing.",
].join("\n");

const customMessageText = (content: unknown): string | undefined => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content
      .filter(
        (block): block is { type: "text"; text: string } =>
          typeof block === "object" &&
          block !== null &&
          (block as { type?: unknown }).type === "text" &&
          typeof (block as { text?: unknown }).text === "string",
      )
      .map((block) => block.text);
    return parts.length > 0 ? parts.join("\n") : undefined;
  }
  return undefined;
};

// Pileup guard: only skip when an identical armed prompt already persists in
// the branch, so re-arming with a different mode/model still announces itself.
export const hasPrewalkArmedPrompt = (
  entries: ReadonlyArray<unknown>,
  content: string,
): boolean =>
  entries.some((entry) => {
    if (typeof entry !== "object" || entry === null) return false;
    const candidate = entry as { type?: unknown; customType?: unknown; content?: unknown };
    return (
      candidate.type === "custom_message" &&
      candidate.customType === PREWALK_ARMED_MESSAGE_TYPE &&
      customMessageText(candidate.content) === content
    );
  });

export interface BoundaryHandoffRunner {
  executeHandoff(
    args: Record<string, unknown>,
    context: FabricInvocationContext,
    sessionSeed: AgentSessionSeed,
  ): Promise<Record<string, unknown>>;
}

export interface PendingFabricHandoff {
  kind: "explicit" | "prewalk-in-place" | "prewalk-trajectory";
  args: Record<string, unknown>;
  audit: FabricCallAudit;
  resultFormat: FabricResultFormat;
  triggerRef?: string;
  // Session-monotonic claim order from the controller; rides result trigger
  // fields so follow-ups and audit surfaces can reference the Nth claim.
  triggerSeq?: number;
  // Filesystem-drift trigger evidence, bounded by the drift tracker's report
  // cap; absent for audited mutation triggers.
  triggerFiles?: string[];
  triggerFilesTruncated?: number;
  // Absent for explicit handoffs, which do not participate in the plan gate.
  readiness?: FabricPrewalkReadiness;
}

// Appended to the replaced boundary tool result so the framing persists with
// what Main keeps seeing, anchoring every later turn. Advisory only: the directive
// is text, not a gate — prewalk.requirePlan gates the claim itself. Shell writes DO
// count as triggers when prewalk.detectShellWrites is enabled (the fs-drift fallback
// claims them).
const TRAJECTORY_REARM_DIRECTIVE = [
  "Prewalk handoff completed — the executor's result above is final; don't redo it.",
  "Prewalk re-armed: on the next request, restate remaining steps (skip if trivial), then make changes via pi.edit / pi.write or shell file changes in fabric_exec to hand off again.",
  "A hidden follow-up turn verifies the executor's work and summarizes; keep any fixes scoped to what verification fails.",
].join("\n");

export const withTrajectoryRearmDirective = (
  text: string,
  pending: PendingFabricHandoff,
  handoff: Record<string, unknown>,
  controller: PrewalkController,
  sessionId: string,
): string =>
  pending.kind === "prewalk-trajectory" &&
  handoff.completed === true &&
  controller.isArmed(sessionId)
    ? `${text}\n\n${TRAJECTORY_REARM_DIRECTIVE}`
    : text;

export const claimFabricHandoff = (
  controller: PrewalkController,
  execution: FabricExecutionResult,
  sessionId: string,
  resultFormat: FabricResultFormat,
): PendingFabricHandoff | FabricPrewalkPlanCheckpoint | undefined => {
  if (execution.handoffRequest) {
    controller.completeTask();
    let audit: FabricCallAudit | undefined;
    for (let index = execution.audits.length - 1; index >= 0; index--) {
      const candidate = execution.audits[index];
      if (candidate?.ref === "agents.handoff") {
        audit = candidate;
        break;
      }
    }
    if (!audit) {
      throw new Error("Deferred agents.handoff request has no matching Fabric audit");
    }
    return {
      kind: "explicit",
      args: execution.handoffRequest,
      audit,
      resultFormat,
    };
  }

  const outcome = controller.claim(execution.audits, sessionId);
  if (!outcome) return undefined;
  if (outcome.kind === "prewalk-plan") return outcome;
  const pending = buildPrewalkPending(outcome, resultFormat);
  execution.audits.push(pending.audit);
  return pending;
};

// Filesystem-fallback claim path (PREWALK_FS_DRIFT_REF): reached when an armed
// session ran a successful Pi shell call inside the program but no audited pi.edit /
// pi.write / schema.commit fired — heredocs, sed -i, formatter binaries. The
// rest of the boundary pipeline (in-place switch or trajectory fork) is
// identical; only the trigger evidence differs.
export const claimFabricFsDriftHandoff = (
  controller: PrewalkController,
  execution: FabricExecutionResult,
  sessionId: string,
  drift: PrewalkFsDrift,
  resultFormat: FabricResultFormat,
): PendingFabricHandoff | FabricPrewalkPlanCheckpoint | undefined => {
  const outcome = controller.claimFsDrift(sessionId, drift.files);
  if (!outcome) return undefined;
  if (outcome.kind === "prewalk-plan") return outcome;
  const pending = buildPrewalkPending(outcome, resultFormat);
  if (drift.files.length > 0) {
    pending.triggerFiles = drift.files;
    if (drift.truncated > 0) pending.triggerFilesTruncated = drift.truncated;
  }
  execution.audits.push(pending.audit);
  return pending;
};

const buildPrewalkPending = (
  claim: FabricPrewalkClaim,
  resultFormat: FabricResultFormat,
): PendingFabricHandoff => {
  const inPlace = claim.arm.mode === "in-place";
  const readiness = claim.readiness;
  const task = [
    claim.arm.task,
    ...(!inPlace && readiness.kind === "planned" ? [prewalkPlanText(readiness.plan)] : []),
  ].filter(Boolean).join("\n\n");
  const nestedToolCallId = `${NESTED_TOOL_CALL_ID_PREFIX}prewalk_${randomUUID()}`;
  const args = {
    model: claim.arm.model,
    name: inPlace ? "In-place Prewalk" : "Prewalk trajectory executor",
    ...(task ? { task } : {}),
    // Thinking applies to the child executor only; in-place keeps Main's level.
    ...(!inPlace && claim.arm.thinking ? { thinking: claim.arm.thinking } : {}),
  };
  const audit: FabricCallAudit = {
    ref: inPlace ? "fabric.prewalk" : "agents.handoff",
    nestedToolCallId,
    startedAt: Date.now(),
    tool: inPlace ? "prewalk" : "handoff",
    provider: inPlace ? "fabric" : "agents",
    args: {
      ...args, seq: claim.seq, readiness: readiness.kind,
      ...(readiness.kind === "unplanned" ? { planPrompts: readiness.prompts } : {}),
    },
  };
  return {
    kind: inPlace ? "prewalk-in-place" : "prewalk-trajectory",
    args,
    audit,
    resultFormat,
    triggerRef: claim.mutation.ref,
    triggerSeq: claim.seq,
    readiness,
  };
};

const modelForKey = (key: string, context: ExtensionContext) => {
  const separator = key.indexOf("/");
  if (separator <= 0 || separator === key.length - 1) {
    throw new Error("Prewalk requires a provider/model executor target");
  }
  const model = context.modelRegistry.find(
    key.slice(0, separator),
    key.slice(separator + 1),
  );
  if (!model) throw new Error(`Prewalk model is unavailable: ${key}`);
  return model;
};

// A model switch can reject or throw, and every return site needs the same
// answer; the caller reports the failure, so the cause is not rethrown here.
const setModelSafely = async (
  extension: ExtensionAPI,
  model: Parameters<ExtensionAPI["setModel"]>[0],
): Promise<boolean> => {
  try {
    return await extension.setModel(model);
  } catch {
    return false;
  }
};

const runInPlacePrewalk = async (
  controller: PrewalkController,
  extension: ExtensionAPI,
  pending: PendingFabricHandoff,
  context: ExtensionContext,
): Promise<Record<string, unknown>> => {
  const modelKey = String(pending.args.model ?? "");
  context.ui.setStatus("fabric-prewalk", `switching Main → ${modelKey}`);
  const model = modelForKey(modelKey, context);
  // Snapshot the pre-switch reasoning channel and branch. In-place handoff
  // cannot rewrite Pi's ground-truth log, so foreign thinking stays
  // unreplayable for the new model; bridge continuity with the bounded digest.
  const sourceModel = context.model
    ? {
        provider: context.model.provider,
        modelId: context.model.id,
        api: context.modelRegistry.find(context.model.provider, context.model.id)?.api,
      }
    : undefined;
  const transfer: ThinkingTransferInput = {
    ...(sourceModel ? { source: sourceModel } : {}),
    target: {
      provider: model.provider,
      modelId: model.id,
      api: model.api,
      reasoning: model.reasoning,
      ...((model.compat as { requiresThinkingAsText?: boolean } | undefined)
        ?.requiresThinkingAsText !== undefined
        ? {
            requiresThinkingAsText: (model.compat as { requiresThinkingAsText?: boolean })
              .requiresThinkingAsText,
          }
        : {}),
    },
  };
  const branch = context.sessionManager.getBranch();
  const returnModel = context.model;
  if (!returnModel) throw new Error("Prewalk cannot determine Main return model");
  const returnModelKey = `${returnModel.provider}/${returnModel.id}`;
  const continuationId = randomUUID();
  const switched = await extension.setModel(model);
  if (!switched) {
    throw new Error(`No authentication configured for prewalk model: ${modelKey}`);
  }
  // Record the borrow as soon as the switch succeeds: the continuation below
  // can still fail to queue, and a failed rollback must leave recovery data.
  controller.borrowMain(returnModelKey);

  let continuationMessage: PrewalkContinuationMessage | undefined;
  try {
    // One hidden continuation delivers everything the executor needs: the
    // task, the recorded plan, and — when the reasoning channel is not
    // replayable — a bounded advisory digest of the frontier model's
    // deliberation. It is sent as a passive context message (triggerTurn
    // false): the host defers it to the end of the boundary turn and appends
    // it after the tool results, so the executor's next request carries it
    // without a queued turn of its own. The controller copy is the canonical
    // payload for the context hook, which injects it into any earlier request
    // that would otherwise run without it (LQ1: competing steers no longer
    // delay it, and no completion-only request follows).
    const transferPolicy = thinkingTransferPolicy(transfer);
    const digest = transferPolicy !== "preserved"
      ? buildThinkingDigest(branch, transfer)
      : undefined;
    const taskText =
      typeof pending.args.task === "string" && pending.args.task.trim().length > 0
        ? pending.args.task
        : undefined;
    continuationMessage = {
      role: "custom",
      customType: PREWALK_CONTINUE_MESSAGE_TYPE,
      content: [
        PREWALK_CONTINUE_PROMPT,
        ...(taskText ? [taskText] : []),
        ...(pending.readiness?.kind === "planned" ? [prewalkPlanText(pending.readiness.plan)] : []),
        ...(digest ? [digest.content] : []),
      ].join("\n\n"),
      display: false,
      details: {
        mode: "in-place",
        model: modelKey,
        continuationId,
        returnModel: returnModelKey,
        trigger: pending.triggerRef,
        ...(digest
          ? {
              thinkingTransfer: {
                policy: transferPolicy,
                citedBlocks: digest.citedBlocks,
                target: modelKey,
              },
            }
          : {}),
      },
      timestamp: Date.now(),
    };
    extension.sendMessage(continuationMessage, { triggerTurn: false });
  } catch (error) {
    const restored = await setModelSafely(extension, returnModel);
    if (!restored) {
      // Main is stuck on the executor: disarm so the next mutation cannot hand
      // off again, but keep the borrow so a later session start or /fabric
      // reload retries the return instead of losing Main.
      controller.cancel();
      throw new Error(
        `Prewalk could not queue its continuation or return Main to ${returnModelKey}`,
        { cause: error },
      );
    }
    // Main is back: discharge the borrow and let the armed task survive.
    controller.clearBorrowed();
    throw error;
  }

  controller.beginContinuation(continuationId, returnModelKey, continuationMessage);
  context.ui.notify(
    `Prewalk is continuing in Main with ${modelKey}, then returning to ${returnModelKey}.`,
    "info",
  );
  context.ui.setStatus("fabric-prewalk", `continuing Main → ${modelKey}`);
  return {
    prewalk: true,
    mode: "in-place",
    continued: true,
    status: "continued",
    model: modelKey,
    trigger: prewalkTriggerField(pending),
  };
};

const modelForReturnKey = (key: string, context: ExtensionContext) => {
  const separator = key.indexOf("/");
  if (separator <= 0 || separator === key.length - 1) return undefined;
  return context.modelRegistry.find(key.slice(0, separator), key.slice(separator + 1));
};

const PREWALK_RETURN_COMPACTION_INSTRUCTIONS = [
  "Compact before Main returns to its boundary model after an in-place prewalk continuation.",
  "Preserve the executor's final report and verification results; summarize implementation scratch work, file reads, and command output.",
].join(" ");

export interface InPlacePrewalkSettleOptions {
  // Enabled by default when a compact controller is provided.
  compactOnReturn?: boolean;
  compact?: {
    request(intent: CompactRequestIntent): unknown;
    maybeCommit(context: ExtensionContext): Promise<void>;
    status?(): { pending?: unknown };
  };
}

// A restarted process has no in-memory borrow record, yet the branch still
// proves Main is owed a return: a persisted in-place continuation whose
// executor switch is the session's last recorded model change. A later model
// change (completed return, manual pick, another cycle) supersedes it, and a
// malformed or trajectory record carries no return identity.
const prewalkRecoveryCandidate = (
  branch: ReadonlyArray<unknown>,
): FabricPrewalkBorrowedMain | undefined => {
  let continuationIndex = -1;
  let details: { continuationId?: unknown; model?: unknown; returnModel?: unknown } | undefined;
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index] as { type?: unknown; customType?: unknown; details?: unknown };
    if (entry?.type !== "custom_message" || entry.customType !== PREWALK_CONTINUE_MESSAGE_TYPE) {
      continue;
    }
    if (typeof entry.details !== "object" || entry.details === null) continue;
    if ((entry.details as { mode?: unknown }).mode !== "in-place") continue;
    continuationIndex = index;
    details = entry.details as { continuationId?: unknown; model?: unknown; returnModel?: unknown };
    break;
  }
  if (continuationIndex < 0 || !details) return undefined;
  const continuationId = typeof details.continuationId === "string" ? details.continuationId : "";
  const executorModel = typeof details.model === "string" ? details.model.trim() : "";
  const returnModel = typeof details.returnModel === "string" ? details.returnModel.trim() : "";
  if (!continuationId || !executorModel || !returnModel || returnModel === executorModel) {
    return undefined;
  }
  let recordedExecutor: string | undefined;
  for (let index = 0; index < branch.length; index += 1) {
    const entry = branch[index] as { type?: unknown; provider?: unknown; modelId?: unknown };
    if (entry?.type !== "model_change") continue;
    if (index > continuationIndex) return undefined;
    recordedExecutor = `${String(entry.provider)}/${String(entry.modelId)}`;
  }
  return recordedExecutor === executorModel ? { returnModel, executorModel } : undefined;
};

export const restoreBorrowedInPlaceMain = async (
  controller: PrewalkController,
  extension: ExtensionAPI,
  context: ExtensionContext,
): Promise<boolean> => {
  let borrowed = controller?.borrowedReturn?.();
  let recovered = false;
  if (!borrowed) {
    // Restart recovery: adopt the persisted continuation's return tuple, then
    // restore through the same path. Success clears the adopted record — the
    // restore's recorded model change supersedes the historical candidate —
    // while failure keeps it so the auto-arm guard can still refuse to capture
    // the executor as Main.
    const candidate = prewalkRecoveryCandidate(context.sessionManager?.getBranch?.() ?? []);
    if (!candidate || !controller.hydrateBorrowedMain(candidate)) return false;
    borrowed = candidate;
    recovered = true;
  }
  const currentKey = context.model
    ? `${context.model.provider}/${context.model.id}`
    : undefined;
  // Only snap back when this session is still on the executor we switched to.
  // A new session that already loaded Main, or a later manual pick, stays put.
  if (currentKey !== undefined && currentKey !== borrowed.executorModel) return false;
  if (currentKey === borrowed.returnModel) return false;

  const model = modelForReturnKey(borrowed.returnModel, context);
  if (!model) {
    context.ui.setStatus("fabric-prewalk", `return failed → ${borrowed.returnModel}`);
    context.ui.notify(
      `Prewalk left Main on the executor; could not restore unavailable model ${borrowed.returnModel}.`,
      "error",
    );
    return false;
  }

  const restored = await setModelSafely(extension, model);
  if (!restored) {
    context.ui.setStatus("fabric-prewalk", `return failed → ${borrowed.returnModel}`);
    context.ui.notify(
      `Prewalk left Main on the executor; could not return to ${borrowed.returnModel}. Check model authentication.`,
      "error",
    );
    return false;
  }

  if (recovered) controller.clearBorrowed();
  context.ui.notify(`Restored Main to ${borrowed.returnModel} after in-place prewalk.`, "info");
  return true;
};

export const settleInPlacePrewalk = async (
  controller: PrewalkController,
  extension: ExtensionAPI,
  context: ExtensionContext,
  options?: InPlacePrewalkSettleOptions,
): Promise<boolean> => {
  const sessionId = context.sessionManager.getSessionId();
  const settlement = controller.takeContinuationSettlement(sessionId);
  if (!settlement) return false;

  const model = modelForReturnKey(settlement.returnModel, context);
  if (!model) {
    // A failed return is not completion: dropping to the shared cancel path
    // disarms without re-arming while preserving borrowedReturn, so a later
    // session start or /fabric reload can still restore Main. Repeated settle
    // calls find no continuation and stay quiet.
    controller.cancel();
    context.ui.setStatus("fabric-prewalk", `return failed → ${settlement.returnModel}`);
    context.ui.notify(
      `Prewalk completed, but Main could not return to unavailable model ${settlement.returnModel}.`,
      "error",
    );
    return false;
  }

  context.ui.setStatus("fabric-prewalk", `returning Main → ${settlement.returnModel}`);
  if (options?.compact && options.compactOnReturn !== false) {
    // Compact while the executor is still active so the restored boundary
    // model re-ingests a compacted transcript instead of the executor's full
    // implementation scratch work: the return prefill is cold regardless of
    // provider cache-policy differences, so keep it small. An already-pending
    // intent (e.g. requested by the model) wins over ours. The commit is
    // best-effort; the controller records failures without throwing.
    if (!options.compact.status?.().pending) {
      options.compact.request({
        reason: "in-place prewalk return",
        instructions: PREWALK_RETURN_COMPACTION_INSTRUCTIONS,
        requestedBy: "prewalk",
      });
    }
    await options.compact.maybeCommit(context);
  }
  const restored = await setModelSafely(extension, model);
  if (!restored) {
    // A failed return is not completion: dropping to the shared cancel path
    // disarms without re-arming while preserving borrowedReturn, so a later
    // session start or /fabric reload can still restore Main. Repeated settle
    // calls find no continuation and stay quiet.
    controller.cancel();
    context.ui.setStatus("fabric-prewalk", `return failed → ${settlement.returnModel}`);
    context.ui.notify(
      `Prewalk completed, but Main could not return to ${settlement.returnModel}. Check model authentication.`,
      "error",
    );
    return false;
  }

  controller.finishContinuation(sessionId, settlement.continuationId);
  const status = controller.status();
  context.ui.setStatus(
    "fabric-prewalk",
    status.state === "armed" ? `armed → ${status.model}` : undefined,
  );
  context.ui.notify(
    status.state === "armed"
      ? `Prewalk complete. Main returned to ${settlement.returnModel} and re-armed for the next task.`
      : `Prewalk complete. Main returned to ${settlement.returnModel}.`,
    "info",
  );
  return true;
};


export const runFabricHandoffAtBoundary = async (
  controller: PrewalkController,
  runner: BoundaryHandoffRunner,
  extension: ExtensionAPI,
  pending: PendingFabricHandoff,
  outerToolResult: AgentToolResultMessage,
  context: ExtensionContext,
  activity?: (update: FabricInvocationActivityUpdate) => void,
): Promise<Record<string, unknown>> => {
  const model = String(pending.args.model ?? "");
  const inPlace = pending.kind === "prewalk-in-place";
  context.ui.setStatus(
    "fabric-prewalk",
    inPlace ? `switching Main → ${model}` : `handing off trajectory → ${model}`,
  );
  try {
    if (inPlace) {
      const result = await runInPlacePrewalk(controller, extension, pending, context);
      pending.audit.success = true;
      pending.audit.result = result;
      pending.audit.endedAt = Date.now();
      activity?.({ type: "progress", message: `Main continuing in place with ${model}` });
      return result;
    }

    const seed = snapshotHandoffSession(
      context.sessionManager,
      context.model,
      outerToolResult,
      outerToolResult.toolCallId,
    );
    const invocation: FabricInvocationContext = {
      cwd: context.cwd,
      signal: context.signal,
      parentToolCallId: outerToolResult.toolCallId,
      nestedToolCallId: pending.audit.nestedToolCallId,
      extensionContext: context,
      update(message) {
        context.ui.setStatus("fabric-prewalk", message);
        activity?.({ type: "progress", message });
      },
      ...(activity ? { activity } : {}),
      attachPreview(preview) {
        pending.audit.preview = preview;
      },
    };
    const result = await runner.executeHandoff(pending.args, invocation, seed);
    const completed = result.completed === true;
    pending.audit.success = completed;
    pending.audit.result = result;
    pending.audit.endedAt = Date.now();
    const continuing = queueHandoffFailureContinuation(extension, context, result);
    // An explicitly armed executor must not immediately hand off its next write.
    if (continuing) controller.cancel();
    if (!continuing && pending.kind === "prewalk-trajectory") {
      // Main is never left idle after a delegated implementation: queue a
      // hidden follow-up the same way in-place does. Completed handoffs get
      // verify-and-summarize; non-completed ones get report-and-propose so a
      // failed, stopped, or timed-out executor never ends the turn in silence.
      if (completed) {
        queuePrewalkFollowUp(
          extension,
          PREWALK_CONTINUE_MESSAGE_TYPE,
          PREWALK_TRAJECTORY_VERIFY_PROMPT,
          { mode: "trajectory", model, trigger: pending.triggerRef },
        );
      } else {
        queuePrewalkFollowUp(
          extension,
          PREWALK_FAILURE_MESSAGE_TYPE,
          PREWALK_TRAJECTORY_INCOMPLETE_PROMPT,
          {
            mode: "trajectory",
            model,
            status: result.status,
            ...(typeof result.error === "string" ? { error: result.error } : {}),
            trigger: pending.triggerRef,
          },
        );
      }
    }
    if (!continuing && pending.kind === "explicit") {
      queueHandoffCompletion(extension, pending.args, result);
    }
    context.ui.setStatus(
      "fabric-prewalk",
      continuing ? "handoff failed; executor continuing directly"
        : completed ? "trajectory executor implemented" : `trajectory ${String(result.status ?? "failed")}`,
    );
    return {
      ...(pending.kind === "prewalk-trajectory"
        ? { prewalk: true, mode: "trajectory", trigger: prewalkTriggerField(pending) }
        : {}),
      ...result,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (inPlace) controller.failHandoff();
    pending.audit.success = false;
    pending.audit.error = message;
    pending.audit.endedAt = Date.now();
    const failure = { handedOff: false, continued: false, completed: false, status: "failed", error: message };
    const continuing = !inPlace && queueHandoffFailureContinuation(extension, context, { ...failure, error });
    if (continuing) controller.cancel();
    if (!continuing && pending.kind.startsWith("prewalk-") && !inPlace) {
      // In-place failures do not terminate the boundary: Main keeps running in
      // the same turn with the failed result in context, so a queued report
      // would only add a duplicate turn. Trajectory failures still end the
      // turn silently, so they queue the report-and-propose reply.
      queuePrewalkFollowUp(
        extension,
        PREWALK_FAILURE_MESSAGE_TYPE,
        PREWALK_FAILURE_PROMPT,
        { mode: inPlace ? "in-place" : "trajectory", trigger: pending.triggerRef, error: message },
      );
    }
    if (!continuing && pending.kind === "explicit") {
      queueHandoffCompletion(extension, pending.args, failure);
    }
    context.ui.setStatus("fabric-prewalk", continuing ? "handoff failed; executor continuing directly"
      : inPlace ? "in-place continuation failed" : "trajectory handoff failed");
    return {
      ...(pending.kind.startsWith("prewalk-")
        ? {
            prewalk: true,
            mode: inPlace ? "in-place" : "trajectory",
            trigger: prewalkTriggerField(pending),
          }
        : {}),
      ...failure,
    };
  } finally {
    if (!inPlace) {
      const status = controller.completeTask();
      if (status.state === "armed") {
        context.ui.setStatus("fabric-prewalk", `armed → ${status.model}`);
      }
    }
  }
};
