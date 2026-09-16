import { createWriteStream, type WriteStream } from "node:fs";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import type { PiShellToolName } from "./pi-tools.js";

export const DEFAULT_SHELL_HANG_MS = 60_000;
const SHELL_HANG_SNAPSHOT_BYTES = 8_000;

const posixQuote = (value: string): string =>
  "'" + value.replaceAll("'", "'\\''") + "'";

const powershellQuote = (value: string): string =>
  "'" + value.replaceAll("'", "''") + "'";

export const wrapShellCommandForPid = (
  command: string,
  pidPath: string,
  tool: PiShellToolName,
): string =>
  tool === "powershell"
    ? `Set-Content -LiteralPath ${powershellQuote(pidPath)} -Value $PID\n${command}`
    : `printf '%s\\n' "$$" > ${posixQuote(pidPath)}\n${command}`;

export const formatShellHangNotice = (input: {
  elapsedMs: number;
  pid?: number;
  logPath: string;
}): string => {
  const seconds = Math.max(1, Math.round(input.elapsedMs / 1_000));
  const pid = input.pid !== undefined ? ` (pid ${input.pid})` : "";
  return `[Still running after ${seconds}s${pid}. Live output: ${input.logPath}]`;
};

export const appendShellHangNotice = (output: string, notice: string): string =>
  output ? `${output}\n\n${notice}` : notice;

export const parseShellPid = (text: string): number | undefined => {
  const pid = Number(text.trim());
  return Number.isSafeInteger(pid) && pid > 1 ? pid : undefined;
};

type FabricShellJobStatus = "running" | "spilled" | "exited" | "killed";

export interface FabricShellJobInfo {
  id: string;
  tool: PiShellToolName;
  command: string;
  pid?: number;
  logPath?: string;
  startedAt: number;
  spilledAt?: number;
  finishedAt?: number;
  status: FabricShellJobStatus;
  exitCode?: number | null;
}

export interface FabricShellJobHandle {
  readonly id: string;
  readonly tool: PiShellToolName;
  readonly command: string;
  readonly abort: AbortController;
  readonly startedAt: number;
  readonly pidPath: string;
  pid?: number;
  logPath?: string;
  spilled: boolean;
  finished: boolean;
  append(data: Buffer): void;
  snapshotText(maxBytes?: number): string;
  persistLog(): Promise<string>;
  readPid(): Promise<number | undefined>;
  spill(): void;
  whenSpill(): Promise<void>;
  finish(exitCode?: number | null, footer?: string): Promise<void>;
}

class FabricShellJob implements FabricShellJobHandle {
  readonly id: string;
  readonly tool: PiShellToolName;
  readonly command: string;
  readonly abort = new AbortController();
  readonly startedAt = Date.now();
  readonly pidPath: string;
  pid?: number;
  logPath?: string;
  spilled = false;
  finished = false;
  spilledAt?: number;
  finishedAt?: number;
  exitCode?: number | null;
  status: FabricShellJobStatus = "running";
  #chunks: Buffer[] = [];
  #stream: WriteStream | undefined;
  #spill = new AbortController();
  #pidRead: Promise<number | undefined> | undefined;

  constructor(tool: PiShellToolName, command: string) {
    this.id = randomUUID();
    this.tool = tool;
    this.command = command;
    this.pidPath = path.join(tmpdir(), `pi-fabric-shell-${this.id}.pid`);
  }

  append(data: Buffer): void {
    if (this.finished) return;
    this.#chunks.push(data);
    this.#stream?.write(data);
  }

  snapshotText(maxBytes = SHELL_HANG_SNAPSHOT_BYTES): string {
    const all = Buffer.concat(this.#chunks);
    const slice = all.length <= maxBytes ? all : all.subarray(all.length - maxBytes);
    return slice.toString("utf8");
  }

  async persistLog(): Promise<string> {
    if (this.logPath) return this.logPath;
    const logPath = path.join(tmpdir(), `pi-fabric-shell-${this.id}.log`);
    this.logPath = logPath;
    await writeFile(logPath, Buffer.concat(this.#chunks), { encoding: "utf8", mode: 0o600 });
    this.#stream = createWriteStream(logPath, { flags: "a", encoding: "utf8", mode: 0o600 });
    return logPath;
  }

  async readPid(): Promise<number | undefined> {
    if (this.pid !== undefined) return this.pid;
    this.#pidRead ??= (async () => {
      for (let attempt = 0; attempt < 25; attempt += 1) {
        try {
          const pid = parseShellPid(await readFile(this.pidPath, "utf8"));
          if (pid !== undefined) {
            this.pid = pid;
            return pid;
          }
        } catch {
          // Pid file is written by the child after spawn.
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return undefined;
    })();
    return this.#pidRead;
  }

  spill(): void {
    if (this.spilled || this.finished) return;
    this.spilled = true;
    this.spilledAt = Date.now();
    this.status = "spilled";
    if (!this.#spill.signal.aborted) this.#spill.abort();
  }

  whenSpill(): Promise<void> {
    if (this.spilled || this.#spill.signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      this.#spill.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  }

  async finish(exitCode?: number | null, footer?: string): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    this.finishedAt = Date.now();
    if (exitCode !== undefined) this.exitCode = exitCode;
    if (this.status === "running") {
      this.status = this.abort.signal.aborted ? "killed" : "exited";
    } else if (this.abort.signal.aborted && this.status === "spilled") {
      this.status = "killed";
    }
    if (footer && this.#stream) this.#stream.write(footer.endsWith("\n") ? footer : `${footer}\n`);
    await new Promise<void>((resolve) => {
      if (!this.#stream) {
        resolve();
        return;
      }
      this.#stream.end(() => resolve());
    });
    this.#stream = undefined;
    if (!this.#spill.signal.aborted) this.#spill.abort();
    if (!this.spilled) {
      await unlink(this.pidPath).catch(() => undefined);
    }
  }

  info(): FabricShellJobInfo {
    return {
      id: this.id,
      tool: this.tool,
      command: this.command,
      ...(this.pid !== undefined ? { pid: this.pid } : {}),
      ...(this.logPath ? { logPath: this.logPath } : {}),
      startedAt: this.startedAt,
      ...(this.spilledAt !== undefined ? { spilledAt: this.spilledAt } : {}),
      ...(this.finishedAt !== undefined ? { finishedAt: this.finishedAt } : {}),
      status: this.status,
      ...(this.exitCode !== undefined ? { exitCode: this.exitCode } : {}),
    };
  }
}

export const trackShellOperations = (
  inner: BashOperations,
  job: FabricShellJobHandle,
  tool: PiShellToolName,
): BashOperations => ({
  exec: (command, cwd, options) =>
    inner.exec(wrapShellCommandForPid(command, job.pidPath, tool), cwd, {
      ...options,
      onData: (data) => {
        job.append(data);
        options.onData(data);
      },
    }),
});

export class FabricShellJobStore {
  readonly #jobs = new Map<string, FabricShellJob>();

  begin(tool: PiShellToolName, command: string): FabricShellJob {
    const job = new FabricShellJob(tool, command);
    this.#jobs.set(job.id, job);
    return job;
  }

  get(id: string): FabricShellJob | undefined {
    return this.#jobs.get(id);
  }

  list(): FabricShellJobInfo[] {
    return [...this.#jobs.values()].map((job) => job.info());
  }

  waiting(): FabricShellJob[] {
    return [...this.#jobs.values()].filter((job) => !job.spilled && !job.finished);
  }

  live(): FabricShellJob[] {
    return [...this.#jobs.values()].filter((job) => !job.finished);
  }

  spillWaiting(): number {
    const jobs = this.waiting();
    for (const job of jobs) job.spill();
    return jobs.length;
  }

  killWaiting(): number {
    const jobs = this.waiting();
    for (const job of jobs) {
      if (!job.abort.signal.aborted) job.abort.abort(new Error("Command aborted"));
    }
    return jobs.length;
  }

  async close(): Promise<void> {
    const live = this.live();
    for (const job of live) {
      if (!job.abort.signal.aborted) job.abort.abort(new Error("Fabric session ended"));
    }
    await Promise.allSettled(live.map((job) => job.finish(null, "\n\n[Process ended: session closed]\n")));
    this.#jobs.clear();
  }
}

export const raceShellHang = async <T>(options: {
  execute: (signal: AbortSignal) => Promise<T>;
  parentSignal: AbortSignal | undefined;
  hangMs: number;
  job: FabricShellJobHandle;
}): Promise<{ status: "done"; value: T } | { status: "error"; error: unknown } | { status: "spilled" }> => {
  const { job, parentSignal, hangMs } = options;
  const onParentAbort = (): void => {
    if (job.spilled || job.finished || job.abort.signal.aborted) return;
    job.abort.abort(parentSignal?.reason ?? new Error("Command aborted"));
  };
  if (parentSignal) {
    if (parentSignal.aborted) onParentAbort();
    else parentSignal.addEventListener("abort", onParentAbort, { once: true });
  }
  const detachParent = (): void => {
    parentSignal?.removeEventListener("abort", onParentAbort);
  };

  let hangTimer: ReturnType<typeof setTimeout> | undefined;
  const hang = new Promise<"spill">((resolve) => {
    const finish = (): void => resolve("spill");
    if (hangMs > 0) {
      hangTimer = setTimeout(() => {
        job.spill();
        finish();
      }, hangMs);
      hangTimer.unref?.();
    }
    void job.whenSpill().then(finish);
  });

  const execute = options.execute(job.abort.signal).then(
    (value) => ({ status: "done" as const, value }),
    (error) => ({ status: "error" as const, error }),
  );

  try {
    const first = await Promise.race([execute, hang]);
    if (first === "spill") {
      if (job.finished) return execute;
      job.spill();
      detachParent();
      void execute.then(async (result) => {
        if (job.finished) return;
        if (result.status === "done") {
          await job.finish(0, "\n\n[Process exited with code 0]\n");
          return;
        }
        const message = result.error instanceof Error ? result.error.message : String(result.error);
        await job.finish(null, "\n\n[" + message + "]\n");
      });
      return { status: "spilled" };
    }
    detachParent();
    return first;
  } finally {
    if (hangTimer) clearTimeout(hangTimer);
  }
};
