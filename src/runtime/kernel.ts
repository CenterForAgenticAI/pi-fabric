// Language-neutral execution contract shared by all Fabric kernel backends.
export type FabricKernel = "typescript" | "python";

export type FabricSandboxTerminationReason =
  | "completed"
  | "runtime_error"
  | "timed_out"
  | "aborted";

export interface FabricSandboxResult {
  value: unknown;
  logs: string[];
  /** Explicit image() output, including partial output on errors. */
  emitted?: unknown[];
  terminationReason: FabricSandboxTerminationReason;
  error?: string;
}

/** A host-call result exactly as the guest received it. */
export type FabricJournalOutcome =
  | { ok: true; json?: string }
  | {
      ok: false;
      message: string;
      bashExit?: { exitCode: number; output: string };
      fields?: Array<[string, number]>;
    };

/** One recorded result, served on resume in its recorded delivery order. */
export interface FabricJournalDelivery {
  seq: number;
  /** Bridge ref the guest issued. */
  ref: string;
  /** Tool ref behind fabric.$call or fabric.$nativeTool. */
  target?: string;
  digest: string;
  /** Logical time the guest saw when this result arrived. */
  at: number;
  outcome: FabricJournalOutcome;
  /** Host-local state the execution service restores for a served call. */
  local?: unknown;
}

/**
 * Records and replays one QuickJS execution (see exec-journal.ts). The runtime
 * numbers host calls as the guest issues them, delivers results one at a time,
 * and on resume serves recorded results before any call reaches the host.
 */
export interface FabricJournalDriver {
  /** Guest prelude that pins the clock, Math.random, and the time zone. */
  readonly shim: string;
  readonly startedAt: number;
  /** True when resuming: every call waits until the recorded results are served. */
  readonly resuming: boolean;
  readonly replay: readonly FabricJournalDelivery[];
  digest(args: Record<string, unknown>): string;
  /** Append a completion before the guest sees it; returns the guest's new clock. */
  complete(
    seq: number,
    ref: string,
    args: Record<string, unknown>,
    value: unknown,
    outcome: FabricJournalOutcome,
  ): number;
  served(delivery: FabricJournalDelivery, args: Record<string, unknown>): void | Promise<void>;
  /** After serving: a stop report, or undefined to run the waiting calls live. */
  frontier(
    held: ReadonlyArray<{ seq: number; ref: string; args: Record<string, unknown> }>,
  ): string | undefined;
  diverged(
    expected: FabricJournalDelivery,
    actual?: { ref: string; args: Record<string, unknown> },
  ): string;
}

export interface FabricSandboxOptions {
  timeoutMs: number;
  nativeStoreEnabled?: boolean;
  nativeToolsEnabled?: boolean;
  codemodeProfile?: "additive" | "native";
  memoryLimitBytes: number;
  /** Optional uninterrupted guest CPU limit. Await host work/timers to yield. */
  maxCpuSliceMs?: number;
  maxPendingTimers?: number;
  maxLogChars?: number;
  strings?: Record<string, string>;
  tokenBudget?: number;
  signal?: AbortSignal;
  cwd?: string;
  minimumTimeoutMsForHostCall?(
    ref: string,
    args: Record<string, unknown>,
  ): number | undefined;
  /** True for a host call that waits for a person (executor.humanWaitRefs).
   * The program deadline is paused while any such call is in flight. */
  isHumanWaitHostCall?(ref: string, args: Record<string, unknown>): boolean;
  /** Declared core override fields must not be consumed as built-in aliases. */
  piToolCanonicalFields?: Record<string, string[]>;
  transpiledCode?: string;
  transpiledSourceMap?: string;
  /** Durable crash journal; QuickJS only. Absent means unchanged behavior. */
  journal?: FabricJournalDriver;
}

/** Runs a host-side wait for a person with the program deadline paused.
 * The deadline resumes with its saved budget when the wait settles. */
export type FabricHumanWait = <T>(wait: () => Promise<T>) => Promise<T>;

export type FabricHostCall = (
  ref: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
  /** Supplied by runtimes so the host can pause the deadline for a human
   * step inside an ordinary call, such as an approval prompt. */
  humanWait?: FabricHumanWait,
  /** Present only for a journaled call; `seq` is its issue order. */
  call?: { seq: number },
) => Promise<unknown>;

export interface FabricKernelRuntime {
  execute(
    code: string,
    hostCall: FabricHostCall,
    options: FabricSandboxOptions,
  ): Promise<FabricSandboxResult>;
}
