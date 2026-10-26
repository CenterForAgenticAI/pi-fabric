import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { writeJsonAtomic } from "../core/atomic-write.js";
import type { AgentTransportHandle, AgentTransportLaunch } from "./types.js";

/**
 * Opt-in reattachment of built-in `pi-durable` worker runs after the resident
 * host that launched them stops (`agents.durableWorkerRecovery`).
 *
 * The file below is the per-run authority: a run recovers only when its launch
 * wrote one, and every settlement deletes it first. A recovery file beside a
 * worker-written terminal "stopped" record therefore means the stop came from
 * outside Fabric (a reboot or logout signal), never from an operator stop.
 */
export const WORKER_RECOVERY_FILE = "worker-recovery.json";
export const WORKER_RECOVERY_FORMAT = 1;

export interface WorkerRecoveryRecord {
  format: typeof WORKER_RECOVERY_FORMAT;
  id: string;
  runner: "pi-durable";
  /** Absolute wall-clock deadline of the original launch. */
  deadlineAt: number;
  /** Process id of the current worker attempt. */
  pid: number;
  launch: AgentTransportLaunch;
  writtenAt: number;
}

const MAX_ARGUMENTS = 4_096;
const MAX_STRING = 1_048_576;

const boundedString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_STRING;

export const workerRecoveryPath = (runDirectory: string): string =>
  path.join(runDirectory, WORKER_RECOVERY_FILE);

export const writeWorkerRecovery = (runDirectory: string, record: WorkerRecoveryRecord): void => {
  writeJsonAtomic(workerRecoveryPath(runDirectory), record, { mode: 0o600 });
};

export const removeWorkerRecovery = (runDirectory: string): void => {
  fs.rmSync(workerRecoveryPath(runDirectory), { force: true });
};

export const hasWorkerRecovery = (runDirectory: string): boolean =>
  fs.existsSync(workerRecoveryPath(runDirectory));

/** Strict reader: copies named, validated fields; anything else is undefined. */
export const readWorkerRecovery = (runDirectory: string): WorkerRecoveryRecord | undefined => {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(workerRecoveryPath(runDirectory), "utf8"));
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const launch = value.launch as Record<string, unknown> | undefined;
  if (
    value.format !== WORKER_RECOVERY_FORMAT ||
    !boundedString(value.id) ||
    value.runner !== "pi-durable" ||
    typeof value.deadlineAt !== "number" || !Number.isFinite(value.deadlineAt) ||
    typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0 ||
    typeof value.writtenAt !== "number" || !Number.isFinite(value.writtenAt) ||
    typeof launch !== "object" || launch === null || Array.isArray(launch) ||
    launch.id !== value.id ||
    !boundedString(launch.name) ||
    !boundedString(launch.cwd) ||
    !boundedString(launch.workerPath) ||
    !Array.isArray(launch.workerArguments) ||
    launch.workerArguments.length > MAX_ARGUMENTS ||
    launch.workerArguments.some((argument) => typeof argument !== "string" || argument.length > MAX_STRING)
  ) {
    return undefined;
  }
  return {
    format: WORKER_RECOVERY_FORMAT,
    id: value.id,
    runner: "pi-durable",
    deadlineAt: value.deadlineAt,
    pid: value.pid,
    writtenAt: value.writtenAt,
    launch: {
      id: value.id,
      name: launch.name,
      cwd: launch.cwd,
      workerPath: launch.workerPath,
      workerArguments: [...(launch.workerArguments as string[])],
    },
  };
};

export type WorkerLiveness = "alive" | "dead" | "unknown";

export interface WorkerProbes {
  /** `kill(pid, 0)`. */
  signal?: (pid: number) => "exists" | "missing" | "unknown";
  /** Full command line of `pid`, or undefined when it cannot be read. */
  commandLine?: (pid: number) => string | undefined;
}

const signalProbe = (pid: number): "exists" | "missing" | "unknown" => {
  try {
    process.kill(pid, 0);
    return "exists";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ESRCH") return "missing";
    // EPERM: some other user's process holds the pid, so not our worker; but
    // the answer is not ours to trust either way.
    return "unknown";
  }
};

const commandLineProbe = (pid: number): string | undefined => {
  try {
    if (process.platform === "linux") {
      return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ");
    }
    return execFileSync("ps", ["-ww", "-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
};

/**
 * Whether `pid` is still this run's worker. A PID alone is not enough: after a
 * reboot or a long outage the number may belong to an unrelated process, and
 * adopting that would let a later stop signal its process group. The worker's
 * command line carries `--id <run id>`, so a live PID whose command line lacks
 * it is a reused PID and our worker is gone. Any probe Fabric cannot read is
 * "unknown": relaunching then could put two writers on one journal.
 */
export const probeWorker = (pid: number, id: string, probes: WorkerProbes = {}): WorkerLiveness => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return "dead";
  const signal = (probes.signal ?? signalProbe)(pid);
  if (signal === "missing") return "dead";
  if (signal === "unknown") return "unknown";
  const commandLine = (probes.commandLine ?? commandLineProbe)(pid);
  if (commandLine === undefined) return "unknown";
  const tokens = commandLine.trim().split(/\s+/);
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (tokens[index] === "--id" && tokens[index + 1] === id) return "alive";
  }
  return "dead";
};

/** Transport handle for a verified live worker the new host did not launch. */
export const adoptedWorkerHandle = (
  pid: number,
  id: string,
  probes: WorkerProbes = {},
): AgentTransportHandle => ({
  kind: "process",
  sessionId: String(pid),
  livenessPollIntervalMs: 1_000,
  isAlive: async () => probeWorker(pid, id, probes) !== "dead",
  stop: async () => {
    // Re-verify before signalling the group: never signal a reused PID.
    if (probeWorker(pid, id, probes) !== "alive") return;
    try {
      process.kill(process.platform === "win32" ? pid : -pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  },
});
