// Process liveness for Fabric owner records.
//
// Fabric records `process.pid` in lock and ownership files and later asks
// whether that owner still runs. A bare PID answers that only inside the PID
// namespace that issued it: from a different namespace (a container or a
// `bwrap --unshare-pid` sandbox sharing the same directory) the number names
// an unrelated process or nothing at all. A PID can also be reused after its
// owner exits. Owners therefore record a stamp: the PID plus, on Linux, the
// PID-namespace identity and the process start time. The verdict is three
// valued so each call site states what it does when liveness cannot be known.

import fs from "node:fs";

export type Liveness = "alive" | "dead" | "unknown";

/** Identity recorded next to a PID. Optional fields are absent off Linux and in legacy records. */
export interface ProcessStamp {
  pid: number;
  /** Linux: `readlink /proc/self/ns/pid` of the owner, e.g. `pid:[4026531836]`. */
  pidNamespace?: string;
  /** Linux: field 22 of `/proc/<pid>/stat` (clock ticks after boot). */
  startTime?: string;
}

/** Operating-system probes, injectable for tests. */
export interface LivenessProbe {
  /** Behaves like `process.kill(pid, 0)`: returns or throws an errno error. */
  signal(pid: number): void;
  /** The caller's own PID-namespace identity, when observable. */
  pidNamespace(): string | undefined;
  /** The start time of `pid` as seen from the caller's namespace, when observable. */
  startTime(pid: number): string | undefined;
}

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;

/**
 * Returns field 22 (`starttime`) of a `/proc/<pid>/stat` line. The command
 * name in field 2 may contain spaces and parentheses, so fields are counted
 * after its last closing parenthesis.
 */
export const parseProcStatStartTime = (stat: string): string | undefined => {
  const end = stat.lastIndexOf(")");
  if (end < 0) return undefined;
  const value = stat.slice(end + 1).trim().split(/\s+/)[19];
  return value !== undefined && /^\d+$/.test(value) ? value : undefined;
};

const readStartTime = (file: string): string | undefined => {
  if (process.platform !== "linux") return undefined;
  try {
    return parseProcStatStartTime(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
};

let ownNamespace: { value: string | undefined } | undefined;

export const systemLivenessProbe: LivenessProbe = {
  signal(pid) {
    process.kill(pid, 0);
  },
  pidNamespace() {
    if (!ownNamespace) {
      let value: string | undefined;
      if (process.platform === "linux") {
        try {
          value = fs.readlinkSync("/proc/self/ns/pid");
        } catch {
          value = undefined;
        }
      }
      ownNamespace = { value };
    }
    return ownNamespace.value;
  },
  startTime(pid) {
    return readStartTime(`/proc/${pid}/stat`);
  },
};

let ownStamp: ProcessStamp | undefined;

/** The stamp to record for the current process. Memoized: none of its parts change. */
export const currentProcessStamp = (): ProcessStamp => {
  if (!ownStamp) {
    const pidNamespace = systemLivenessProbe.pidNamespace();
    // `/proc/self` resolves in the namespace of the mounted procfs even when
    // `process.pid` would not, so read the own start time through it.
    const startTime = readStartTime("/proc/self/stat");
    ownStamp = {
      pid: process.pid,
      ...(pidNamespace ? { pidNamespace } : {}),
      ...(startTime ? { startTime } : {}),
    };
  }
  return ownStamp;
};

/**
 * Decides whether the process a stamp names still runs.
 *
 * - `unknown`: invalid PID, owner recorded in another (or an unobservable)
 *   PID namespace, a permission-denied probe without a start time to compare,
 *   or an unexpected error.
 * - `dead`: the PID does not exist, or it exists with a different start time
 *   (the PID was reused).
 * - `alive`: the PID exists and either its start time matches or the record
 *   predates start times and the probe was permitted.
 */
export const processLiveness = (
  stamp: ProcessStamp,
  probe: LivenessProbe = systemLivenessProbe,
): Liveness => {
  if (!Number.isSafeInteger(stamp.pid) || stamp.pid <= 0) return "unknown";
  if (stamp.pidNamespace !== undefined && probe.pidNamespace() !== stamp.pidNamespace) {
    return "unknown";
  }
  let permitted = true;
  try {
    probe.signal(stamp.pid);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ESRCH") return "dead";
    if (code !== "EPERM") return "unknown";
    permitted = false;
  }
  if (stamp.startTime !== undefined) {
    const observed = probe.startTime(stamp.pid);
    if (observed !== undefined) return observed === stamp.startTime ? "alive" : "dead";
  }
  return permitted ? "alive" : "unknown";
};

/** Copies only well-formed stamp fields out of a parsed owner record. */
export const stampFromRecord = (record: {
  pid?: unknown;
  pidNamespace?: unknown;
  startTime?: unknown;
}): ProcessStamp => ({
  pid: typeof record.pid === "number" ? record.pid : Number.NaN,
  ...(typeof record.pidNamespace === "string" && record.pidNamespace
    ? { pidNamespace: record.pidNamespace }
    : {}),
  ...(typeof record.startTime === "string" && record.startTime
    ? { startTime: record.startTime }
    : {}),
});

/** Optional stamp fields to spread into a JSON owner record. */
export const currentStampFields = (): Pick<ProcessStamp, "pidNamespace" | "startTime"> => {
  const { pidNamespace, startTime } = currentProcessStamp();
  return {
    ...(pidNamespace ? { pidNamespace } : {}),
    ...(startTime ? { startTime } : {}),
  };
};

export interface LockOwner {
  token: string;
  createdAt: number;
  stamp: ProcessStamp;
}

/**
 * Line format of a directory-lock `owner` file: `token`, `pid`, `createdAt`,
 * then the optional namespace and start time. Readers that predate the last
 * two lines destructure the first three and ignore the rest.
 */
export const formatLockOwner = (
  token: string,
  createdAt = Date.now(),
  stamp: ProcessStamp = currentProcessStamp(),
): string =>
  `${token}\n${stamp.pid}\n${createdAt}\n${stamp.pidNamespace ?? ""}\n${stamp.startTime ?? ""}\n`;

/**
 * Line format of the Schema commit lock file: `pid`, `createdAt`, then the
 * optional namespace and start time.
 */
export const formatCommitLockOwner = (
  createdAt = Date.now(),
  stamp: ProcessStamp = currentProcessStamp(),
): string => `${stamp.pid}\n${createdAt}\n${stamp.pidNamespace ?? ""}\n${stamp.startTime ?? ""}\n`;

export const parseCommitLockOwner = (text: string): Omit<LockOwner, "token"> => {
  const [pid, created, pidNamespace, startTime] = text.split("\n");
  return {
    createdAt: Number(created),
    stamp: {
      pid: Number(pid),
      ...(pidNamespace ? { pidNamespace } : {}),
      ...(startTime ? { startTime } : {}),
    },
  };
};

export const parseLockOwner = (text: string): LockOwner => {
  const [token = "", pid, created, pidNamespace, startTime] = text.trim().split("\n");
  return {
    token,
    createdAt: Number(created),
    stamp: {
      pid: Number(pid),
      ...(pidNamespace ? { pidNamespace } : {}),
      ...(startTime ? { startTime } : {}),
    },
  };
};
