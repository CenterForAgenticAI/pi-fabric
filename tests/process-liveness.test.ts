import { afterEach, describe, expect, it, vi } from "vitest";
import {
  currentProcessStamp,
  formatCommitLockOwner,
  formatLockOwner,
  parseCommitLockOwner,
  parseLockOwner,
  parseProcStatStartTime,
  processLiveness,
  stampFromRecord,
  type LivenessProbe,
} from "../src/core/process-liveness.js";

const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });

interface FakeProcess {
  signal?: "ok" | "ESRCH" | "EPERM" | "EINVAL";
  startTime?: string;
}

const probe = (processes: Record<number, FakeProcess>, namespace?: string): LivenessProbe => ({
  signal(pid) {
    const outcome = processes[pid]?.signal ?? "ESRCH";
    if (outcome !== "ok") throw errno(outcome);
  },
  pidNamespace: () => namespace,
  startTime: (pid) => processes[pid]?.startTime,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("processLiveness", () => {
  const own = "pid:[4026531836]";
  const sandbox = "pid:[4026534459]";

  it("reports a missing process as dead", () => {
    expect(processLiveness({ pid: 42 }, probe({}, own))).toBe("dead");
  });

  it("reports a permitted probe of a legacy record as alive", () => {
    expect(processLiveness({ pid: 42 }, probe({ 42: { signal: "ok" } }, own))).toBe("alive");
  });

  it("reports a denied probe without a start time as unknown, never dead", () => {
    expect(processLiveness({ pid: 2 }, probe({ 2: { signal: "EPERM" } }, own))).toBe("unknown");
  });

  it("reports an unexpected probe error as unknown", () => {
    expect(processLiveness({ pid: 42 }, probe({ 42: { signal: "EINVAL" } }, own))).toBe("unknown");
  });

  it("reports an invalid pid as unknown without probing", () => {
    const signal = vi.fn();
    for (const pid of [0, -1, 1.5, Number.NaN]) {
      expect(processLiveness({ pid }, { ...probe({}, own), signal })).toBe("unknown");
    }
    expect(signal).not.toHaveBeenCalled();
  });

  it("never probes an owner recorded in another PID namespace", () => {
    // In the sandbox, the owner's PID 2 names a live but unrelated host
    // process; a probe would wrongly report it alive (or dead, for ESRCH).
    const signal = vi.fn();
    const stamp = { pid: 2, pidNamespace: sandbox, startTime: "100" };
    expect(processLiveness(stamp, { ...probe({ 2: { signal: "ok" } }, own), signal })).toBe("unknown");
    expect(signal).not.toHaveBeenCalled();
  });

  it("treats an unobservable own namespace as foreign to a recorded one", () => {
    expect(processLiveness({ pid: 42, pidNamespace: own }, probe({ 42: { signal: "ok" } }))).toBe("unknown");
  });

  it("confirms a same-namespace owner by start time", () => {
    const stamp = { pid: 42, pidNamespace: own, startTime: "100" };
    expect(processLiveness(stamp, probe({ 42: { signal: "ok", startTime: "100" } }, own))).toBe("alive");
  });

  it("reports a reused pid as dead", () => {
    const stamp = { pid: 42, pidNamespace: own, startTime: "100" };
    expect(processLiveness(stamp, probe({ 42: { signal: "ok", startTime: "999" } }, own))).toBe("dead");
  });

  it("uses the start time to settle a denied probe", () => {
    const stamp = { pid: 42, pidNamespace: own, startTime: "100" };
    expect(processLiveness(stamp, probe({ 42: { signal: "EPERM", startTime: "100" } }, own))).toBe("alive");
    expect(processLiveness(stamp, probe({ 42: { signal: "EPERM", startTime: "7" } }, own))).toBe("dead");
  });

  it("falls back to the probe when the start time is unreadable", () => {
    const stamp = { pid: 42, pidNamespace: own, startTime: "100" };
    expect(processLiveness(stamp, probe({ 42: { signal: "ok" } }, own))).toBe("alive");
    expect(processLiveness(stamp, probe({ 42: { signal: "EPERM" } }, own))).toBe("unknown");
  });

  it("reports the current process alive with the system probe", () => {
    expect(processLiveness(currentProcessStamp())).toBe("alive");
    expect(processLiveness({ pid: process.pid })).toBe("alive");
  });

  it.runIf(process.platform === "linux")("stamps the current process with its namespace and start time", () => {
    const stamp = currentProcessStamp();
    expect(stamp.pid).toBe(process.pid);
    expect(stamp.pidNamespace).toMatch(/^pid:\[\d+\]$/);
    expect(stamp.startTime).toMatch(/^\d+$/);
    expect(processLiveness({ ...stamp, startTime: `${stamp.startTime}0` })).toBe("dead");
    expect(processLiveness({ ...stamp, pidNamespace: "pid:[1]" })).toBe("unknown");
  });
});

describe("parseProcStatStartTime", () => {
  const tail = "S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 777 19 20";

  it("reads field 22", () => {
    expect(parseProcStatStartTime(`1234 (node) ${tail}`)).toBe("777");
  });

  it("counts fields after the last parenthesis of a hostile command name", () => {
    expect(parseProcStatStartTime(`1234 (a) b (c d) ${tail}`)).toBe("777");
  });

  it("rejects malformed lines", () => {
    expect(parseProcStatStartTime("no command")).toBeUndefined();
    expect(parseProcStatStartTime("1 (x) S 1 2")).toBeUndefined();
    expect(parseProcStatStartTime(`1 (x) ${tail.replace("777", "7x7")}`)).toBeUndefined();
  });
});

describe("owner records", () => {
  const stamp = { pid: 42, pidNamespace: "pid:[9]", startTime: "100" };

  it("round-trips a directory-lock owner", () => {
    expect(parseLockOwner(formatLockOwner("token", 5, stamp))).toEqual({ token: "token", createdAt: 5, stamp });
  });

  it("keeps the legacy first three lines readable", () => {
    const [token, pid, created] = formatLockOwner("token", 5, stamp).split("\n");
    expect([token, Number(pid), Number(created)]).toEqual(["token", 42, 5]);
  });

  it("parses a legacy three-line owner without stamp fields", () => {
    expect(parseLockOwner("token\n42\n5\n")).toEqual({ token: "token", createdAt: 5, stamp: { pid: 42 } });
  });

  it("round-trips a commit-lock owner and parses a legacy pid-only lock", () => {
    expect(parseCommitLockOwner(formatCommitLockOwner(5, stamp))).toEqual({ createdAt: 5, stamp });
    const legacy = parseCommitLockOwner("42");
    expect(legacy.stamp).toEqual({ pid: 42 });
    expect(Number.isFinite(legacy.createdAt)).toBe(false);
  });

  it("copies only well-formed stamp fields from a parsed record", () => {
    expect(stampFromRecord({ pid: 42, pidNamespace: 7, startTime: "" })).toEqual({ pid: 42 });
    expect(stampFromRecord({ pid: "42" }).pid).toBeNaN();
    const hostile = { pid: 42, pidNamespace: "pid:[9]", startTime: "100", extra: "x" };
    expect(stampFromRecord(hostile)).toEqual(stamp);
  });
});
