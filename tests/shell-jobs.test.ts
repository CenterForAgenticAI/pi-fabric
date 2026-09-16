import { afterEach, describe, expect, it } from "vitest";
import {
  appendShellHangNotice,
  FabricShellJobStore,
  formatShellHangNotice,
  parseShellPid,
  raceShellHang,
  wrapShellCommandForPid,
} from "../src/core/shell-jobs.js";

const stores: FabricShellJobStore[] = [];
const store = (): FabricShellJobStore => {
  const jobs = new FabricShellJobStore();
  stores.push(jobs);
  return jobs;
};

afterEach(async () => {
  await Promise.all(stores.splice(0).map((jobs) => jobs.close()));
});

describe("shell hang helpers", () => {
  it("wraps bash so the child writes its pid without extra stdout", () => {
    const wrapped = wrapShellCommandForPid("echo hi", "/tmp/job.pid", "bash");
    expect(wrapped).toContain("/tmp/job.pid");
    expect(wrapped.endsWith("echo hi")).toBe(true);
    expect(wrapped.startsWith("printf ")).toBe(true);
  });

  it("formats a still-running notice with pid and live path", () => {
    expect(formatShellHangNotice({
      elapsedMs: 47_400,
      pid: 41291,
      logPath: "/tmp/pi-fabric-shell-x/output.log",
    })).toBe("[Still running after 47s (pid 41291). Live output: /tmp/pi-fabric-shell-x/output.log]");
  });

  it("appends the notice like an output-budget spill", () => {
    expect(appendShellHangNotice("hello", "[note]")).toBe("hello\n\n[note]");
    expect(appendShellHangNotice("", "[note]")).toBe("[note]");
  });

  it("parses pid files", () => {
    expect(parseShellPid("41291\n")).toBe(41291);
    expect(parseShellPid("nope")).toBeUndefined();
  });
});

describe("raceShellHang", () => {
  it("returns the execute result when the command finishes first", async () => {
    const jobs = store();
    const job = jobs.begin("bash", "echo");
    const result = await raceShellHang({
      hangMs: 200,
      parentSignal: undefined,
      job,
      execute: async () => "ok",
    });
    expect(result).toEqual({ status: "done", value: "ok" });
    await job.finish(0);
  });

  it("spills when the hang budget elapses first", async () => {
    const jobs = store();
    const job = jobs.begin("bash", "sleep");
    let continued = false;
    const result = await raceShellHang({
      hangMs: 40,
      parentSignal: undefined,
      job,
      execute: async (signal) => {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            continued = true;
            resolve();
          }, 400);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          }, { once: true });
        });
        return "late";
      },
    });
    expect(result).toEqual({ status: "spilled" });
    expect(job.spilled).toBe(true);
    expect(continued).toBe(false);
    job.abort.abort();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it("kills the nested wait when the parent aborts before spill", async () => {
    const jobs = store();
    const job = jobs.begin("bash", "sleep");
    const parent = new AbortController();
    const pending = raceShellHang({
      hangMs: 5_000,
      parentSignal: parent.signal,
      job,
      execute: async (signal) => {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
        return "nope";
      },
    });
    parent.abort(new Error("cancel turn"));
    const result = await pending;
    expect(result).toMatchObject({ status: "error" });
    expect(job.spilled).toBe(false);
  });

  it("spills immediately when requested, without waiting for hangMs", async () => {
    const jobs = store();
    const job = jobs.begin("bash", "sleep");
    const pending = raceShellHang({
      hangMs: 5_000,
      immediate: true,
      parentSignal: undefined,
      job,
      execute: async (signal) => {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
        return "nope";
      },
    });
    await expect(pending).resolves.toEqual({ status: "spilled" });
    job.abort.abort();
  });

  it("spills on demand so ctrl+b does not need background:true", async () => {
    const jobs = store();
    const job = jobs.begin("bash", "sleep");
    const pending = raceShellHang({
      hangMs: 0,
      parentSignal: undefined,
      job,
      execute: async (signal) => {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
        return "nope";
      },
    });
    expect(jobs.spillWaiting()).toBe(1);
    await expect(pending).resolves.toEqual({ status: "spilled" });
    job.abort.abort();
  });
});
