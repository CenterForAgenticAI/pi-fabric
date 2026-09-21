import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const coordinator = path.join(projectRoot, "scripts", "prewalk-swe-run.mjs");
const fixture = path.join(projectRoot, "tests", "fixtures", "fake-swe-harness.mjs");

const roots: string[] = [];
const temporary = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prewalk-swe-run-"));
  roots.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

interface Row {
  id: string;
  index: number;
  mode: string;
  modelRequests: number;
  usageUsd: number;
  usageHoldUsd: number;
  resolved: boolean;
  validGrade: boolean;
  timedOut: boolean;
  baselineTree: string | null;
  verdict: { status: string; validComparison: boolean; reason: string };
}

interface Summary {
  state: string;
  reason: string | null;
  needsRecovery: string[];
  executedThisRun: string[];
  counts: Record<string, number>;
  comparison: { comparablePairs: number };
  budget: { availableUsd: number };
}

const callLogPath = (root: string) => path.join(root, "call-log.jsonl");
const subs = (root: string) =>
  fs.existsSync(callLogPath(root))
    ? fs
        .readFileSync(callLogPath(root), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => (JSON.parse(line) as { sub: string }).sub)
    : [];

const baseConfig = (root: string, budget?: Record<string, unknown>) => ({
  root,
  schedule: [
    { id: "001", index: 0, mode: "prewalk" },
    { id: "002", index: 0, mode: "astra" },
  ],
  budget:
    budget ?? {
      maximumTotalUsd: 10,
      priorKnownUsd: 0,
      priorUnknownWorstCaseUsd: 0,
      maximumRequestUsd: { "fake-main": 1 },
    },
  commands: {
    controls: { argv: [process.execPath, fixture, "controls", "{controlId}", "{controlsOut}"], cwd: root, timeoutMs: 30_000 },
    prepare: { argv: [process.execPath, fixture, "prepare", "{id}", "{mode}", "{root}"], cwd: root, timeoutMs: 30_000 },
    run: { argv: [process.execPath, fixture, "run", "{id}", "{root}"], cwd: root, timeoutMs: 30_000 },
    grade: { argv: [process.execPath, fixture, "grade", "{index}", "{patchPath}", "{gradeOut}"], cwd: root, timeoutMs: 30_000 },
  },
});

const runCoordinator = (root: string, config: Record<string, unknown>, extra: string[] = []) => {
  const configPath = path.join(root, "config.json");
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  return spawnSync(process.execPath, [coordinator, "--config", configPath, ...extra], {
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, FAKE_SWE_CALL_LOG: callLogPath(root) },
  });
};

const readJson = (file: string) => JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;

describe("prewalk-swe-run coordinator (fake worker, no model calls)", () => {
  it("runs the connected path with canonical controls and isolated capture, then refuses replay and resumes without reissuing", () => {
    const root = temporary();
    const first = runCoordinator(root, baseConfig(root));
    expect(first.status).toBe(0);
    const rows = readJson(path.join(root, "evidence/results-new.json")) as unknown as Row[];
    expect(rows).toHaveLength(2);
    const [rowA, rowB] = rows;
    if (!rowA || !rowB) throw new Error("expected two rows");
    for (const row of [rowA, rowB]) {
      expect(row.resolved).toBe(true);
      expect(row.validGrade).toBe(true);
      expect(row.modelRequests).toBe(1);
      expect(row.usageUsd).toBeCloseTo(0.01);
      expect(row.usageHoldUsd).toBe(0);
      expect(row.timedOut).toBe(false);
      expect(row.verdict.status).toBe("pass");
    }
    expect(rowA.baselineTree).toBe(rowB.baselineTree);
    expect(rowA.baselineTree).toBeTruthy();
    const checkpoints = readJson(path.join(root, "evidence/checkpoints.json")) as Record<string, { phase: string }>;
    expect(Object.values(checkpoints).every((checkpoint) => checkpoint.phase === "finished")).toBe(true);
    const summary = readJson(path.join(root, "evidence/summary.json")) as unknown as Summary;
    expect(summary.state).toBe("finished");
    expect(summary.counts).toEqual({ processed: 2, attempted: 2, skipped: 0, graded: 2, resolved: 2, executedPairs: 1 });
    expect(summary.comparison.comparablePairs).toBe(1);
    expect(summary.budget.availableUsd).toBeCloseTo(10 - 0.02);
    const controlVerdicts = readJson(path.join(root, "evidence/control-verdicts.json")) as Record<string, { ok: boolean }>;
    expect(controlVerdicts["001"]?.ok).toBe(true);
    // Canonical controls run once per task even with two modes scheduled.
    expect(subs(root).filter((sub) => sub === "controls")).toHaveLength(1);
    // Isolated capture: tracked and untracked edits are in the patch, and the
    // worker's lock plus the real index are untouched.
    const patch = fs.readFileSync(path.join(root, "evidence/attempts/001/capture/patch.diff"), "utf8");
    expect(patch).toContain("func Feature()");
    expect(patch).toContain("scratch.txt");
    expect(fs.readFileSync(path.join(root, "work/attempts/001/repo/.git/index.lock"), "utf8")).toBe("fake worker lock\n");
    expect(subs(root).filter((sub) => sub === "run")).toHaveLength(2);

    const replay = runCoordinator(root, baseConfig(root));
    expect(replay.status).toBe(2);
    expect(replay.stderr).toContain("--resume");

    const resumed = runCoordinator(root, baseConfig(root), ["--resume"]);
    expect(resumed.status).toBe(0);
    // Zero replay: no additional paid-model run commands were issued.
    expect(subs(root).filter((sub) => sub === "run")).toHaveLength(2);
  });

  it("never reissues a started-but-unfinished attempt and stops for offline recovery", () => {
    const root = temporary();
    fs.mkdirSync(path.join(root, "evidence"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "evidence/checkpoints.json"),
      JSON.stringify({ "001": { phase: "finished" }, "002": { phase: "starting" } }, null, 2) + "\n",
    );
    const result = runCoordinator(root, baseConfig(root), ["--resume"]);
    expect(result.status).toBe(1);
    const summary = readJson(path.join(root, "evidence/summary.json")) as unknown as Summary;
    expect(summary.state).toBe("needs-attention");
    expect(summary.needsRecovery).toEqual(["002"]);
    expect(summary.executedThisRun).toEqual([]);
    expect(subs(root)).toEqual([]);
  });

  it("stops before any paid call when the monitored budget is exhausted", () => {
    const root = temporary();
    const result = runCoordinator(
      root,
      baseConfig(root, {
        maximumTotalUsd: 0.05,
        priorKnownUsd: 0.06,
        priorUnknownWorstCaseUsd: 0,
        maximumRequestUsd: { "fake-main": 1 },
      }),
    );
    expect(result.status).toBe(1);
    const summary = readJson(path.join(root, "evidence/summary.json")) as unknown as Summary;
    expect(summary.state).toBe("budget-stopped");
    expect(subs(root)).toEqual([]);
  });
});
