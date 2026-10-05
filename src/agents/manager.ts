import { randomUUID } from "node:crypto";
import {
  childThinkingBounds,
  clampThinkingToBounds,
  serializeThinkingBounds,
  type FabricThinkingBounds,
} from "../thinking.js";
import type { FabricKernel } from "../runtime/kernel.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readChildToolAllowlist } from "../core/child-tool-allowlist.js";
import { writeJsonAtomic } from "../core/atomic-write.js";
import {
  DEFAULT_FABRIC_CONFIG,
  MAX_AGENT_TIMEOUT_MS,
  MIN_AGENT_TIMEOUT_MS,
  type FabricAgentRunner,
  type FabricAgentConfig,
  type FabricAgentTransport,
  type FabricRetentionConfig,
  type FabricPythonRuntime,
} from "../config.js";
import {
  discoverClaudeModels,
  mapClaudeTools,
  normalizeClaudeModel,
  type ClaudeModelInfo,
} from "./claude-cli.js";
import { mapVedaTools, normalizeVedaModel } from "./veda-cli.js";
import {
  BUILT_IN_RUNNER_IDS,
  isFabricRunnerId,
  requireAgentRunner,
  getAgentRunner,
  type FabricHostedRunner,
  type FabricRunnerAdapter,
  type FabricRunnerLaunchContext,
} from "./runner-registry.js";
import {
  HOSTED_STATE_FILE,
  HostedRun,
  readHostedRunState,
  type HostedRunHooks,
} from "./hosted-run.js";
import { resolvePiBinary } from "./pi-binary.js";
import {
  inheritedSessionPinsFromEnv,
  serializeInheritedSessionPins,
  type InheritedSessionPin,
} from "./session-pins.js";
import { tokenUsagePayloadFromValue } from "../lifecycle/types.js";
import type { FabricTokenUsagePayload } from "../lifecycle/types.js";
import { AgentAdmission, assertAgentTask, beginAgentSettlement, createAgentLifecycle, finishAgentSettlement, terminalAgentStatuses, type AgentLifecycleState } from "./lifecycle.js";
import { removeTree } from "./rm.js";
import { HerdrTransport } from "./transports/herdr-transport.js";
import { LocaltermTransport } from "./transports/localterm-transport.js";
import { ProcessTransport } from "./transports/process-transport.js";
import { ScreenTransport } from "./transports/screen-transport.js";
import { TmuxTransport } from "./transports/tmux-transport.js";
import type {
  AgentChildQuestionRequest,
  AgentChildQuestionResponse,
  FabricBudgetSummary,
  FabricSteeringMode,
  FabricAgentLog,
  AgentHandleInfo,
  AgentRunCarryOver,
  AgentRunRecord,
  AgentRunRequest,
  AgentRunResult,
  AgentSteerEntry,
  AgentSteerResult,
  AgentTransportAdapter,
  AgentTransportHandle,
  AgentTransportLaunch,
  AgentUsage,
} from "./types.js";
import { WorktreeManager, type AgentWorktreeResult } from "./worktree-manager.js";
import { writeForkSession, writeHandoffSession } from "./handoff.js";
import {
  checkWritePolicyRequest,
  readAgentLineage,
  readWritePolicy,
  requestsWritePolicy,
  resolveChildWritePolicy,
  type FabricAgentLineage,
  type FabricWritePolicy,
} from "./child-env.js";
import { launchScope, normalizeScope } from "../scope.js";
import type { FabricCompactionBudget } from "../compaction/hook.js";
import {
  activeBudgetState,
  appendBudgetLedger,
  clearOwnedBudgetEnv,
  initBudgetLedger,
  readBudgetLedger,
  readBudgetLedgerDetailed,
} from "./budget-ledger.js";
import type { BudgetLedgerDetail } from "./budget-ledger.js";
import type { BudgetLedgerState } from "./budget-ledger.js";
import { readJsonlPage } from "../log-tail.js";
import {
  canRemoveManagedRunRoot,
  heartbeatRunRoot,
  markRunRootActive,
  markRunRootClosed,
  removeEmptyRunRoot,
  sweepTempRunRoots,
} from "../storage/retention.js";
import { resolveSessionExportDir, sessionExportFileFor } from "./session-export.js";
import {
  isFabricLifecycleEventType,
  type FabricLifecycleEventType,
  type FabricLifecyclePublishRequest,
} from "../lifecycle/types.js";
import {
  AGENT_RESUME_MAX_ATTEMPTS,
  AGENT_RESUME_RETRY_BASE_DELAY_MS,
  AGENT_STARTUP_MAX_ATTEMPTS,
  AGENT_STARTUP_RETRY_BASE_DELAY_MS,
  AGENT_STATUS_POLL_INTERVAL_MS,
} from "./constants.js";
const NESTED_SNAPSHOT_POLL_MS = 500;
const TRANSPORT_EXIT_GRACE_MS = 1_000;
// agents.childQuestionTimeoutMs default: routed child dialogs cancel after 10 minutes.
const DEFAULT_CHILD_QUESTION_TIMEOUT_MS = 600_000;
const MAX_NAME_LENGTH = 60;
const MAX_UI_TEXT_CHARS = 16_000;
const MAX_UI_ERROR_CHARS = 8_000;
const MAX_UI_VALUE_CHARS = 64_000;
const MAX_RETAINED_UI_RUNS = 240;
const MAX_RETAINED_RUN_HANDLES = 1_000;
const MAX_LOG_SUMMARY_CHARS = 7_000;
const MAX_LOG_DETAIL_CHARS = 900;
const RETENTION_SWEEP_INTERVAL_MS = 15 * 60 * 1_000;

export const effectiveAgentTimeoutMs = (
  configuredTimeoutMs: number,
  requestedTimeoutMs?: number,
): number => {
  const configured = Math.max(
    MIN_AGENT_TIMEOUT_MS,
    Math.min(Math.floor(configuredTimeoutMs), MAX_AGENT_TIMEOUT_MS),
  );
  if (requestedTimeoutMs === undefined || !Number.isFinite(requestedTimeoutMs)) {
    return configured;
  }
  return Math.max(
    configured,
    Math.min(Math.floor(requestedTimeoutMs), MAX_AGENT_TIMEOUT_MS),
  );
};

interface AgentParticipantGuidanceRequest {
  model?: string;
  runner: FabricAgentRunner;
}

type AgentParticipantGuidanceResolver = (
  request: AgentParticipantGuidanceRequest,
) => string | undefined;

/** Resolve and validate a one-shot agent's filesystem execution directory. */
export const resolveAgentCwd = (parentCwd: string, requestedCwd?: string): string => {
  if (requestedCwd === undefined) return parentCwd;
  const requested = requestedCwd;
  if (typeof requested !== "string" || requested.trim().length === 0) {
    throw new Error(`Invalid Fabric agent cwd ${JSON.stringify(requested)}: path must not be empty`);
  }
  const candidate = path.isAbsolute(requested)
    ? requested
    : path.resolve(parentCwd, requested);
  try {
    const canonical = fs.realpathSync(candidate);
    fs.accessSync(canonical, fs.constants.R_OK | fs.constants.X_OK);
    if (!fs.statSync(canonical).isDirectory()) {
      throw new Error("path is not a directory");
    }
    return canonical;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid Fabric agent cwd ${JSON.stringify(requested)}: ${reason}`);
  }
};
interface ManagedAgent extends AgentLifecycleState<AgentRunResult> {
  id: string;
  name: string;
  task: string;
  runner: FabricAgentRunner;
  /** Capability facts frozen at launch; a later unregister does not change them. */
  runnerAdapter: FabricRunnerAdapter;
  /** Adapter-owned run: never relaunched or re-prompted by Fabric. */
  hosted?: HostedRun;
  kernel?: FabricKernel;
  recursive: boolean;
  residency: "session" | "durable";
  cwd: string;
  statusFile: string;
  lifecycleFile: string;
  lifecycleOffset: number;
  lifecycleRemainder: Buffer;
  runDirectory: string;
  transport: AgentTransportHandle;
  adapter: AgentTransportAdapter;
  launch: AgentTransportLaunch;
  startupAttempts: number;
  /** Mid-run resumes already spent on this run (see AGENT_RESUME_MAX_ATTEMPTS). */
  resumeAttempts: number;
  /** Set by an explicit stop — tool, dashboard, or session shutdown. A requested
   *  stop is terminal and must never be resumed behind the operator's back. */
  stopRequested: boolean;
  /** Monotonic progress maxima seen for this run across attempts. The worker's
   *  own terminal record keeps its counters, but a host-synthesized stop or
   *  transport-death record resets them to zero, so recovery reads this. */
  observedProgress: { turns: number; toolCalls: number; usage: AgentUsage };
  // The dead-transport failure we are retrying past; preferred over a bare
  // timed_out verdict if the run deadline lands mid-retry.
  lastRetriedTransportFailure?: AgentRunResult;
  model?: string;
  thinking?: AgentRunRequest["thinking"];
  requestedThinking?: AgentRunRequest["thinking"];
  actorId?: string;
  actorName?: string;
  capabilityRequirements?: string[];
  capabilityDigest?: string;
  runnerSessionId?: string;
  branch?: string;
  worktree?: string;
  worktreeResult?: AgentWorktreeResult;
  nestedSnapshot?: AgentRunRecord[];
  nestedSnapshotAt?: number;
  /** Routed child dialogs in flight; aborted at settlement. */
  questions?: AbortController;
  questionDecisionId?: string;
  latestRecord?: AgentRunRecord;
  latestUiRecord?: AgentRunRecord;
  background: boolean;
  completionNotified?: boolean;
  lastLivenessCheckAt: number;
  /** Sum of tokens.usage deltas drained from the worker so far. Settle closes
   *  the gap against the status file's cumulative snapshot so the ledger total
   *  is identical whether the stream arrived live or only at settle. */
  usageEmitted: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
}

const terminalStatuses = terminalAgentStatuses;

// Hosted runs have no Fabric transport to relaunch through.
const HOSTED_TRANSPORT: AgentTransportAdapter = {
  kind: "process",
  available: async () => false,
  launch: () => Promise.reject(new Error("Fabric never relaunches a hosted run")),
};

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const TRANSPORT_EXITED_WITHOUT_RESULT_PREFIX = "Agent transport exited without a result";

const transportExitedWithoutResult = (error: string | undefined): boolean =>
  typeof error === "string" && error.startsWith(TRANSPORT_EXITED_WITHOUT_RESULT_PREFIX);

/**
 * A stop worth resuming: the worker caught a signal mid-run, or its transport
 * died while the run still had work in flight. Timeouts and token-limit kills are
 * policy verdicts, and an explicit stop is operator intent — none of them resume.
 */
const recoverableStop = (record: AgentRunRecord): boolean =>
  record.status === "stopped" ||
  (record.status === "failed" && transportExitedWithoutResult(record.error));

const MAX_RESUME_NOTE_CHARS = 2_000;

const setWorkerArgument = (args: string[], name: string, value: string): void => {
  const index = args.indexOf(`--${name}`);
  if (index >= 0) args[index + 1] = value;
  else args.push(`--${name}`, value);
};

/**
 * Task text a resumed attempt receives: the original task plus a bounded note
 * naming the interruption, so a Pi child without a session file picks up where
 * the stopped attempt left off instead of restarting blind.
 */
const resumeTask = (
  task: string,
  record: AgentRunRecord,
  progress: { turns: number; toolCalls: number },
  runDirectory: string,
): string => {
  const summary = summarizeRunLog(runDirectory, 6);
  const turns = Math.max(record.turns, progress.turns);
  const toolCalls = Math.max(record.toolCalls, progress.toolCalls);
  const note = [
    "[Fabric continuation] A previous attempt at this exact task was interrupted before it finished.",
    `It ended with status "${record.status}"${record.error ? ` (${record.error})` : ""} after ${turns} turns and ${toolCalls} tool calls, so the working tree already contains what that attempt completed.`,
    "Inspect the current state first, do not redo work that is already done, and carry the task through to completion.",
    ...(summary ? [`Last observed run activity: ${summary}`] : []),
  ].join(" ");
  return `${note.slice(0, MAX_RESUME_NOTE_CHARS)}\n\n${task}`;
};

const retryablePiStartupError = (error: string | undefined): boolean =>
  typeof error === "string" &&
  /\b(?:no|missing)\s+(?:api key|credentials?)\b|\b(?:api key|credentials?)\s+(?:was\s+)?not found\b/i.test(
    error,
  );

const safeName = (value: string): string =>
  value
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, MAX_NAME_LENGTH) || "Fabric agent";

const readRecord = (filePath: string): AgentRunRecord | undefined => {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const record = parsed as AgentRunRecord;
    return { ...record, runner: isFabricRunnerId(record.runner) ? record.runner : "pi" };
  } catch {
    return undefined;
  }
};

const boundedUiValue = (value: unknown): unknown => {
  if (value === undefined) return undefined;
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length <= MAX_UI_VALUE_CHARS) return JSON.parse(serialized) as unknown;
    return {
      fabricTruncated: true,
      originalChars: serialized.length,
      preview: serialized.slice(0, MAX_UI_VALUE_CHARS - 100),
    };
  } catch {
    return String(value).slice(0, MAX_UI_VALUE_CHARS);
  }
};

const compactUiRecord = (record: AgentRunRecord): AgentRunRecord => {
  const { task, text, error, value, nestedAgents, ...rest } = record;
  return {
    ...rest,
    task:
      task.length <= MAX_UI_TEXT_CHARS
        ? task
        : `${task.slice(0, MAX_UI_TEXT_CHARS)}…`,
    text: text.length <= MAX_UI_TEXT_CHARS ? text : `${text.slice(0, MAX_UI_TEXT_CHARS)}…`,
    ...(error
      ? {
          error:
            error.length <= MAX_UI_ERROR_CHARS
              ? error
              : `${error.slice(0, MAX_UI_ERROR_CHARS)}…`,
        }
      : {}),
    ...(value !== undefined ? { value: boundedUiValue(value) } : {}),
    ...(nestedAgents && nestedAgents.length > 0
      ? { nestedAgents: nestedAgents.map((nested) => compactUiRecord(nested)) }
      : {}),
  };
};

// A terminal owner no longer hosts its session children. Preserve genuine final
// results, but do not present its last running snapshot as live execution. Durable
// descendants have independent owners and must not inherit this terminal state.
const reconcileNestedAgents = (records: AgentRunRecord[], owner: AgentRunRecord): AgentRunRecord[] =>
  records.map((record) => {
    let next = record;
    if (terminalStatuses.has(owner.status) && !terminalStatuses.has(record.status) && record.residency !== "durable") {
      const { currentTool: _currentTool, blockedOn: _blockedOn, ...rest } = record;
      const finishedAt = owner.finishedAt ?? owner.updatedAt;
      next = {
        ...rest,
        status: "failed",
        error: `Nested agent owner ${owner.id} finished (${owner.status}) before a terminal result was retained`,
        finishedAt,
        updatedAt: Math.max(record.updatedAt, finishedAt),
      };
    }
    return next.nestedAgents
      ? { ...next, nestedAgents: reconcileNestedAgents(next.nestedAgents, next) }
      : next;
  });

const readNestedAgents = (runDirectory: string, depth = 0): AgentRunRecord[] => {
  if (depth >= 8) return [];
  const nestedRoot = path.join(runDirectory, "nested");
  let entries: string[];
  try {
    entries = fs.readdirSync(nestedRoot);
  } catch {
    return [];
  }
  const agents: AgentRunRecord[] = [];
  for (const entry of entries.slice(0, 200)) {
    const runDirectory = path.join(nestedRoot, entry);
    const record = readRecord(path.join(runDirectory, "status.json"));
    if (!record) continue;
    const nestedAgents = readNestedAgents(runDirectory, depth + 1);
    const { logFile: _logFile, nestedAgents: _nestedAgents, ...safeRecord } = record;
    agents.push(
      compactUiRecord({
        ...safeRecord,
        logFile: path.join(runDirectory, "events.jsonl"),
        ...(nestedAgents.length > 0 ? { nestedAgents } : {}),
      }),
    );
  }
  return agents;
};

const summarizeRunLog = (runDirectory: string, lines: number): string => {
  const page = readJsonlPage(path.join(runDirectory, "events.jsonl"), lines);
  const summary: string[] = [];
  for (const entry of page.lines) {
    const parsed = entry.parsed as Record<string, unknown> | undefined;
    if (!parsed || typeof parsed.type !== "string") continue;
    const rawDetail =
      typeof parsed.error === "string"
        ? parsed.error
        : typeof parsed.message === "string"
          ? parsed.message
          : typeof parsed.toolName === "string"
            ? parsed.toolName
            : typeof parsed.text === "string"
              ? parsed.text
              : "";
    const type = parsed.type.replace(/\s+/g, " ").trim().slice(0, 80);
    const detail = rawDetail
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_LOG_DETAIL_CHARS);
    summary.push(detail ? `${type}: ${detail}` : type);
  }
  return summary.join(" | ").slice(-MAX_LOG_SUMMARY_CHARS);
};

const writeRecord = (filePath: string, record: AgentRunRecord): void => {
  writeJsonAtomic(filePath, record, { space: 2 });
};

const failedRecord = (
  managed: Omit<
    ManagedAgent,
    "result" | "resolve" | "release" | "abortSignal" | "abortHandler" | "settled"
  >,
  status: "failed" | "stopped" | "timed_out",
  error: string,
): AgentRunResult => {
  const now = Date.now();
  return {
    id: managed.id,
    name: managed.name,
    task: managed.task,
    status,
    runner: managed.runner,
    ...(managed.kernel ? { kernel: managed.kernel } : {}),
    transport: managed.transport.kind,
    cwd: managed.cwd,
    ...(managed.residency === "durable" ? { residency: "durable" as const } : {}),
    startedAt: now,
    updatedAt: now,
    finishedAt: now,
    turns: 0,
    toolCalls: 0,
    text: "",
    error,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    ...(managed.model ? { model: managed.model } : {}),
    ...(managed.thinking ? { thinking: managed.thinking } : {}),
    ...(managed.actorId ? { actorId: managed.actorId } : {}),
    ...(managed.actorName ? { actorName: managed.actorName } : {}),
    ...(managed.runnerSessionId ? { runnerSessionId: managed.runnerSessionId } : {}),
    ...(managed.transport.sessionId ? { sessionId: managed.transport.sessionId } : {}),
    ...(managed.transport.attachCommand ? { attachCommand: managed.transport.attachCommand } : {}),
    ...(managed.branch ? { branch: managed.branch } : {}),
    ...(managed.worktree ? { worktree: managed.worktree } : {}),
    ...(managed.worktreeResult ? { worktreeResult: managed.worktreeResult } : {}),
  };
};

export class AgentManager {
  readonly #runs = new Map<string, ManagedAgent>();
  readonly #semaphore: AgentAdmission;
  readonly #worktrees = new WorktreeManager();
  readonly #runRoot: string;
  readonly #managedTempRoot: boolean;
  readonly #parentOwnedRunRoot: boolean;
  readonly #retention: FabricRetentionConfig;
  readonly #workerPath: string;
  readonly #fabricExtensionPath: string;
  readonly #piBinary: string;
  readonly #claudeBinary: string;
  readonly #vedaBinary: string;
  readonly #currentDepth: number;
  readonly #fullCodeMode: boolean;
  readonly #kernel: () => FabricKernel;
  readonly #pythonRuntime: () => FabricPythonRuntime;
  readonly #mainAgentId: string | undefined;
  readonly #fabricSessionId: string | undefined;
  readonly #meshRoot: string | undefined;
  readonly #projectRoot: string;
  readonly #hostId: string | undefined;
  readonly #identityId: string | undefined;
  readonly #transports: Map<FabricAgentTransport, AgentTransportAdapter>;
  readonly #onBackgroundComplete: ((result: AgentRunResult) => void) | undefined;
  readonly #onResultConsumed: ((id: string) => void) | undefined;
  readonly #onLifecycle: ((event: FabricLifecyclePublishRequest) => void) | undefined;
  readonly #onChildQuestion:
    | ((request: AgentChildQuestionRequest) => Promise<AgentChildQuestionResponse>)
    | undefined;
  readonly #preparePiModel:
    | ((model: string | undefined) => Promise<string | void>)
    | undefined;
  readonly #resolveHandoffCompactionBudget:
    | ((model: string | undefined, cwd: string) => Promise<FabricCompactionBudget>)
    | undefined;
  readonly #resolveParticipantGuidance: AgentParticipantGuidanceResolver | undefined;
  readonly #resolveInheritedSessionPins: (() => InheritedSessionPin[] | undefined) | undefined;
  readonly #thinkingBounds: (() => FabricThinkingBounds) | undefined;
  readonly #sessionId: (() => string | undefined) | undefined;
  readonly #executorRuntime: (() => string | undefined) | undefined;
  /** This process's own confinement; children may only narrow it. */
  readonly #parentWritePolicy: FabricWritePolicy | undefined = readWritePolicy();
  readonly #parentLineage: FabricAgentLineage | undefined = readAgentLineage();
  #childIndex = 0;
  readonly #piModelPreparations = new Map<string, Promise<string | undefined>>();
  readonly #budget: BudgetLedgerState | undefined;
  readonly #budgetOwned: boolean;
  readonly #uiListeners = new Set<() => void>();
  #retentionTimer: NodeJS.Timeout | undefined;
  #retentionSweep: Promise<void> | undefined;
  #budgetSummaryCache: { at: number; value: FabricBudgetSummary } | undefined;
  #claudeModelsCache: { at: number; value: ClaudeModelInfo[] } | undefined;
  #uiListRevision = 0;
  #uiListCache:
    | { revision: number; value: Array<AgentRunRecord | AgentHandleInfo> }
    | undefined;
  #closing = false;
  #closePromise: Promise<void> | undefined;
  readonly #closeAbort = new AbortController();
  readonly #spawns = new Set<Promise<AgentHandleInfo>>();
  readonly #unregisteredTransports = new Set<AgentTransportHandle>();
  readonly #launches = new Set<Promise<AgentTransportHandle>>();

  constructor(
    readonly cwd: string,
    readonly config: FabricAgentConfig,
    options: {
      workerPath?: string;
      fabricExtensionPath?: string;
      piBinary?: string;
      claudeBinary?: string;
      vedaBinary?: string;
      runRoot?: string;
      fullCodeMode?: boolean;
      kernel?: () => FabricKernel;
      pythonRuntime?: () => FabricPythonRuntime;
      mainAgentId?: string;
      fabricSessionId?: string;
      meshRoot?: string;
      projectRoot?: string;
      hostId?: string;
      identityId?: string;
      retention?: FabricRetentionConfig;
      onBackgroundComplete?: (result: AgentRunResult) => void;
      onResultConsumed?: (id: string) => void;
      onLifecycle?: (event: FabricLifecyclePublishRequest) => void;
      /** agents.childQuestions "route": answer a child dialog via parent UI or a decision. */
      onChildQuestion?: (request: AgentChildQuestionRequest) => Promise<AgentChildQuestionResponse>;
      preparePiModel?: (model: string | undefined) => Promise<string | void>;
      resolveHandoffCompactionBudget?: (model: string | undefined, cwd: string) => Promise<FabricCompactionBudget>;
      resolveParticipantGuidance?: AgentParticipantGuidanceResolver;
      resolveInheritedSessionPins?: () => InheritedSessionPin[] | undefined;
      /** Caller's effective thinking bounds (config narrowed by inherited env). */
      thinkingBounds?: () => FabricThinkingBounds;
      /** Caller Pi session id recorded as lineage parentSessionId. */
      sessionId?: () => string | undefined;
      /** Caller TypeScript executor runtime; native runtimes escape write confinement. */
      executorRuntime?: () => string | undefined;
    } = {},
  ) {
    this.#semaphore = new AgentAdmission(config.maxConcurrent, Infinity, config.maxDepth);
    this.#managedTempRoot = options.runRoot === undefined && process.env.PI_FABRIC_RUN_ROOT === undefined;
    this.#runRoot =
      options.runRoot ?? process.env.PI_FABRIC_RUN_ROOT ?? fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-runs-"));
    // Nested run artifacts belong to the enclosing run, not the short-lived Pi
    // child. Its owner removes them on cleanup/retention/root shutdown.
    this.#parentOwnedRunRoot = options.runRoot === undefined &&
      this.#parentLineage?.worker === true && this.#parentLineage.depth > 0 &&
      path.basename(this.#runRoot) === "nested" &&
      path.basename(path.dirname(this.#runRoot)) === this.#parentLineage.runId;
    this.#retention = options.retention ?? DEFAULT_FABRIC_CONFIG.retention;
    this.#workerPath =
      options.workerPath ?? fileURLToPath(new URL("../worker.js", import.meta.url));
    this.#fabricExtensionPath =
      options.fabricExtensionPath ?? fileURLToPath(new URL("../index.js", import.meta.url));
    this.#piBinary = resolvePiBinary(options.piBinary);
    this.#claudeBinary =
      options.claudeBinary ?? process.env.PI_FABRIC_CLAUDE_BINARY ?? config.claude.binary;
    this.#vedaBinary =
      options.vedaBinary ?? process.env.PI_FABRIC_VEDA_BINARY ?? config.veda.binary;
    this.#onBackgroundComplete = options.onBackgroundComplete;
    this.#onResultConsumed = options.onResultConsumed;
    this.#onLifecycle = options.onLifecycle;
    this.#onChildQuestion = options.onChildQuestion;
    this.#preparePiModel = options.preparePiModel;
    this.#resolveHandoffCompactionBudget = options.resolveHandoffCompactionBudget;
    this.#resolveParticipantGuidance = options.resolveParticipantGuidance;
    this.#resolveInheritedSessionPins = options.resolveInheritedSessionPins;
    this.#thinkingBounds = options.thinkingBounds;
    this.#sessionId = options.sessionId;
    this.#executorRuntime = options.executorRuntime;
    this.#currentDepth = Math.max(0, Number(process.env.PI_FABRIC_DEPTH ?? "0") || 0);
    this.#fullCodeMode = options.fullCodeMode ?? true;
    this.#kernel = options.kernel ?? (() => "typescript");
    this.#pythonRuntime = options.pythonRuntime ?? (() => "monty");
    this.#mainAgentId =
      options.mainAgentId ?? process.env.PI_FABRIC_MAIN_AGENT_ID;
    this.#fabricSessionId = options.fabricSessionId ?? process.env.PI_FABRIC_SESSION_ID;
    this.#meshRoot = options.meshRoot ?? process.env.PI_FABRIC_MESH_ROOT;
    this.#projectRoot =
      options.projectRoot ?? process.env.PI_FABRIC_PROJECT_ROOT ?? cwd;
    this.#hostId = options.hostId ?? process.env.PI_FABRIC_HOST_ID;
    this.#identityId = options.identityId ?? process.env.PI_FABRIC_IDENTITY_ID;
    const inheritedBudget = activeBudgetState();
    this.#budget =
      inheritedBudget ??
      (this.#currentDepth === 0 && config.budgetUsd > 0
        ? initBudgetLedger(config.budgetUsd)
        : undefined);
    this.#budgetOwned =
      !inheritedBudget && this.#currentDepth === 0 && config.budgetUsd > 0;
    const adapters: AgentTransportAdapter[] = [
      new ProcessTransport(),
      new TmuxTransport(),
      new ScreenTransport(),
      new LocaltermTransport(),
      new HerdrTransport(),
    ];
    this.#transports = new Map(adapters.map((adapter) => [adapter.kind, adapter]));
    if (this.#managedTempRoot) {
      markRunRootActive(this.#runRoot);
      // Allocate ownership now; scan only on actual agent use or close.
    }
  }

  async #prepareModel(model: string | undefined): Promise<string | undefined> {
    if (!this.#preparePiModel) return model;
    const key = model?.trim() || "<session-default>";
    const existing = this.#piModelPreparations.get(key);
    if (existing) return existing;
    const preparation = this.#preparePiModel(model).then((prepared) => {
      if (typeof prepared !== "string") return model;
      return prepared.trim() || model;
    });
    this.#piModelPreparations.set(key, preparation);
    try {
      return await preparation;
    } finally {
      if (this.#piModelPreparations.get(key) === preparation) {
        this.#piModelPreparations.delete(key);
      }
    }
  }

  subscribeUi(listener: () => void): () => void {
    this.#uiListeners.add(listener);
    return () => this.#uiListeners.delete(listener);
  }

  resolveCwd(requestedCwd?: string): string {
    return resolveAgentCwd(this.cwd, requestedCwd);
  }

  #inheritedSessionPins(request: AgentRunRequest): InheritedSessionPin[] | undefined {
    const explicit = request.inheritedSessionPins;
    if (explicit && explicit.length > 0) return explicit;
    const resolved = this.#resolveInheritedSessionPins?.();
    if (resolved && resolved.length > 0) return resolved;
    if (this.#currentDepth > 0) {
      const fromEnv = inheritedSessionPinsFromEnv();
      if (fromEnv.length > 0) return fromEnv;
    }
    return undefined;
  }

  /** Resolve once at the caller boundary, before launch or resident/trajectory handoff. */
  resolveKernel(
    request: Pick<AgentRunRequest, "kernel" | "runner" | "extensions">,
  ): FabricKernel | undefined {
    const choice = request.kernel;
    if (choice !== undefined && choice !== "inherit" && choice !== "typescript" && choice !== "python") {
      throw new Error(`Invalid Fabric agent kernel: ${String(choice)}`);
    }
    const runner = requireAgentRunner(request.runner ?? this.config.runner);
    if (!runner.capabilities.kernels || !(request.extensions ?? this.config.extensions)) {
      if (choice === "typescript" || choice === "python") {
        throw new Error(
          BUILT_IN_RUNNER_IDS.has(runner.id)
            ? "Explicit agent kernel requires the Pi runner with Fabric extensions enabled"
            : `Explicit agent kernel requires a runner with the kernels capability; ${runner.label} does not declare it`,
        );
      }
      return undefined;
    }
    const kernel = choice === undefined || choice === "inherit" ? this.#kernel() : choice;
    if (kernel !== "typescript" && kernel !== "python") {
      throw new Error(`Invalid inherited Fabric agent kernel: ${String(kernel)}`);
    }
    return kernel;
  }

  /** Internal backend policy snapshot; public agent calls select a language, not a backend. */
  resolvePythonRuntime(inherited?: FabricPythonRuntime): FabricPythonRuntime {
    const runtime = inherited === undefined ? this.#pythonRuntime() : inherited;
    if (runtime !== "cpython" && runtime !== "monty") {
      throw new Error(`Invalid inherited Fabric Python runtime: ${String(runtime)}`);
    }
    return runtime;
  }

  spawn(request: AgentRunRequest, signal?: AbortSignal): Promise<AgentHandleInfo> {
    if (this.#closing) return Promise.reject(new Error("Fabric agent manager is closing"));
    const pending = this.#spawn(request, signal);
    this.#spawns.add(pending);
    void pending.then(() => this.#spawns.delete(pending), () => this.#spawns.delete(pending));
    return pending;
  }

  async #launchTransport(adapter: AgentTransportAdapter, request: AgentTransportLaunch): Promise<AgentTransportHandle> {
    if (this.#closing) throw new Error("Fabric agent manager is closing");
    const pending = adapter.launch(request);
    this.#launches.add(pending);
    try {
      const transport = await pending;
      // Includes launches that race close, before a ManagedAgent can own them.
      this.#unregisteredTransports.add(transport);
      return transport;
    } finally {
      this.#launches.delete(pending);
    }
  }

  /** Effective bounds for a child; requested bounds outside the caller's throw. */
  childThinkingBounds(requested?: FabricThinkingBounds): FabricThinkingBounds {
    return childThinkingBounds(this.#thinkingBounds?.() ?? {}, requested);
  }

  async #spawn(request: AgentRunRequest, signal?: AbortSignal): Promise<AgentHandleInfo> {
    if (!this.config.enabled) throw new Error("Agents are disabled in Fabric configuration");
    if (this.#currentDepth >= this.config.maxDepth) {
      throw new Error(`Fabric agent depth limit reached (${this.config.maxDepth})`);
    }
    assertAgentTask(request);
    const kernel = this.resolveKernel({
      ...request,
      ...(request.recursive === true ? { extensions: true } : {}),
    });
    const pythonRuntime = kernel ? this.resolvePythonRuntime(request.pythonRuntime) : undefined;
    // Validate explicit execution targets before any model preparation or budget side effects.
    // With no override this deliberately preserves the manager cwd without canonicalizing it.
    const selectedCwd = this.resolveCwd(request.cwd);
    const residency = request.residency ?? "session";
    if (residency !== "session" && residency !== "durable") {
      throw new Error(`Invalid Fabric agent residency: ${String(request.residency)}`);
    }
    const runner = request.runner ?? this.config.runner;
    const runnerAdapter = requireAgentRunner(runner);
    const capabilities = runnerAdapter.capabilities;
    const hostedAdapter = runnerAdapter.kind === "hosted" ? runnerAdapter : undefined;
    if (request.persona && runner !== "veda") {
      throw new Error(`The persona option is only supported by the Veda runner, not ${runner}`);
    }
    if (request.persistSession === true && runner !== "claude") {
      throw new Error("persistSession is only supported by the Claude runner");
    }
    if (request.recursive && !capabilities.recursiveFabric) {
      throw new Error(
        runner === "claude"
          ? "Claude runner does not support recursive Fabric. Use a Pi runner for recursive: true, or omit recursive for Claude Code tools."
          : runner === "veda"
            ? "Veda runner does not support recursive Fabric. Use a Pi runner for recursive: true — Veda executes one headless prompt per invocation."
            : `${runnerAdapter.label} runner does not declare the recursiveFabric capability; omit recursive: true`,
      );
    }
    if (request.images?.length && !capabilities.imageInput) {
      throw new Error(`${runnerAdapter.label} runner does not declare the imageInput capability`);
    }
    if (request.sessionSeed && !capabilities.handoff) {
      throw new Error(
        BUILT_IN_RUNNER_IDS.has(runner)
          ? "Trajectory handoff sessions are only supported by the Pi runner"
          : `${runnerAdapter.label} runner does not declare the handoff capability`,
      );
    }
    if (request.sessionSeed && request.sessionFile) {
      throw new Error("A agent request cannot combine sessionSeed with sessionFile");
    }
    if (request.forkSeed && (!capabilities.handoff || request.sessionSeed || request.sessionFile)) {
      throw new Error('seed: "branch" requires the Pi runner and no other session seed');
    }
    if (hostedAdapter && request.actorId) {
      throw new Error(`${runnerAdapter.label} is a hosted runner; persistent actors need a worker runner`);
    }
    // Write confinement is enforced by the child (the Pi tool_call guard, or
    // a runner that declares writePolicy and receives the policy at launch).
    if (requestsWritePolicy(request)) checkWritePolicyRequest(request);
    const confined = requestsWritePolicy(request) || this.#parentWritePolicy !== undefined;
    if (confined && !capabilities.writePolicy) {
      throw new Error(
        BUILT_IN_RUNNER_IDS.has(runner)
          ? `Write confinement (readOnly, writableRoots, shell) is enforced only by the Pi runner, not ${runner}`
          : `Write confinement (readOnly, writableRoots, shell) needs the writePolicy capability; ${runnerAdapter.label} does not declare it`,
      );
    }
    if (
      confined &&
      (request.shell ?? this.#parentWritePolicy?.shell ?? "deny") !== "unconfined" &&
      ((kernel === "python" && pythonRuntime === "cpython") ||
        (kernel === "typescript" && /^(node|bun)-process$/.test(this.#executorRuntime?.() ?? "")))
    ) {
      throw new Error(
        'A confined agent cannot use a native Fabric executor (CPython, node-process, bun-process); use QuickJS/Monty or shell: "unconfined"',
      );
    }
    const worktreeSetup = request.worktree ? request.worktreeSetup ?? this.config.worktree?.setup : undefined;
    if (worktreeSetup !== undefined && (typeof worktreeSetup !== "string" || worktreeSetup.length > 8_192)) {
      throw new Error("worktreeSetup must be a shell command of at most 8192 characters");
    }
    // Fail closed before admission or budget side effects.
    const scope = launchScope(request.scope, request.inheritedScope);
    const thinkingBounds = this.childThinkingBounds(request.thinkingBounds);
    const requiresFabricKernel = kernel === "python" || request.kernel === "typescript";
    let tools = this.#childTools(request, runnerAdapter, requiresFabricKernel);
    if (runner === "claude") mapClaudeTools(tools);
    if (runner === "veda") mapVedaTools(tools);
    let model =
      request.model ??
      (runner === "claude"
        ? this.config.claude.model
        : runner === "veda"
          ? this.config.veda.model
          : (runner === "pi" || runner === "pi-durable")
            ? this.config.model
            : runnerAdapter.defaultModel?.());
    if (runner === "claude" && model) normalizeClaudeModel(model);
    if (runner === "veda" && model) normalizeVedaModel(model);
    if (!BUILT_IN_RUNNER_IDS.has(runner)) {
      if (runnerAdapter.mapTools) {
        const mapped = await runnerAdapter.mapTools(tools);
        if (!Array.isArray(mapped) || mapped.some((tool) => typeof tool !== "string")) {
          throw new Error(`The ${runnerAdapter.label} runner mapped tools to an invalid list`);
        }
        tools = [...mapped];
      }
      if (model && runnerAdapter.normalizeModel) model = await runnerAdapter.normalizeModel(model);
    }
    if (this.#budget) {
      const spent = readBudgetLedger(this.#budget.file).cost;
      if (spent >= this.#budget.budget) {
        throw new Error(
          `Fabric recursion budget exceeded: spent $${spent.toFixed(6)} of $${this.#budget.budget.toFixed(6)}. Increase agents.budgetUsd or simplify the task.`,
        );
      }
    }
    const admissionSignal = signal ? AbortSignal.any([signal, this.#closeAbort.signal]) : this.#closeAbort.signal;
    const release = await this.#semaphore.acquire("native", admissionSignal);
    try {
      if (runner === "pi" || runner === "pi-durable") model = await this.#prepareModel(model);
      if (this.#closing) throw new Error("Fabric agent manager is closing");
      this.#semaphore.admit(this.#currentDepth + 1);
    } catch (error) {
      release();
      throw error;
    }
    const id = randomUUID().replaceAll("-", "");
    const name = safeName(request.name ?? request.task.split("\n", 1)[0] ?? "Fabric agent");
    const runDirectory = path.join(this.#runRoot, id);
    fs.mkdirSync(runDirectory, { recursive: true });
    if (this.#managedTempRoot && !this.#retentionTimer) {
      this.#retentionTimer = setInterval(() => this.#scheduleRetentionSweep(), RETENTION_SWEEP_INTERVAL_MS);
      this.#retentionTimer.unref();
      this.#scheduleRetentionSweep();
    }
    const taskFile = path.join(runDirectory, "task.txt");
    const statusFile = path.join(runDirectory, "status.json");
    const lifecycleFile = path.join(runDirectory, "lifecycle.jsonl");
    const logFile = path.join(runDirectory, "events.jsonl");
    const steerFile = path.join(runDirectory, "steer.jsonl");
    const schemaFile = request.schema ? path.join(runDirectory, "schema.json") : undefined;
    const imagesFile = request.images && request.images.length > 0
      ? path.join(runDirectory, "images.json")
      : undefined;
    fs.writeFileSync(taskFile, request.task, { encoding: "utf8", mode: 0o600 });
    if (imagesFile) {
      fs.writeFileSync(imagesFile, JSON.stringify(request.images), {
        encoding: "utf8",
        mode: 0o600,
      });
    }
    if (schemaFile) {
      fs.writeFileSync(schemaFile, JSON.stringify(request.schema, null, 2), {
        encoding: "utf8",
        mode: 0o600,
      });
    }

    let agentCwd = selectedCwd;
    let branch: string | undefined;
    let worktree: string | undefined;
    if (request.worktree) {
      try {
        const lease = await this.#worktrees.create(id, selectedCwd, name, request.cwd !== undefined);
        agentCwd = lease.cwd;
        branch = lease.branch;
        worktree = lease.path;
      } catch (error) {
        release();
        throw error;
      }
    }

    try {
      if (worktree && worktreeSetup?.trim()) await this.#worktrees.setup(id, worktreeSetup);
      const writePolicy = capabilities.writePolicy
        ? resolveChildWritePolicy(request, this.#parentWritePolicy, agentCwd)
        : undefined;
      const parentSessionId = this.#sessionId?.();
      const parentRunId = this.#parentLineage?.runId ?? (this.#currentDepth > 0 ? process.env.PI_FABRIC_PARENT_RUN : undefined);
      const lineage: FabricAgentLineage = {
        version: 1,
        rootSessionId: this.#parentLineage?.rootSessionId ?? this.#fabricSessionId ?? parentSessionId ?? "",
        ...(parentSessionId ? { parentSessionId } : {}),
        ...(parentRunId ? { parentRunId } : {}),
        runId: id,
        depth: this.#currentDepth + 1,
        childIndex: this.#childIndex++,
        worker: true,
      };
      const sessionFile = request.forkSeed
        ? writeForkSession(request.forkSeed, agentCwd, path.join(runDirectory, "fork-session"), request.thinkingTransfer)
        : request.sessionSeed
        ? writeHandoffSession(
            request.sessionSeed,
            agentCwd,
            path.join(runDirectory, "handoff-session"),
            request.thinkingTransfer,
            request.handoffCompact,
            request.handoffCompact ? await this.#resolveHandoffCompactionBudget?.(model, agentCwd) : undefined,
          )
        : request.sessionFile;
      const timeoutMs = effectiveAgentTimeoutMs(
        this.config.timeoutMs,
        request.timeoutMs,
      );
      const requestedThinking = request.thinking ?? this.config.thinking;
      const thinking = requestedThinking
        ? clampThinkingToBounds(requestedThinking, thinkingBounds)
        : undefined;
      const clampedFrom = requestedThinking && thinking !== requestedThinking ? requestedThinking : undefined;
      const serializedThinkingBounds = serializeThinkingBounds(thinkingBounds);
      const recursive = capabilities.recursiveFabric && request.recursive === true;
      const extensions = recursive ? true : (request.extensions ?? this.config.extensions);
      const inheritedSessionPins = (runner === "pi" || runner === "pi-durable") && extensions
        ? this.#inheritedSessionPins(request)
        : undefined;
      // In a full-code parent every extension-enabled Pi child runs Fabric
      // through fabric_exec — not only recursively spawned agents. An explicit
      // extensions: false request opts the child back out to the native tool
      // surface, and a non-full-code parent keeps the historical behavior.
      // Recursive children additionally keep their recursive permission
      // surface (the "agent" granted risk) below.
      const inheritedFullCodeMode = capabilities.recursiveFabric && this.#fullCodeMode && extensions;
      const componentGuidance = recursive
        ? undefined
        : this.#resolveParticipantGuidance?.({ ...(model ? { model } : {}), runner })?.trim();
      const systemPrompt = [request.systemPrompt?.trim(), componentGuidance]
        .filter((section): section is string => Boolean(section))
        .join("\n\n") || undefined;
      const sessionExportDir = resolveSessionExportDir(this.config);
      const sessionExportFile = sessionExportDir
        ? sessionExportFileFor(sessionExportDir, agentCwd, id, new Date())
        : undefined;
      const launchContext: FabricRunnerLaunchContext = {
        id,
        name,
        task: request.task,
        cwd: agentCwd,
        runDirectory,
        residency,
        deadlineAt: Date.now() + timeoutMs,
        depth: this.#currentDepth + 1,
        lineage,
        tools,
        ...(model ? { model } : {}),
        ...(thinking ? { thinking } : {}),
        ...(kernel ? { kernel } : {}),
        ...(recursive ? { recursive } : {}),
        ...(request.images?.length ? { images: request.images } : {}),
        ...(request.schema ? { schema: request.schema } : {}),
        ...(systemPrompt ? { systemPrompt } : {}),
        ...(sessionFile ? { sessionFile } : {}),
        ...(writePolicy ? { writePolicy } : {}),
        ...(request.actorId ? { actorId: request.actorId } : {}),
        ...(request.actorName ? { actorName: request.actorName } : {}),
        ...(scope ? { scope } : {}),
      };
      if (hostedAdapter) {
        return await this.#startHosted(hostedAdapter, launchContext, {
          request,
          release,
          signal,
          timeoutMs,
          files: { statusFile, lifecycleFile, logFile },
          ...(clampedFrom ? { requestedThinking: clampedFrom } : {}),
          ...(branch ? { branch } : {}),
          ...(worktree ? { worktree } : {}),
        });
      }
      const adapter = await this.#resolveTransport(request.transport ?? this.config.transport);
      const workerArguments = [
        "--id",
        id,
        "--name",
        name,
        "--runner",
        runner,
        ...(kernel ? ["--kernel", kernel] : []),
        ...(pythonRuntime ? ["--python-runtime", pythonRuntime] : []),
        "--task-file",
        taskFile,
        ...(imagesFile ? ["--images-file", imagesFile] : []),
        "--status-file",
        statusFile,
        "--lifecycle-file",
        lifecycleFile,
        "--log-file",
        logFile,
        "--cwd",
        agentCwd,
        "--pi-binary",
        this.#piBinary,
        "--claude-binary",
        this.#claudeBinary,
        "--veda-binary",
        this.#vedaBinary,
        "--veda-backend",
        this.config.veda.backend,
        "--veda-persona",
        request.persona?.trim() || this.config.veda.persona,
        "--timeout-ms",
        String(timeoutMs),
        "--depth",
        String(this.#currentDepth + 1),
        "--full-code-mode",
        String(inheritedFullCodeMode),
        ...(this.#mainAgentId ? ["--main-agent-id", this.#mainAgentId] : []),
        ...(this.#fabricSessionId ? ["--fabric-session-id", this.#fabricSessionId] : []),
        "--extensions",
        String(extensions),
        "--tools",
        JSON.stringify(tools),
        "--granted-risks",
        JSON.stringify(recursive ? ["agent"] : []),
        ...(this.config.maxTokensPerChild > 0
          ? ["--max-tokens", String(this.config.maxTokensPerChild)]
          : []),
        "--transport",
        adapter.kind,
        ...(recursive || inheritedFullCodeMode || requiresFabricKernel
          ? ["--fabric-extension", this.#fabricExtensionPath]
          : []),
        ...(model ? ["--model", model] : []),
        ...(thinking ? ["--thinking", thinking] : []),
        ...(serializedThinkingBounds ? ["--thinking-bounds", serializedThinkingBounds] : []),
        ...(systemPrompt ? ["--system-prompt", systemPrompt] : []),
        "--persist-session",
        String(request.persistSession === true),
        "--model-admission",
        this.config.modelAdmission ?? "strict",
        ...(sessionFile ? ["--session-file", sessionFile] : []),
        ...(sessionExportFile ? ["--session-export-file", sessionExportFile] : []),
        ...(inheritedSessionPins && inheritedSessionPins.length > 0
          ? ["--inherited-session-pins", serializeInheritedSessionPins(inheritedSessionPins)]
          : []),
        ...(request.actorId ? ["--actor-id", request.actorId] : []),
        ...(request.actorName ? ["--actor-name", request.actorName] : []),
        ...(request.capabilityRequirements
          ? ["--capability-requirements", JSON.stringify(request.capabilityRequirements)]
          : []),
        ...(request.capabilityDigest
          ? ["--capability-digest", request.capabilityDigest]
          : []),
        ...(request.meshRoot ?? this.#meshRoot
          ? ["--mesh-root", request.meshRoot ?? this.#meshRoot!]
          : []),
        "--project-root",
        this.#projectRoot,
        ...(this.#hostId ? ["--owner-host-id", this.#hostId] : []),
        ...(this.#identityId ? ["--owner-identity-id", this.#identityId] : []),
        ...(request.runnerSessionId
          ? ["--runner-session-id", request.runnerSessionId]
          : []),
        "--run-root",
        path.join(runDirectory, "nested"),
        "--steer-file",
        steerFile,
        ...(this.config.childQuestions === "route" && capabilities.questions
          ? ["--child-questions", String(this.config.childQuestionTimeoutMs ?? DEFAULT_CHILD_QUESTION_TIMEOUT_MS)]
          : []),
        ...(schemaFile ? ["--schema-file", schemaFile] : []),
        ...(branch ? ["--branch", branch] : []),
        ...(worktree ? ["--worktree", worktree] : []),
        ...(writePolicy ? ["--write-policy", JSON.stringify(writePolicy)] : []),
        ...(scope ? ["--scope", JSON.stringify(scope)] : []),
        "--lineage",
        JSON.stringify(lineage),
      ];
      const runnerLaunch = runnerAdapter.kind === "worker"
        ? await runnerAdapter.launch({
            ...launchContext,
            files: {
              taskFile,
              statusFile,
              lifecycleFile,
              logFile,
              steerFile,
              ...(schemaFile ? { schemaFile } : {}),
              ...(imagesFile ? { imagesFile } : {}),
            },
            fabricWorker: { workerPath: this.#workerPath, workerArguments: [...workerArguments] },
          })
        : undefined;
      if (
        typeof runnerLaunch?.workerPath !== "string" ||
        !runnerLaunch.workerPath.trim() ||
        !Array.isArray(runnerLaunch.workerArguments) ||
        runnerLaunch.workerArguments.length > 4_096 ||
        runnerLaunch.workerArguments.some((argument) => typeof argument !== "string")
      ) {
        throw new Error(`The ${runnerAdapter.label} runner returned an invalid worker launch`);
      }
      const launch: AgentTransportLaunch = {
        id,
        name,
        cwd: agentCwd,
        workerPath: runnerLaunch.workerPath,
        workerArguments: [...runnerLaunch.workerArguments],
      };
      if (this.#closing) throw new Error("Fabric agent manager is closing");
      const transport = await this.#launchTransport(adapter, launch);
      const lifecycle = createAgentLifecycle<AgentRunResult>(release);
      if (signal?.aborted || this.#closing) {
        await transport.stop();
        if (!await transport.isAlive().catch(() => true)) this.#unregisteredTransports.delete(transport);
        throw new Error("Agent launch aborted");
      }
      const managed: ManagedAgent = {
        id,
        name,
        task: request.task,
        runner,
        runnerAdapter,
        ...(kernel ? { kernel } : {}),
        recursive,
        residency,
        cwd: agentCwd,
        statusFile,
        lifecycleFile,
        lifecycleOffset: 0,
        lifecycleRemainder: Buffer.alloc(0),
        runDirectory,
        transport,
        adapter,
        launch,
        startupAttempts: 1,
        ...lifecycle,
        abortSignal: signal,
        abortHandler: undefined,
        ...(model ? { model } : {}),
        ...(thinking ? { thinking } : {}),
        ...(clampedFrom ? { requestedThinking: clampedFrom } : {}),
        ...(request.actorId ? { actorId: request.actorId } : {}),
        ...(request.actorName ? { actorName: request.actorName } : {}),
        ...(request.capabilityRequirements
          ? { capabilityRequirements: [...request.capabilityRequirements] }
          : {}),
        ...(request.capabilityDigest ? { capabilityDigest: request.capabilityDigest } : {}),
        ...(request.runnerSessionId ? { runnerSessionId: request.runnerSessionId } : {}),
        ...(branch ? { branch } : {}),
        ...(worktree ? { worktree } : {}),
        settled: false,
        background: false,
        lastLivenessCheckAt: 0,
        resumeAttempts: 0,
        stopRequested: false,
        observedProgress: {
          turns: 0,
          toolCalls: 0,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
        },
        usageEmitted: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
      };
      if (signal) {
        managed.abortHandler = () => this.#handleCallerAbort(id);
        signal.addEventListener("abort", managed.abortHandler, { once: true });
      }
      this.#runs.set(id, managed);
      this.#unregisteredTransports.delete(transport);
      this.#invalidateUiList();
      void this.#monitor(managed, timeoutMs);
      return this.#handleInfo(managed, "running");
    } catch (error) {
      release();
      if (worktree) await this.#worktrees.cleanup(id, true).catch(() => false);
      throw error;
    }
  }

  /** prepare (locator persisted) → register → start; Fabric never re-submits. */
  async #startHosted(
    adapter: FabricHostedRunner,
    context: FabricRunnerLaunchContext,
    launch: {
      request: AgentRunRequest;
      release: () => void;
      signal: AbortSignal | undefined;
      timeoutMs: number;
      files: { statusFile: string; lifecycleFile: string; logFile: string };
      requestedThinking?: AgentRunRequest["thinking"];
      branch?: string;
      worktree?: string;
    },
  ): Promise<AgentHandleInfo> {
    const now = Date.now();
    const record: AgentRunRecord = {
      id: context.id,
      name: context.name,
      task: context.task,
      status: "running",
      runner: adapter.id,
      transport: "hosted",
      cwd: context.cwd,
      ...(context.model ? { model: context.model, requestedModel: context.model } : {}),
      ...(context.thinking ? { thinking: context.thinking } : {}),
      ...(launch.requestedThinking ? { requestedThinking: launch.requestedThinking } : {}),
      ...(context.residency === "durable" ? { residency: "durable" as const } : {}),
      startedAt: now,
      updatedAt: now,
      turns: 0,
      toolCalls: 0,
      text: "",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
      logFile: launch.files.logFile,
      ...(launch.branch ? { branch: launch.branch } : {}),
      ...(launch.worktree ? { worktree: launch.worktree } : {}),
    };
    let managed: ManagedAgent | undefined;
    const hosted = await HostedRun.prepare(
      adapter,
      { ...context, idempotencyKey: context.id },
      { ...launch.files, stateFile: path.join(context.runDirectory, HOSTED_STATE_FILE) },
      record,
      this.#hostedHooks(() => managed),
    );
    if (launch.signal?.aborted || this.#closing) {
      hosted.abandon("Agent launch aborted before the hosted run was submitted");
      throw new Error("Agent launch aborted");
    }
    managed = this.#adoptHosted(hosted, {
      release: launch.release,
      signal: launch.signal,
      recovered: false,
      ...(launch.requestedThinking ? { requestedThinking: launch.requestedThinking } : {}),
    });
    await hosted.start();
    void this.#monitor(managed, launch.timeoutMs);
    return this.#handleInfo(managed, "running");
  }

  #hostedHooks(managed: () => ManagedAgent | undefined): HostedRunHooks {
    return {
      questionTimeoutMs: this.config.childQuestionTimeoutMs ?? DEFAULT_CHILD_QUESTION_TIMEOUT_MS,
      ...(this.config.childQuestions === "route" && this.#onChildQuestion
        ? {
            ask: (question: Record<string, unknown>) => {
              const run = managed();
              return run ? this.#askParent(run, question) : Promise.resolve({ cancelled: true as const });
            },
          }
        : {}),
    };
  }

  #adoptHosted(
    hosted: HostedRun,
    options: {
      release: () => void;
      signal?: AbortSignal | undefined;
      /** Re-attached after a restart: background completion, usage already ledgered. */
      recovered: boolean;
      requestedThinking?: AgentRunRequest["thinking"];
    },
  ): ManagedAgent {
    const record = hosted.record;
    const recovered = options.recovered;
    const managed: ManagedAgent = {
      id: record.id,
      name: record.name,
      task: record.task,
      runner: record.runner,
      runnerAdapter: hosted.adapter,
      hosted,
      ...(hosted.context.kernel ? { kernel: hosted.context.kernel } : {}),
      recursive: false,
      residency: hosted.context.residency,
      cwd: record.cwd,
      statusFile: hosted.files.statusFile,
      lifecycleFile: hosted.files.lifecycleFile,
      lifecycleOffset: 0,
      lifecycleRemainder: Buffer.alloc(0),
      runDirectory: hosted.context.runDirectory,
      transport: hosted.handle,
      adapter: HOSTED_TRANSPORT,
      launch: { id: record.id, name: record.name, cwd: record.cwd, workerPath: "", workerArguments: [] },
      startupAttempts: 1,
      ...createAgentLifecycle<AgentRunResult>(options.release),
      abortSignal: options.signal,
      abortHandler: undefined,
      ...(record.model ? { model: record.model } : {}),
      ...(record.thinking ? { thinking: record.thinking } : {}),
      ...(options.requestedThinking ? { requestedThinking: options.requestedThinking } : {}),
      ...(record.branch ? { branch: record.branch } : {}),
      ...(record.worktree ? { worktree: record.worktree } : {}),
      settled: false,
      background: recovered,
      lastLivenessCheckAt: 0,
      resumeAttempts: 0,
      stopRequested: false,
      observedProgress: { turns: record.turns, toolCalls: record.toolCalls, usage: { ...record.usage } },
      // A recovered run's earlier usage reached the ledger before the restart.
      usageEmitted: recovered ? { ...record.usage } : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    };
    if (options.signal) {
      managed.abortHandler = () => this.#handleCallerAbort(managed.id);
      options.signal.addEventListener("abort", managed.abortHandler, { once: true });
    }
    this.#runs.set(managed.id, managed);
    this.#invalidateUiList();
    return managed;
  }

  /**
   * Re-attach hosted runs persisted under this run root, as after a resident
   * host restart. Recovery calls `attach`, never `start`: a run the adapter
   * cannot vouch for settles failed with outcome "indeterminate".
   */
  async recoverHostedRuns(): Promise<string[]> {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.#runRoot);
    } catch {
      return [];
    }
    const recovered: string[] = [];
    for (const entry of entries) {
      if (this.#closing || this.#runs.has(entry) || !/^[0-9a-f]{32}$/.test(entry)) continue;
      const runDirectory = path.join(this.#runRoot, entry);
      const statusFile = path.join(runDirectory, "status.json");
      const record = readRecord(statusFile);
      const state = readHostedRunState(path.join(runDirectory, HOSTED_STATE_FILE));
      if (
        !record?.hosted ||
        !state ||
        record.id !== entry ||
        state.context.id !== entry ||
        terminalStatuses.has(record.status)
      ) {
        continue;
      }
      const adapter = getAgentRunner(state.runner);
      let refusal = adapter?.kind !== "hosted"
        ? `Hosted runner ${state.runner} is not registered in this process; the run outcome is indeterminate`
        : undefined;
      // The persisted launch scope is re-validated; a damaged one never re-attaches unscoped.
      if (!refusal && state.context.scope !== undefined) {
        try {
          state.context = { ...state.context, scope: normalizeScope(state.context.scope) };
        } catch (error) {
          refusal = `Hosted run scope is invalid (${error instanceof Error ? error.message : String(error)}); the run outcome is indeterminate`;
        }
      }
      if (refusal || adapter?.kind !== "hosted") {
        const now = Date.now();
        const { currentTool: _tool, blockedOn: _blocked, sleeping: _sleeping, ...rest } = record;
        writeRecord(statusFile, {
          ...rest,
          status: "failed",
          error: refusal!,
          outcome: "indeterminate",
          finishedAt: now,
          updatedAt: now,
        });
        continue;
      }
      let managed: ManagedAgent | undefined;
      const hosted = HostedRun.recover(
        adapter,
        state,
        {
          statusFile,
          lifecycleFile: path.join(runDirectory, "lifecycle.jsonl"),
          logFile: path.join(runDirectory, "events.jsonl"),
          stateFile: path.join(runDirectory, HOSTED_STATE_FILE),
        },
        record,
        this.#hostedHooks(() => managed),
      );
      managed = this.#adoptHosted(hosted, { release: () => {}, recovered: true });
      await hosted.attach();
      void this.#monitor(managed, Math.max(0, state.context.deadlineAt - Date.now()));
      recovered.push(entry);
    }
    return recovered;
  }

  /** Park or resume a hosted run whose runner declares `sleep`. */
  async sleep(id: string): Promise<void> {
    await this.#requireHosted(id, "sleep").park("sleep");
  }

  async wake(id: string): Promise<void> {
    await this.#requireHosted(id, "sleep").park("wake");
  }

  #requireHosted(id: string, capability: "sleep"): HostedRun {
    const managed = this.#requireRun(id);
    if (!managed.hosted) throw new Error(`The ${managed.runnerAdapter.label} runner does not support ${capability}`);
    return managed.hosted;
  }

  async run(request: AgentRunRequest, signal?: AbortSignal): Promise<AgentRunResult> {
    const handle = await this.spawn(request, signal);
    return this.wait(handle.id);
  }

  async wait(id: string): Promise<AgentRunResult> {
    const managed = this.#requireRun(id);
    managed.background = false;
    if (!managed.settled) {
      if (!managed.result) throw new Error(`Agent ${id} has no pending result`);
      const result = await managed.result;
      this.#onResultConsumed?.(id);
      return result;
    }
    const record = readRecord(managed.statusFile) ?? managed.latestRecord;
    if (!record || !terminalStatuses.has(record.status)) {
      throw new Error(`Agent ${id} settled without a result`);
    }
    this.#onResultConsumed?.(id);
    return this.#withTransportMetadata(record, managed) as AgentRunResult;
  }

  markForeground(id: string): void {
    this.#requireRun(id).background = false;
    this.#onResultConsumed?.(id);
  }

  detachSignal(id: string): void {
    this.#detach(this.#requireRun(id), "caller detached; the run continues");
  }

  /**
   * An abort belongs to the caller, not to the run it started: a returned guest
   * program, a cancelled tool call, or a spent sandbox deadline must not discard
   * hours of participant work. A run that already produced progress is detached
   * and keeps going to a real terminal state; a run that never started working is
   * still stopped, because releasing it loses nothing.
   */
  #handleCallerAbort(id: string): void {
    const managed = this.#runs.get(id);
    if (!managed || managed.settled || this.#closing) return;
    if (!this.#observedWork(managed)) {
      void this.stop(id);
      return;
    }
    this.#detach(managed, "caller aborted; the run continues");
  }

  #detach(managed: ManagedAgent, reason: string): void {
    const attached = managed.abortSignal !== undefined || managed.abortHandler !== undefined;
    if (managed.abortSignal && managed.abortHandler) {
      managed.abortSignal.removeEventListener("abort", managed.abortHandler);
    }
    managed.abortSignal = undefined;
    managed.abortHandler = undefined;
    if (managed.background) return;
    managed.background = true;
    // A fast worker may settle before agents.spawn returns and detaches it.
    if (managed.settled) {
      const record = readRecord(managed.statusFile) ?? managed.latestRecord;
      if (record && terminalStatuses.has(record.status)) {
        this.#notifyBackgroundComplete(managed, this.#withTransportMetadata(record, managed) as AgentRunResult);
      }
    }
    if (attached) {
      this.#emitLifecycle(managed, "run.detached", Date.now(), { data: { reason } });
    }
  }

  #observedWork(managed: ManagedAgent): boolean {
    const { turns, toolCalls } = managed.observedProgress;
    if (turns > 0 || toolCalls > 0) return true;
    const record = managed.latestRecord ?? readRecord(managed.statusFile);
    return record !== undefined && (record.turns > 0 || record.toolCalls > 0);
  }

  /**
   * Track element-wise maxima of the run's counters. Usage components only grow
   * within a run, so a per-field maximum stays the cumulative total even when a
   * host-synthesized stop or transport-death record resets the counters to zero.
   */
  #observeProgress(managed: ManagedAgent, record: AgentRunRecord): void {
    const seen = managed.observedProgress;
    if (record.turns > seen.turns) seen.turns = record.turns;
    if (record.toolCalls > seen.toolCalls) seen.toolCalls = record.toolCalls;
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "cost"] as const) {
      if (record.usage[key] > seen.usage[key]) seen.usage[key] = record.usage[key];
    }
  }

  status(id: string): AgentRunRecord | AgentHandleInfo {
    const managed = this.#requireRun(id);
    const record = managed.settled
      ? readRecord(managed.statusFile) ?? managed.latestRecord
      : managed.latestRecord ?? readRecord(managed.statusFile);
    if (!record) return this.#handleInfo(managed, "running");
    managed.latestRecord = record;
    if (!managed.latestUiRecord) {
      managed.latestUiRecord = compactUiRecord(record);
      this.#invalidateUiList();
    }
    const result = structuredClone(this.#withTransportMetadata(record, managed));
    this.#pruneRetainedUiRecords();
    return result;
  }

  list(): Array<AgentRunRecord | AgentHandleInfo> {
    return [...this.#runs.keys()].map((id) => this.status(id));
  }

  listForUi(): Array<AgentRunRecord | AgentHandleInfo> {
    if (this.#uiListCache?.revision === this.#uiListRevision) {
      return this.#uiListCache.value;
    }
    const runs = [...this.#runs.values()];
    const active = runs.filter((managed) => !managed.settled);
    const settled = runs.filter((managed) => managed.settled);
    const retainedSettledCount = Math.max(0, MAX_RETAINED_UI_RUNS - active.length);
    const retainedSettled =
      retainedSettledCount > 0 ? settled.slice(-retainedSettledCount) : [];
    const visible = new Set([...active, ...retainedSettled]);
    const value = runs
      .filter((managed) => visible.has(managed))
      .map((managed) => {
        let record = managed.latestUiRecord;
        if (!record) {
          const latest = managed.latestRecord ?? readRecord(managed.statusFile);
          if (!latest) return this.#handleInfo(managed, "running");
          managed.latestRecord = latest;
          record = compactUiRecord(latest);
          managed.latestUiRecord = record;
        }
        return structuredClone(
          compactUiRecord(this.#withTransportMetadata(record, managed)),
        );
      });
    this.#uiListCache = { revision: this.#uiListRevision, value };
    return value;
  }

  runDirectory(id: string): string | undefined {
    return this.#runs.get(id)?.runDirectory;
  }

  worktreeGitRoot(id: string): string | undefined {
    return this.#worktrees.get(id)?.gitRoot;
  }

  async claudeModels(refresh = false): Promise<ClaudeModelInfo[]> {
    const now = Date.now();
    if (!refresh && this.#claudeModelsCache && now - this.#claudeModelsCache.at < 60_000) {
      return structuredClone(this.#claudeModelsCache.value);
    }
    const value = await discoverClaudeModels(this.#claudeBinary, this.cwd);
    this.#claudeModelsCache = { at: now, value };
    return structuredClone(value);
  }

  async stop(id: string): Promise<AgentRunResult> {
    const managed = this.#requireRun(id);
    // A requested stop is terminal: record the intent before any transport work
    // so recovery never restarts a run the operator, a tool, or shutdown ended.
    managed.stopRequested = true;
    if (managed.settled) return this.wait(id);
    managed.background = false;
    const existing = readRecord(managed.statusFile);
    if (existing && terminalStatuses.has(existing.status)) {
      const result = this.#withTransportMetadata(existing, managed) as AgentRunResult;
      await this.#captureWorktree(managed);
      this.#settle(managed, result);
      return result;
    }
    await this.#stopWorkerRunner(managed);
    await managed.transport.stop();
    await this.#waitForTransportExit(managed);
    const terminal = readRecord(managed.statusFile);
    const record =
      terminal && terminalStatuses.has(terminal.status)
        ? (this.#withTransportMetadata(terminal, managed) as AgentRunResult)
        : failedRecord(managed, "stopped", "Agent stopped");
    if (!terminal || !terminalStatuses.has(terminal.status)) writeRecord(managed.statusFile, record);
    await this.#captureWorktree(managed);
    this.#settle(managed, record);
    return record;
  }

  async cleanup(id: string, deleteBranch = false): Promise<{ cleaned: boolean }> {
    const managed = this.#requireRun(id);
    if (!managed.settled) throw new Error("Cannot clean up a running agent");
    this.markForeground(id);
    const cleaned = await this.#worktrees.cleanup(id, deleteBranch);
    if (!this.config.retainRuns) {
      await removeTree(managed.runDirectory);
    }
    this.#runs.delete(id);
    this.#pruneRetainedUiRecords();
    this.#invalidateUiList();
    return { cleaned: cleaned || !fs.existsSync(managed.runDirectory) };
  }

  readLog(id: string, opts: { lines?: number; before?: number } = {}): FabricAgentLog {
    const managed = this.#requireRun(id);
    const runDirectory = managed.runDirectory;
    const logFile = path.join(runDirectory, "events.jsonl");
    const lines = Math.max(1, Math.min(opts.lines ?? 200, 5000));
    const page = readJsonlPage(logFile, lines, opts.before);
    const statusRecord = readRecord(path.join(runDirectory, "status.json"));
    return {
      id,
      runDirectory,
      logFile,
      events: page.lines,
      hasMore: page.hasMore,
      ...(page.before !== undefined ? { before: page.before } : {}),
      ...(statusRecord ? { status: { ...statusRecord, cwd: managed.cwd } } : {}),
    };
  }

  steer(id: string, message: string, data?: unknown): AgentSteerResult {
    return this.#deliverMessage(id, "steer", message, data);
  }

  followUp(id: string, message: string, data?: unknown): AgentSteerResult {
    return this.#deliverMessage(id, "followUp", message, data);
  }

  // Runners without a turn channel (Veda runs one headless prompt per
  // invocation) reject here so callers learn at call time instead of the
  // command being silently dropped. Hosted runs are delivered by the adapter.
  #deliverMessage(id: string, kind: "steer" | "followUp", message: string, data?: unknown): AgentSteerResult {
    const managed = this.#requireRun(id);
    if (!managed.runnerAdapter.capabilities[kind]) {
      throw new Error(
        managed.runner === "veda"
          ? "The Veda runner does not support steering or follow-ups: Veda executes one headless prompt per invocation. Start a new run instead."
          : `The ${managed.runnerAdapter.label} runner does not support ${kind === "steer" ? "steering" : "follow-ups"}`,
      );
    }
    if (!managed.hosted) {
      return this.#appendSteer(id, { type: kind === "steer" ? "steer" : "follow_up", message, data });
    }
    if (managed.settled || managed.hosted.terminal) {
      throw new Error(`Fabric agent ${id} already finished; steering has no target`);
    }
    return { queued: true, messageId: managed.hosted.deliver(kind, message, data) };
  }

  setSteeringMode(id: string, mode: FabricSteeringMode): AgentSteerResult {
    this.#requireSteerFile(id);
    return this.#appendSteer(id, { type: "set_steering_mode", mode });
  }

  setFollowUpMode(id: string, mode: FabricSteeringMode): AgentSteerResult {
    this.#requireSteerFile(id);
    return this.#appendSteer(id, { type: "set_follow_up_mode", mode });
  }

  #requireSteerFile(id: string): void {
    const managed = this.#requireRun(id);
    if (managed.hosted) {
      throw new Error(`The ${managed.runnerAdapter.label} runner is hosted; it has no queue modes`);
    }
  }

  // Request an advisory compaction of a running Pi-runner child's context.
  // Appended to the same steer.jsonl channel as steer(); the worker queues it
  // until child agent_settled, then correlates Pi's compact response and
  // compaction_end before closing the one-shot RPC channel. Rejected for
  // Claude-runner children — the official Claude Code CLI exposes no compact
  // RPC; a fresh run is the only way to reset a Claude child's context.
  compact(id: string, instructions?: string): AgentSteerResult {
    const managed = this.#requireRun(id);
    if (!managed.runnerAdapter.capabilities.compaction) {
      throw new Error(
        BUILT_IN_RUNNER_IDS.has(managed.runner)
          ? "Fabric agent compaction is only supported for Pi-runner children; Claude Code and Veda sessions cannot be compacted through Fabric."
          : `The ${managed.runnerAdapter.label} runner does not declare the compaction capability`,
      );
    }
    return this.#appendSteer(id, {
      type: "compact",
      ...(typeof instructions === "string" && instructions ? { instructions } : {}),
    });
  }

  #appendSteer(id: string, entry: Omit<AgentSteerEntry, "id" | "ts">): AgentSteerResult {
    const managed = this.#requireRun(id);
    const record = readRecord(managed.statusFile);
    if (record && terminalStatuses.has(record.status)) {
      throw new Error(
        `Fabric agent ${id} already finished (${record.status}); steering has no target`,
      );
    }
    const steerFile = path.join(managed.runDirectory, "steer.jsonl");
    const messageId = randomUUID();
    const line = JSON.stringify({ ...entry, id: messageId, ts: Date.now() }) + "\n";
    fs.appendFileSync(steerFile, line, { encoding: "utf8", mode: 0o600 });
    return { queued: true, messageId };
  }

  close(): Promise<void> {
    this.#closing = true;
    this.#closeAbort.abort(new Error("Fabric agent manager is closing"));
    return this.#closePromise ??= this.#close();
  }

  async #close(): Promise<void> {
    this.#uiListeners.clear();
    if (this.#retentionTimer) clearInterval(this.#retentionTimer);
    this.#retentionTimer = undefined;
    await this.#retentionSweep?.catch(() => undefined);
    // A durable hosted run outlives this host: detach it and keep its locator
    // on disk so the next resident host re-attaches instead of stopping it.
    const detached = [...this.#runs.values()].filter(
      (managed) => !managed.settled && managed.hosted && managed.residency === "durable",
    );
    for (const managed of detached) managed.hosted!.detach();
    const running = [...this.#runs.values()].filter((managed) => !managed.settled && !detached.includes(managed));
    for (const managed of running) managed.hosted?.markShutdown();
    await Promise.allSettled(running.map((managed) => this.stop(managed.id)));
    await Promise.allSettled([...this.#spawns]);
    await Promise.allSettled([...this.#launches]);
    const all = [...this.#runs.values()];
    await Promise.allSettled(all.map((managed) => this.#waitForTransportExit(managed)));
    const transports = [...all.map((managed) => managed.transport), ...this.#unregisteredTransports];
    const alive = await Promise.all(transports.map((transport) => transport.isAlive().catch(() => true)));
    // A failed stop is not authority to delete a child's working files.
    if (detached.length === 0 && !alive.some(Boolean)) {
      this.#unregisteredTransports.clear();
      const storageSafe = !this.#managedTempRoot || canRemoveManagedRunRoot(this.#runRoot);
      if (!this.config.retainRuns) {
        if (storageSafe && !this.#parentOwnedRunRoot) {
          await removeTree(this.#runRoot).catch(() => undefined);
        }
      } else if (this.#managedTempRoot) {
        try { markRunRootClosed(this.#runRoot, Date.now(), true); } catch {}
        removeEmptyRunRoot(this.#runRoot);
      }
      if (storageSafe && this.#budgetOwned && this.#budget) {
        await removeTree(path.dirname(this.#budget.file)).catch(() => undefined);
      }
    }
    if (this.#budgetOwned) clearOwnedBudgetEnv();
    if (this.#managedTempRoot) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      try {
        sweepTempRunRoots({
          tempRoot: os.tmpdir(),
          currentRoot: this.#runRoot,
          orphanedTempRunRetentionMs: this.#retention.orphanedTempRunMs,
          oneShotRunRetentionMs: this.#retention.oneShotRunMs,
        });
      } catch {}
    }
  }

  #scheduleRetentionSweep(): void {
    if (this.#closing || this.#retentionSweep) return;
    this.#retentionSweep = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => this.#closing ? undefined : this.#runRetentionSweep()).catch(() => undefined).finally(() => {
      this.#retentionSweep = undefined;
    });
  }

  async #runRetentionSweep(now = Date.now()): Promise<void> {
    if (this.#managedTempRoot) {
      heartbeatRunRoot(this.#runRoot, now);
      sweepTempRunRoots({
        tempRoot: os.tmpdir(),
        currentRoot: this.#runRoot,
        orphanedTempRunRetentionMs: this.#retention.orphanedTempRunMs,
        oneShotRunRetentionMs: this.#retention.oneShotRunMs,
        now,
      });
    }
    const expired = [...this.#runs.values()].filter((managed) => {
      if (!managed.settled || managed.actorId) return false;
      const record = readRecord(managed.statusFile) ?? managed.latestRecord;
      const finishedAt = record?.finishedAt ?? record?.updatedAt;
      return typeof finishedAt === "number" && now - finishedAt >= this.#retention.oneShotRunMs;
    });
    for (const managed of expired) {
      await removeTree(managed.runDirectory).catch(() => undefined);
      if (!fs.existsSync(managed.runDirectory)) this.#runs.delete(managed.id);
    }
    if (expired.length > 0) {
      this.#pruneRetainedUiRecords();
      this.#invalidateUiList();
    }
  }

  /** A custom worker runner's own stop hook, before the transport kills the process. */
  async #stopWorkerRunner(managed: ManagedAgent): Promise<void> {
    const runner = managed.runnerAdapter;
    if (runner.kind !== "worker" || !runner.stop) return;
    await Promise.resolve()
      .then(() => runner.stop!({ id: managed.id, runDirectory: managed.runDirectory }))
      .catch(() => undefined);
  }

  async #waitForTransportExit(managed: ManagedAgent): Promise<void> {
    const deadline = Date.now() + TRANSPORT_EXIT_GRACE_MS * 7;
    const pollIntervalMs =
      managed.transport.livenessPollIntervalMs ?? AGENT_STATUS_POLL_INTERVAL_MS;
    while (Date.now() < deadline && (await managed.transport.isAlive())) {
      await delay(pollIntervalMs);
    }
  }

  async #retryStartup(
    managed: ManagedAgent,
    record: AgentRunRecord,
    deadline: number,
  ): Promise<boolean> {
    if (
      managed.hosted ||
      // A custom worker that already made progress is never re-run blind.
      (!BUILT_IN_RUNNER_IDS.has(managed.runner) && this.#observedWork(managed)) ||
      managed.startupAttempts >= AGENT_STARTUP_MAX_ATTEMPTS ||
      managed.settled ||
      this.#closing ||
      managed.abortSignal?.aborted ||
      record.status !== "failed" ||
      !(
        ((managed.runner === "pi" || managed.runner === "pi-durable") && retryablePiStartupError(record.error)) ||
        transportExitedWithoutResult(record.error)
      ) ||
      record.turns !== 0 ||
      record.toolCalls !== 0 ||
      record.usage.input !== 0 ||
      record.usage.output !== 0 ||
      record.usage.cacheRead !== 0 ||
      record.usage.cacheWrite !== 0
    ) {
      return false;
    }
    const retryDelayMs =
      AGENT_STARTUP_RETRY_BASE_DELAY_MS * 2 ** (managed.startupAttempts - 1);
    if (Date.now() + retryDelayMs >= deadline) return false;
    await this.#waitForTransportExit(managed);
    await delay(retryDelayMs);
    if (managed.settled || this.#closing || managed.abortSignal?.aborted) return false;
    managed.startupAttempts++;
    return this.#relaunch(managed, record);
  }

  /**
   * An unexpected mid-run stop — the worker caught a signal, or its transport
   * died with work already done — is recoverable. Relaunch the same run in the
   * same directory, seeded with the cumulative prefix of the attempt it lost, so
   * a long participant finishes instead of reporting a terminal stop that throws
   * away hours of work. Explicit stops, timeouts, and spent deadlines stay
   * terminal; AGENT_RESUME_MAX_ATTEMPTS bounds the retries.
   */
  async #resumeStopped(
    managed: ManagedAgent,
    record: AgentRunRecord,
    deadline: number,
  ): Promise<boolean> {
    if (
      // Fabric never re-prompts a hosted run, and only its own worker
      // understands the continuation task and --carry-over prefix.
      managed.hosted ||
      !BUILT_IN_RUNNER_IDS.has(managed.runner) ||
      managed.settled ||
      this.#closing ||
      managed.stopRequested ||
      managed.resumeAttempts >= AGENT_RESUME_MAX_ATTEMPTS ||
      !this.#observedWork(managed) ||
      !recoverableStop(record)
    ) {
      return false;
    }
    const retryDelayMs = AGENT_RESUME_RETRY_BASE_DELAY_MS * 2 ** managed.resumeAttempts;
    if (Date.now() + retryDelayMs >= deadline) return false;
    await this.#waitForTransportExit(managed);
    await delay(retryDelayMs);
    if (managed.settled || this.#closing || managed.stopRequested) return false;
    managed.resumeAttempts += 1;
    const { turns, toolCalls, usage } = managed.observedProgress;
    return this.#relaunch(managed, record, {
      // Durable recovery reopens the same journal, not a fresh conversation.
      // Changing its prompt breaks recorded-result identity after completion.
      task: managed.runner === "pi-durable"
        ? managed.task
        : resumeTask(managed.task, record, { turns, toolCalls }, managed.runDirectory),
      carryOver: { turns, toolCalls, usage: { ...usage } },
    });
  }

  /**
   * Relaunch the same worker run in place. Shared by the startup retry (a child
   * that died before producing a result) and the mid-run resume, which differ
   * only in the task the child is handed and the cumulative prefix its fresh
   * record starts from.
   */
  async #relaunch(
    managed: ManagedAgent,
    record: AgentRunRecord,
    resume?: { task: string; carryOver: AgentRunCarryOver },
  ): Promise<boolean> {
    try {
      if (managed.runner === "pi" || managed.runner === "pi-durable") {
        const model = await this.#prepareModel(managed.model);
        const modelIndex = managed.launch.workerArguments.indexOf("--model");
        if (model) {
          if (modelIndex >= 0) managed.launch.workerArguments[modelIndex + 1] = model;
          else managed.launch.workerArguments.push("--model", model);
          managed.model = model;
        } else if (modelIndex >= 0) {
          managed.launch.workerArguments.splice(modelIndex, 2);
          delete managed.model;
        }
      }
      if (resume) {
        fs.writeFileSync(path.join(managed.runDirectory, "task.txt"), resume.task, {
          encoding: "utf8",
          mode: 0o600,
        });
        setWorkerArgument(
          managed.launch.workerArguments,
          "carry-over",
          JSON.stringify(resume.carryOver),
        );
      }
      // The relaunched child owns a fresh status/lifecycle pair, so drain what
      // the previous attempt published (token usage above all) before discarding
      // the journal it landed in.
      this.#drainLifecycle(managed);
      fs.rmSync(managed.statusFile, { force: true });
      if (managed.settled || this.#closing || managed.stopRequested) return false;
      managed.transport = await this.#launchTransport(managed.adapter, managed.launch);
      this.#unregisteredTransports.delete(managed.transport);
      if (managed.settled || this.#closing || managed.stopRequested) {
        // A stop landed while the relaunch was in flight. Release the child we
        // just started so it cannot outlive the monitor and the stop path can
        // publish its terminal record.
        await managed.transport.stop().catch(() => undefined);
        return false;
      }
      delete managed.latestRecord;
      delete managed.latestUiRecord;
      managed.lastLivenessCheckAt = 0;
      managed.lifecycleOffset = 0;
      managed.lifecycleRemainder = Buffer.alloc(0);
      fs.rmSync(managed.lifecycleFile, { force: true });
      if (resume) {
        this.#emitLifecycle(managed, "run.resumed", Date.now(), {
          data: {
            attempt: managed.resumeAttempts,
            attemptsAllowed: AGENT_RESUME_MAX_ATTEMPTS,
            previousStatus: record.status,
            ...(record.error ? { previousError: record.error } : {}),
            carriedTurns: resume.carryOver.turns,
            carriedToolCalls: resume.carryOver.toolCalls,
          },
        });
      }
      this.#invalidateUiList();
      return true;
    } catch (error) {
      const retryError = error instanceof Error ? error.message : String(error);
      const failed = {
        ...record,
        // Keep the run's real progress: the relaunch failed, not the attempt.
        turns: Math.max(record.turns, managed.observedProgress.turns),
        toolCalls: Math.max(record.toolCalls, managed.observedProgress.toolCalls),
        error: `${record.error ?? "Agent run failed"} · relaunch failed: ${retryError}`,
      };
      writeRecord(managed.statusFile, failed);
      managed.latestRecord = failed;
      return false;
    }
  }

  async #monitor(managed: ManagedAgent, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs + TRANSPORT_EXIT_GRACE_MS;
    let firstObservedDeadAt: number | undefined;
    while (!managed.settled) {
      // A detached durable hosted run is re-attached by the next host.
      if (managed.hosted?.detached) return;
      this.#drainLifecycle(managed);
      const record = readRecord(managed.statusFile);
      if (record) {
        this.#observeProgress(managed, record);
        const previous = managed.latestRecord;
        managed.latestRecord = record;
        if (
          !previous ||
          previous.updatedAt !== record.updatedAt ||
          previous.status !== record.status ||
          previous.currentTool !== record.currentTool
        ) {
          managed.latestUiRecord = compactUiRecord(record);
          this.#invalidateUiList();
        }
      }
      if (managed.recursive) this.#nestedAgents(managed);
      if (record?.runnerSessionId && !managed.runnerSessionId) {
        managed.runnerSessionId = record.runnerSessionId;
      }
      if (record && terminalStatuses.has(record.status)) {
        if (await this.#resumeStopped(managed, record, deadline)) continue;
        if (await this.#retryStartup(managed, record, deadline)) continue;
        await this.#captureWorktree(managed);
        this.#settle(managed, this.#withTransportMetadata(record, managed) as AgentRunResult);
        return;
      }
      if (Date.now() >= deadline) {
        await this.#stopWorkerRunner(managed);
        await managed.transport.stop();
        await this.#waitForTransportExit(managed);
        const completed = readRecord(managed.statusFile);
        if (
          completed &&
          terminalStatuses.has(completed.status) &&
          completed.status !== "stopped"
        ) {
          await this.#captureWorktree(managed);
          this.#settle(
            managed,
            this.#withTransportMetadata(completed, managed) as AgentRunResult,
          );
          return;
        }
        if (managed.lastRetriedTransportFailure) {
          // The deadline fired mid-retry: the root cause is the dead transport
          // we were recovering from, not runaway wall time. Report that failure.
          await this.#captureWorktree(managed);
          this.#settle(
            managed,
            this.#withTransportMetadata(
              managed.lastRetriedTransportFailure,
              managed,
            ) as AgentRunResult,
          );
          return;
        }
        const timedOut = failedRecord(
          managed,
          "timed_out",
          `Agent timed out after ${timeoutMs}ms`,
        );
        writeRecord(managed.statusFile, timedOut);
        await this.#captureWorktree(managed);
        this.#settle(managed, timedOut);
        return;
      }
      const livenessPollIntervalMs =
        managed.transport.livenessPollIntervalMs ?? AGENT_STATUS_POLL_INTERVAL_MS;
      const livenessCheckedAt = Date.now();
      if (livenessCheckedAt - managed.lastLivenessCheckAt >= livenessPollIntervalMs) {
        managed.lastLivenessCheckAt = livenessCheckedAt;
        const alive = await managed.transport.isAlive();
        if (!alive) {
          firstObservedDeadAt ??= livenessCheckedAt;
          if (livenessCheckedAt - firstObservedDeadAt >= TRANSPORT_EXIT_GRACE_MS) {
            if (managed.hosted) {
              if (managed.hosted.detached) return;
              const lost = managed.hosted.settleLost();
              this.#drainLifecycle(managed);
              await this.#captureWorktree(managed);
              this.#settle(managed, this.#withTransportMetadata(lost, managed) as AgentRunResult);
              return;
            }
            const logSummary = summarizeRunLog(managed.runDirectory, 8);
            const stderr = managed.transport.readStderr?.().trim();
            const diagnostic = [logSummary ? `last run log: ${logSummary}` : undefined, stderr ? `worker stderr: ${stderr}` : undefined]
              .filter(Boolean).join("; ");
            const failed = failedRecord(
              managed,
              "failed",
              diagnostic
                ? `Agent transport exited without a result; ${diagnostic}`
                : "Agent transport exited without a result",
            );
            if (await this.#resumeStopped(managed, failed, deadline)) continue;
            if (await this.#retryStartup(managed, failed, deadline)) {
              managed.lastRetriedTransportFailure = failed;
              continue;
            }
            writeRecord(managed.statusFile, failed);
            await this.#captureWorktree(managed);
            this.#settle(managed, failed);
            return;
          }
        } else {
          firstObservedDeadAt = undefined;
        }
      }
      await delay(AGENT_STATUS_POLL_INTERVAL_MS);
    }
  }

  /** Bounded worktree diff, captured once before settlement. */
  async #captureWorktree(managed: ManagedAgent): Promise<void> {
    if (!managed.worktree || managed.worktreeResult || managed.settled) return;
    // summarize() reports git failures as diffError; anything else leaves the result unset.
    const summary = await this.#worktrees.summarize(managed.id).catch(() => undefined);
    if (summary) managed.worktreeResult = summary;
  }

  #settle(managed: ManagedAgent, result: AgentRunResult): void {
    if (managed.settled) return;
    if (managed.worktreeResult) result.worktreeResult = managed.worktreeResult;
    // Every terminal path (including explicit stop and lost transport) gets a
    // final unthrottled read before freezing the nested status tree.
    const nested = this.#nestedAgents(managed, true);
    if (nested.length > 0) result.nestedAgents = reconcileNestedAgents(nested, result);
    this.#drainLifecycle(managed);
    if (!beginAgentSettlement(managed)) return;
    managed.questions?.abort(new Error("Agent run settled"));
    managed.hosted?.close();
    // Images are transport inputs, not retained run artifacts. Startup retries
    // have finished by settlement, so remove the owner-only handoff file for
    // every terminal outcome even when retainRuns keeps the rest of the run.
    fs.rmSync(path.join(managed.runDirectory, "images.json"), { force: true });
    this.#emitLifecycle(managed, `run.${result.status}`, result.finishedAt ?? Date.now(), {
      status: result.status,
    });

    if (this.#budget) {
      this.#settleBudgetGap(managed, result);
      const summary = this.#budgetSummary();
      if (summary) result.budget = summary;
    }
    const compactResult = compactUiRecord(result);
    managed.latestRecord = compactResult;
    managed.latestUiRecord = compactResult;
    if (result.nestedAgents) {
      managed.nestedSnapshot = result.nestedAgents.map((record) => compactUiRecord(record));
    }
    this.#pruneRetainedUiRecords();
    this.#invalidateUiList();
    finishAgentSettlement(managed, result);
    managed.task = "";
    this.#notifyBackgroundComplete(managed, result);
  }

  #notifyBackgroundComplete(managed: ManagedAgent, result: AgentRunResult): void {
    if (
      managed.background &&
      !managed.completionNotified &&
      !this.#closing &&
      this.config.notifyOnComplete &&
      this.#onBackgroundComplete
    ) {
      managed.completionNotified = true;
      try {
        this.#onBackgroundComplete(result);
      } catch { /* completion callback must not break the manager */ }
    }
  }

  #drainLifecycle(managed: ManagedAgent): void {
    let content: Buffer;
    try {
      content = fs.readFileSync(managed.lifecycleFile);
    } catch {
      return;
    }
    if (content.length < managed.lifecycleOffset) {
      managed.lifecycleOffset = 0;
      managed.lifecycleRemainder = Buffer.alloc(0);
    }
    if (content.length === managed.lifecycleOffset) return;
    const appended = content.subarray(managed.lifecycleOffset);
    managed.lifecycleOffset = content.length;
    const combined = Buffer.concat([managed.lifecycleRemainder, appended]);
    const finalNewline = combined.lastIndexOf(0x0a);
    if (finalNewline < 0) {
      managed.lifecycleRemainder = combined.length <= 64 * 1024 ? combined : Buffer.alloc(0);
      return;
    }
    managed.lifecycleRemainder = combined.subarray(finalNewline + 1);
    const complete = combined.subarray(0, finalNewline).toString("utf8");
    for (const line of complete.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (parsed.version !== 1 || typeof parsed.occurredAt !== "number") continue;
        if (parsed.event === "question") {
          this.#routeChildQuestion(managed, parsed.data);
          continue;
        }
        if (parsed.event === "tokens.usage") {
          if (!Object.prototype.hasOwnProperty.call(parsed, "data")) continue;
          const usage = tokenUsagePayloadFromValue(parsed.data);
          if (usage) this.#onTokenUsage(managed, usage, parsed.occurredAt);
          continue;
        }
        if (
          !isFabricLifecycleEventType(parsed.event) ||
          !parsed.event.startsWith("pi.")
        ) continue;
        this.#emitLifecycle(
          managed,
          parsed.event,
          parsed.occurredAt,
          Object.prototype.hasOwnProperty.call(parsed, "data") ? { data: parsed.data } : {},
        );
      } catch {
        // Ignore malformed worker lifecycle records; status monitoring remains authoritative.
      }
    }
  }

  // Answer one routed child dialog through the steer channel. Without a router
  // (or on any router failure) the child gets a cancelled response.
  #routeChildQuestion(managed: ManagedAgent, data: unknown): void {
    if (typeof data !== "object" || data === null || typeof (data as { requestId?: unknown }).requestId !== "string") return;
    const question = data as Record<string, unknown>;
    const respond = (response: AgentChildQuestionResponse): void => {
      try {
        fs.appendFileSync(
          path.join(managed.runDirectory, "steer.jsonl"),
          `${JSON.stringify({ type: "ui_response", requestId: question.requestId, ...response, id: randomUUID(), ts: Date.now() })}\n`,
          { encoding: "utf8", mode: 0o600 },
        );
      } catch {
        // The worker's own deadline cancels the dialog if this write is lost.
      }
    };
    if (!managed.runnerAdapter.capabilities.questions) {
      respond({ cancelled: true });
      return;
    }
    void this.#askParent(managed, question).then((response) => {
      if (!managed.settled) respond(response);
    });
  }

  /** One routed dialog for a worker or hosted run; any failure cancels it. */
  #askParent(managed: ManagedAgent, question: Record<string, unknown>): Promise<AgentChildQuestionResponse> {
    if (!this.#onChildQuestion || managed.settled) return Promise.resolve({ cancelled: true });
    managed.questions ??= new AbortController();
    return this.#onChildQuestion({
      runId: managed.id,
      name: managed.actorName ?? managed.name,
      ...(managed.actorId ? { actorId: managed.actorId } : {}),
      question,
      signal: managed.questions.signal,
      onDecision: (decisionId) => {
        managed.questionDecisionId = decisionId;
        this.#invalidateUiList();
      },
    }).catch((): AgentChildQuestionResponse => ({ cancelled: true })).then((response) => {
      delete managed.questionDecisionId;
      this.#invalidateUiList();
      return response;
    });
  }

  #appendAttributedBudgetLedger(
    managed: ManagedAgent,
    tokens: number,
    cost: number,
  ): void {
    if (!this.#budget || (tokens <= 0 && cost <= 0)) return;
    appendBudgetLedger(this.#budget.file, {
      id: managed.id,
      depth: this.#currentDepth + 1,
      runner: managed.runner,
      ...(managed.actorId ? { actorId: managed.actorId } : {}),
      ...(managed.actorName ? { actorName: managed.actorName } : {}),
      cost,
      tokens,
      ts: Date.now(),
    });
    this.#budgetSummaryCache = undefined;
  }

  #onTokenUsage(
    managed: ManagedAgent,
    usage: FabricTokenUsagePayload,
    occurredAt: number,
  ): void {
    managed.usageEmitted.input += usage.input;
    managed.usageEmitted.output += usage.output;
    managed.usageEmitted.cacheRead += usage.cacheRead;
    managed.usageEmitted.cacheWrite += usage.cacheWrite;
    managed.usageEmitted.cost += usage.cost;
    this.#appendAttributedBudgetLedger(managed, usage.input + usage.output + usage.cacheRead + usage.cacheWrite, usage.cost);
    this.#emitLifecycle(managed, "tokens.usage", occurredAt, { data: usage });
  }

  #settleBudgetGap(managed: ManagedAgent, result: AgentRunResult): void {
    const total = result.usage;
    const residual = {
      input: Math.max(0, total.input - managed.usageEmitted.input),
      output: Math.max(0, total.output - managed.usageEmitted.output),
      cacheRead: Math.max(0, total.cacheRead - managed.usageEmitted.cacheRead),
      cacheWrite: Math.max(0, total.cacheWrite - managed.usageEmitted.cacheWrite),
      cost: Math.max(0, total.cost - managed.usageEmitted.cost),
    };
    const residualTokens =
      residual.input + residual.output + residual.cacheRead + residual.cacheWrite;
    this.#appendAttributedBudgetLedger(managed, residualTokens, residual.cost);
  }

  #emitLifecycle(
    managed: ManagedAgent,
    event: FabricLifecycleEventType,
    occurredAt: number,
    options: { status?: string; data?: unknown } = {},
  ): void {
    if (!this.#onLifecycle) return;
    try {
      this.#onLifecycle({
        source: {
          id: managed.actorId ?? managed.id,
          name: managed.actorName ?? managed.name,
          kind: managed.actorId ? "actor" : "agent",
          rootId: this.#mainAgentId ?? managed.id,
          runner: managed.runner,
          ...(this.#hostId ? { ownerHostId: this.#hostId } : {}),
          ...(this.#identityId ? { ownerIdentityId: this.#identityId } : {}),
        },
        event,
        occurredAt,
        runId: managed.id,
        ...(options.status ? { status: options.status } : {}),
        ...(options.data === undefined ? {} : { data: options.data }),
      });
    } catch {
      // Lifecycle observers must not interrupt child execution or settlement.
    }
  }

  readonly #inheritedToolAllowlist = readChildToolAllowlist();

  #childTools(request: AgentRunRequest, runner: FabricRunnerAdapter, requiresFabricKernel = false): string[] {
    const tools = [...(request.tools ?? this.config.defaultTools)].filter(
      (tool) => tool !== "fabric_exec" &&
        (this.#inheritedToolAllowlist === undefined || this.#inheritedToolAllowlist.has(tool)),
    );
    const extensions = request.recursive === true
      ? true
      : (request.extensions ?? this.config.extensions);
    if (
      runner.capabilities.recursiveFabric &&
      (request.recursive || ((this.#fullCodeMode || requiresFabricKernel) && extensions))
    ) {
      tools.push("fabric_exec");
    }
    return [...new Set(tools)];
  }

  #budgetSummary(): FabricBudgetSummary | undefined {
    if (!this.#budget) return undefined;
    const now = Date.now();
    if (this.#budgetSummaryCache && now - this.#budgetSummaryCache.at < AGENT_STATUS_POLL_INTERVAL_MS) {
      return this.#budgetSummaryCache.value;
    }
    const { cost, tokens } = readBudgetLedger(this.#budget.file);
    const value = {
      limit: this.#budget.budget,
      spent: cost,
      remaining: Math.max(0, this.#budget.budget - cost),
      tokens,
    };
    this.#budgetSummaryCache = { at: now, value };
    return value;
  }

  async #resolveTransport(requested: FabricAgentTransport): Promise<AgentTransportAdapter> {
    if (requested !== "auto") {
      const adapter = this.#transports.get(requested);
      if (!adapter || !(await adapter.available())) {
        throw new Error(`Fabric agent transport is unavailable: ${requested}`);
      }
      return adapter;
    }
    for (const kind of ["herdr", "localterm", "tmux", "screen", "process"] as const) {
      const adapter = this.#transports.get(kind);
      if (adapter && (await adapter.available())) return adapter;
    }
    throw new Error("No Fabric agent transport is available");
  }

  #pruneRetainedUiRecords(): void {
    const settled = [...this.#runs.values()].filter((managed) => managed.settled);
    const evicted = settled.slice(0, -MAX_RETAINED_RUN_HANDLES);
    for (const managed of evicted) this.#runs.delete(managed.id);
    const retained = evicted.length > 0 ? settled.slice(evicted.length) : settled;
    if (retained.length <= MAX_RETAINED_UI_RUNS) return;
    for (const managed of retained.slice(0, -MAX_RETAINED_UI_RUNS)) {
      delete managed.latestRecord;
      delete managed.latestUiRecord;
      delete managed.nestedSnapshot;
      delete managed.nestedSnapshotAt;
    }
  }

  #invalidateUiList(): void {
    this.#uiListRevision++;
    this.#uiListCache = undefined;
    for (const listener of this.#uiListeners) {
      try {
        listener();
      } catch {
        // UI observers must not interrupt agent state transitions.
      }
    }
  }

  #requireRun(id: string): ManagedAgent {
    const managed = this.#runs.get(id);
    if (!managed) throw new Error(`Unknown Fabric agent: ${id}`);
    return managed;
  }

  #handleInfo(managed: ManagedAgent, status: AgentHandleInfo["status"]): AgentHandleInfo {
    const model = managed.latestRecord?.model ?? managed.model;
    const thinking = managed.latestRecord?.thinking ?? managed.thinking;
    return {
      id: managed.id,
      name: managed.name,
      status,
      runner: managed.runner,
      ...(managed.kernel ? { kernel: managed.kernel } : {}),
      transport: managed.transport.kind,
      cwd: managed.cwd,
      ...(managed.residency === "durable" ? { residency: "durable" as const } : {}),
      ...(model ? { model } : {}),
      ...(thinking ? { thinking } : {}),
      ...(managed.requestedThinking ? { requestedThinking: managed.requestedThinking } : {}),
      ...(managed.actorId ? { actorId: managed.actorId } : {}),
      ...(managed.actorName ? { actorName: managed.actorName } : {}),
      ...(managed.capabilityRequirements
        ? { capabilityRequirements: [...managed.capabilityRequirements] }
        : {}),
      ...(managed.capabilityDigest ? { capabilityDigest: managed.capabilityDigest } : {}),
      ...(managed.recursive ? { recursive: true } : {}),
      ...(managed.runnerSessionId ? { runnerSessionId: managed.runnerSessionId } : {}),
      ...(managed.transport.sessionId ? { sessionId: managed.transport.sessionId } : {}),
      ...(managed.transport.attachCommand
        ? { attachCommand: managed.transport.attachCommand }
        : {}),
      ...(managed.branch ? { branch: managed.branch } : {}),
      ...(managed.worktree ? { worktree: managed.worktree } : {}),
    };
  }

  // Retain a bounded tree even when legacy workers removed their nested run
  // directories. Terminal-owner reconciliation prevents cached active ghosts.
  #nestedAgents(managed: ManagedAgent, force = false): AgentRunRecord[] {
    const now = Date.now();
    const needsInitialDiscovery =
      managed.nestedSnapshot === undefined &&
      fs.existsSync(path.join(managed.runDirectory, "nested"));
    if (
      !force &&
      !needsInitialDiscovery &&
      managed.nestedSnapshotAt !== undefined &&
      now - managed.nestedSnapshotAt < NESTED_SNAPSHOT_POLL_MS
    ) {
      return managed.nestedSnapshot ? structuredClone(managed.nestedSnapshot) : [];
    }
    managed.nestedSnapshotAt = now;
    const discovered = readNestedAgents(managed.runDirectory);
    if (discovered.length > 0) {
      managed.nestedSnapshot = discovered;
      this.#invalidateUiList();
    }
    return managed.nestedSnapshot ? structuredClone(managed.nestedSnapshot) : [];
  }

  #withTransportMetadata(record: AgentRunRecord, managed: ManagedAgent): AgentRunRecord {
    const nestedAgents = reconcileNestedAgents(this.#nestedAgents(
      managed,
      terminalStatuses.has(record.status) && !managed.settled,
    ), record);
    const budget = this.#budgetSummary();
    const { logFile: _logFile, nestedAgents: _nestedAgents, ...safeRecord } = record;
    const model = record.model ?? managed.model;
    const thinking = record.thinking ?? managed.thinking;
    return {
      ...safeRecord,
      cwd: managed.cwd,
      runner: managed.runner,
      ...(managed.kernel ? { kernel: managed.kernel } : {}),
      ...(managed.residency === "durable" ? { residency: "durable" as const } : {}),
      logFile: path.join(managed.runDirectory, "events.jsonl"),
      ...(nestedAgents.length > 0 ? { nestedAgents } : {}),
      ...(budget ? { budget } : {}),
      ...(model ? { model } : {}),
      ...(thinking ? { thinking } : {}),
      ...(managed.requestedThinking ? { requestedThinking: managed.requestedThinking } : {}),
      ...(managed.actorId ? { actorId: managed.actorId } : {}),
      ...(managed.actorName ? { actorName: managed.actorName } : {}),
      ...(managed.capabilityRequirements
        ? { capabilityRequirements: [...managed.capabilityRequirements] }
        : {}),
      ...(managed.capabilityDigest ? { capabilityDigest: managed.capabilityDigest } : {}),
      ...(managed.recursive ? { recursive: true } : {}),
      ...(managed.runnerSessionId ? { runnerSessionId: managed.runnerSessionId } : {}),
      ...(managed.transport.sessionId ? { sessionId: managed.transport.sessionId } : {}),
      ...(managed.transport.attachCommand
        ? { attachCommand: managed.transport.attachCommand }
        : {}),
      ...(managed.branch ? { branch: managed.branch } : {}),
      ...(managed.worktree ? { worktree: managed.worktree } : {}),
      ...(managed.worktreeResult ? { worktreeResult: managed.worktreeResult } : {}),
      ...(record.blockedOn && managed.questionDecisionId
        ? { blockedOn: { ...record.blockedOn, decisionId: managed.questionDecisionId } }
        : {}),
    };
  }
}
