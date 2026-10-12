import type { ImageContent } from "@earendil-works/pi-ai";
import type {
  SessionEntry,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import type { FabricAgentRunner, FabricAgentTransport, FabricPythonRuntime } from "../config.js";
import type { FabricKernel } from "../runtime/kernel.js";
import type { FabricScope, FabricScopeGrant } from "../protocol.js";
import type { ThinkingTransferInput } from "./thinking-transfer.js";
import type { FabricThinking, FabricThinkingBounds } from "../thinking.js";
import type { FabricParticipantResidency } from "../topology/types.js";
import type { InheritedSessionPin } from "./session-pins.js";
import type { AgentWorktreeResult } from "./worktree-manager.js";

/** Fabric run transports plus adapter-owned ("hosted") runs. */
export type AgentRunTransport = FabricAgentTransport | "hosted";

/**
 * A terminal outcome Fabric cannot vouch for: the run may or may not have done
 * its work (an interrupted claimed request, an unreachable hosted run). Fabric
 * never replays such work.
 */
export type FabricRunOutcome = "indeterminate";

export type AgentRunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "stopped"
  | "timed_out";

export type AgentToolResultMessage = Extract<
  SessionMessageEntry["message"],
  { role: "toolResult" }
>;

/** Deterministic Fabric compaction applied to the inherited handoff trajectory. */
export interface HandoffCompactionRequest {
  instructions?: string;
  preserve?: string[];
}

export interface AgentSessionSeed {
  sourceSessionId: string;
  sourceSessionFile?: string;
  sourceBranchLeafId: string;
  /** Present only when the source session is in memory and must be materialized. */
  sourceBranch?: SessionEntry[];
  sourceModel?: { provider: string; modelId: string };
  sourceThinkingLevel?: string;
  outerToolResult: AgentToolResultMessage;
}

export interface AgentRunRequest {
  task: string;
  images?: ImageContent[];
  name?: string;
  runner?: FabricAgentRunner;
  /** Omitted/inherit uses the caller kernel; concrete kernels require Pi with Fabric extensions. */
  kernel?: FabricKernel | "inherit";
  /** Host-only snapshot for resident/trajectory forwarding; not a provider argument. */
  pythonRuntime?: FabricPythonRuntime;
  transport?: FabricAgentTransport;
  model?: string;
  /** Veda persona name; only used when runner is "veda". */
  persona?: string;
  thinking?: FabricThinking;
  /** Child thinking bounds; must lie inside the caller's effective bounds. */
  thinkingBounds?: FabricThinkingBounds;
  tools?: string[];
  timeoutMs?: number;
  extensions?: boolean;
  recursive?: boolean;
  /** Leaf or recursive execution cwd; relative to the immediate caller, independent of project/mesh lineage. */
  cwd?: string;
  worktree?: boolean;
  /** Shell command run in a new worktree before launch; overrides agents.worktree.setup. */
  worktreeSetup?: string;
  /** Write confinement enforced in the Pi child; see child-env.ts. */
  readOnly?: boolean;
  writableRoots?: string[];
  shell?: "deny" | "unconfined";
  /** Narrow the host-issued scope for the child; omitted inherits it unchanged. See src/scope.ts. */
  scope?: { grants: FabricScopeGrant[] };
  /**
   * Host-only full parent scope forwarded to a host without this session's
   * scope (resident host, actor turns); never a provider argument.
   */
  inheritedScope?: FabricScope;
  residency?: FabricParticipantResidency;
  schema?: Record<string, unknown>;
  systemPrompt?: string;
  /** Opt in to Claude Code transcript persistence for hook-based observability. */
  persistSession?: boolean;
  sessionFile?: string;
  actorId?: string;
  actorName?: string;
  capabilityRequirements?: string[];
  capabilityDigest?: string;
  meshRoot?: string;
  runnerSessionId?: string;
  /** Host-created Pi branch seed ending with the native outer fabric_exec result. */
  sessionSeed?: AgentSessionSeed;
  /** Source/executor reasoning channels for trajectory thinking transfer. */
  thinkingTransfer?: ThinkingTransferInput | undefined;
  /** Compact the inherited trajectory with Fabric's deterministic compactor before the executor resumes. */
  handoffCompact?: HandoffCompactionRequest;
  /** Host-only parent /switch-account pins; not a model argument. */
  inheritedSessionPins?: InheritedSessionPin[];
  /** Host-created fork of the caller branch ending at its last completed turn (seed: "branch"). */
  forkSeed?: AgentForkSeed;
}

export interface AgentForkSeed {
  sourceSessionId: string;
  sourceSessionFile?: string;
  sourceBranch: SessionEntry[];
}

export interface AgentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface FabricBudgetSummary {
  limit: number;
  spent: number;
  remaining: number;
  tokens: number;
}

export interface AgentCompactionStatus {
  status: "queued" | "in_flight" | "completed" | "failed";
  requestedAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  attempts: number;
  coalescedRequests: number;
  queued?: boolean;
  error?: string;
}

export interface AgentRunRecord {
  /** Requested launch model; model below follows verified state/assistant attribution. */
  requestedModel?: string;
  id: string;
  name: string;
  task: string;
  status: AgentRunStatus;
  runner: FabricAgentRunner;
  /** Resolved Fabric kernel; absent for runners without Fabric. */
  kernel?: FabricKernel;
  transport: AgentRunTransport;
  cwd: string;
  model?: string;
  thinking?: FabricThinking;
  /** Set only when the requested level was clamped into thinking bounds. */
  requestedThinking?: FabricThinking;
  actorId?: string;
  actorName?: string;
  capabilityRequirements?: string[];
  capabilityDigest?: string;
  recursive?: boolean;
  residency?: FabricParticipantResidency;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  currentTool?: string;
  turns: number;
  toolCalls: number;
  text: string;
  value?: unknown;
  error?: string;
  stderr?: string;
  exitCode?: number | null;
  usage: AgentUsage;
  budget?: FabricBudgetSummary;
  sessionId?: string;
  runnerSessionId?: string;
  attachCommand?: string;
  branch?: string;
  worktree?: string;
  logFile?: string;
  nestedAgents?: AgentRunRecord[];
  pendingMessages?: { steering: string[]; followUp: string[] };
  /** Set while a routed child dialog waits for an answer (status detail waiting_for_answer). */
  blockedOn?: { decisionId?: string; since: number };
  compaction?: AgentCompactionStatus;
  /** Settlement diff summary of a worktree: true run; `worktree` stays the path. */
  worktreeResult?: AgentWorktreeResult;
  /** Hosted runs: the adapter locator, persisted before the run is submitted. */
  hosted?: { locator: unknown };
  /** A hosted run the adapter reports parked; still running, not dead. */
  sleeping?: true;
  /** Set on terminal records whose effect Fabric cannot confirm. */
  outcome?: FabricRunOutcome;
  /** A hosted runner's failure hint; Fabric itself never retries. */
  retryable?: boolean;
}

export interface AgentRunResult extends AgentRunRecord {
  status: "completed" | "failed" | "stopped" | "timed_out";
}

export interface AgentHandleInfo {
  id: string;
  name: string;
  status: AgentRunStatus;
  runner: FabricAgentRunner;
  /** Resolved Fabric kernel; absent for runners without Fabric. */
  kernel?: FabricKernel;
  transport: AgentRunTransport;
  cwd: string;
  model?: string;
  thinking?: FabricThinking;
  /** Set only when the requested level was clamped into thinking bounds. */
  requestedThinking?: FabricThinking;
  actorId?: string;
  actorName?: string;
  capabilityRequirements?: string[];
  capabilityDigest?: string;
  recursive?: boolean;
  residency?: FabricParticipantResidency;
  sessionId?: string;
  runnerSessionId?: string;
  attachCommand?: string;
  branch?: string;
  worktree?: string;
}

export interface AgentWorkerOptions {
  id: string;
  runner: FabricAgentRunner;
  kernel?: FabricKernel;
  pythonRuntime?: FabricPythonRuntime;
  name: string;
  taskFile: string;
  imagesFile?: string;
  statusFile: string;
  lifecycleFile: string;
  logFile: string;
  schemaFile?: string;
  cwd: string;
  piBinary: string;
  claudeBinary: string;
  vedaBinary: string;
  vedaBackend: string;
  vedaPersona: string;
  timeoutMs: number;
  depth: number;
  fullCodeMode: boolean;
  mainAgentId?: string;
  fabricSessionId?: string;
  extensions: boolean;
  tools: string[];
  grantedRisks: string[];
  maxTokens?: number;
  fabricExtensionPath?: string;
  model?: string;
  thinking?: string;
  /** Serialized effective bounds forwarded as PI_FABRIC_THINKING_BOUNDS. */
  thinkingBounds?: string;
  systemPrompt?: string;
  persistSession?: boolean;
  modelAdmission?: "strict" | "permissive";
  sessionFile?: string;
  sessionExportFile?: string;
  actorId?: string;
  actorName?: string;
  capabilityRequirements?: string[];
  capabilityDigest?: string;
  meshRoot?: string;
  projectRoot?: string;
  ownerHostId?: string;
  ownerIdentityId?: string;
  runnerSessionId?: string;
  runRoot?: string;
  steerFile?: string;
  /** Present when agents.childQuestions is "route": child dialogs go to the parent with this default deadline. */
  childQuestionTimeoutMs?: number;
  transport: FabricAgentTransport;
  sessionId?: string;
  attachCommand?: string;
  branch?: string;
  worktree?: string;
  inheritedSessionPins?: InheritedSessionPin[];
  carryOver?: AgentRunCarryOver;
  /** Serialized PI_FABRIC_WRITE_POLICY; Pi children also load the write guard. */
  writePolicy?: string;
  /** Serialized PI_FABRIC_LINEAGE. */
  lineage?: string;
  /** Serialized PI_FABRIC_SCOPE; absent clears any inherited scope variables. */
  scope?: string;
}

/**
 * Cumulative totals a relaunched worker seeds its fresh run record with. The
 * worker owns the run record, so passing the prefix here (instead of adding it
 * host-side) keeps every reader — status file, live UI rows, settled result,
 * and the budget ledger's settle residual — on one cumulative number.
 */
export interface AgentRunCarryOver {
  turns: number;
  toolCalls: number;
  usage: AgentUsage;
}

export interface AgentTransportLaunch {
  id: string;
  name: string;
  cwd: string;
  workerPath: string;
  workerArguments: string[];
}

export interface AgentTransportHandle {
  kind: AgentRunTransport;
  sessionId?: string;
  attachCommand?: string;
  livenessPollIntervalMs?: number;
  /** Bounded diagnostic tail for workers that fail before writing a status record. */
  readStderr?(): string;
  isAlive(): Promise<boolean>;
  stop(): Promise<void>;
}

export interface AgentTransportAdapter {
  kind: FabricAgentTransport;
  available(): Promise<boolean>;
  launch(request: AgentTransportLaunch): Promise<AgentTransportHandle>;
}

export interface FabricLogLine {
  /** Legacy absolute line index; newer paged readers expose byte offset instead. */
  index?: number;
  offset: number;
  raw: string;
  parsed?: unknown;
}

export interface FabricAgentLog {
  id: string;
  runDirectory: string;
  logFile: string;
  status?: AgentRunRecord;
  events: FabricLogLine[];
  hasMore: boolean;
  before?: number;
}

export type FabricSteeringMode = "all" | "one-at-a-time";

export interface AgentSteerEntry {
  type: "steer" | "follow_up" | "set_steering_mode" | "set_follow_up_mode" | "compact";
  id: string;
  message?: string;
  mode?: FabricSteeringMode;
  instructions?: string;
  data?: unknown;
  ts: number;
}

/** A routed child dialog (agents.childQuestions "route"); `question` is the raw worker payload. */
export interface AgentChildQuestionRequest {
  runId: string;
  name: string;
  actorId?: string;
  question: Record<string, unknown>;
  /** Aborted when the run settles; the router must stop asking. */
  signal: AbortSignal;
  /** Report the durable decision backing a headless question. */
  onDecision(decisionId: string): void;
}

export type AgentChildQuestionResponse =
  | { value: string }
  | { confirmed: boolean }
  | { cancelled: true };

export interface AgentSteerResult {
  queued: true;
  messageId: string;
}
