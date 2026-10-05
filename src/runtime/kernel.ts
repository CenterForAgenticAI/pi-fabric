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

export interface FabricSandboxOptions {
  timeoutMs: number;
  nativeStoreEnabled?: boolean;
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
}

export type FabricHostCall = (
  ref: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<unknown>;

export interface FabricKernelRuntime {
  execute(
    code: string,
    hostCall: FabricHostCall,
    options: FabricSandboxOptions,
  ): Promise<FabricSandboxResult>;
}
