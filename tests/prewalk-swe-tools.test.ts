import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  analyzeRequestLifecycle,
  classifyCandidate,
  classifyControls,
  planResume,
  summarizeAttempts,
} from "../scripts/lib/prewalk-swe-evidence.mjs";
import { capturePatch } from "../scripts/lib/prewalk-patch.mjs";

interface GradeRecord {
  valid: boolean;
  resolved: boolean;
  error: string | null;
  parsedTests: number;
  requiredTests: number;
  requiredTestsPassed: number;
}

interface Execution {
  setupOk: boolean;
  testStarted: boolean;
  testExitCode: number | null;
  stdout: string;
  stderr: string;
}

interface Arm {
  result: GradeRecord;
  execution: Execution;
}

const roots: string[] = [];
const temporary = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prewalk-swe-test-"));
  roots.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

const report = (overrides: Partial<GradeRecord> = {}): GradeRecord => ({
  valid: true,
  resolved: false,
  error: null,
  parsedTests: 2,
  requiredTests: 2,
  requiredTestsPassed: 1,
  ...overrides,
});
const execution = (overrides: Partial<Execution> = {}): Execution => ({
  setupOk: true,
  testStarted: true,
  testExitCode: 1,
  stdout: "",
  stderr: "",
  ...overrides,
});
const passingGold = (): Arm => ({
  result: report({ resolved: true, requiredTestsPassed: 2 }),
  execution: execution({ testExitCode: 0 }),
});

describe("SWE recovery grader argument validation", () => {
  const validateGrader = (gradePython?: string) => {
    const root = temporary();
    const source = path.join(root, "source");
    fs.mkdirSync(path.join(source, "evidence"), { recursive: true });
    for (const name of ["results", "task-manifest", "schedule"]) {
      fs.writeFileSync(path.join(source, "evidence", `${name}.json`), "{}\n");
    }
    fs.mkdirSync(path.join(source, "work/support"), { recursive: true });
    fs.writeFileSync(path.join(source, "work/support/grade.py"), "# argument-validation fixture\n");
    const out = path.join(root, "out");
    // Stop at the next validator: this tests argument handling, not real grading.
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL("../scripts/prewalk-swe-recover.mjs", import.meta.url)),
      "--source", source, "--out", out, "--attempt", "probe", "--grade-timeout-ms", "0",
      ...(gradePython === undefined ? [] : ["--grade-python", gradePython]),
    ], { encoding: "utf8", timeout: 10_000 });
    return { result, out };
  };

  it.each([undefined, "python3", path.basename(process.execPath)])("does not interpret PATH grader %s as a filesystem path", (gradePython) => {
    const { result, out } = validateGrader(gradePython);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr.trim())).toEqual({ ok: false, error: "--grade-timeout-ms must be a positive integer" });
    expect(fs.existsSync(out)).toBe(false);
  });

  it("retains the missing explicit grader path error", () => {
    const missing = path.join(temporary(), "missing-python");
    const { result, out } = validateGrader(missing);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr.trim())).toEqual({ ok: false, error: `--grade-python not found: ${missing}` });
    expect(fs.existsSync(out)).toBe(false);
  });
});

describe("SWE control classification", () => {
  it.each([
    "models/packages_test.go:389:10: undefined: PortStat\nFAIL example/models [build failed]",
    "ImportError while importing test module '/app/tests/test_feature.py'.\nImportError: cannot import name 'process_google_book' from 'scripts.affiliate_server'",
  ])("accepts an evidenced failing no-op with a passing gold control: %s", (stderr) => {
    const controls = classifyControls({
      noop: { result: report({ valid: false, parsedTests: 0, requiredTestsPassed: 0 }), execution: execution({ stderr }) },
      gold: passingGold(),
    });
    expect(controls.ok).toBe(true);
    expect(controls.noop.status).toBe("fail");
    expect(controls.gold.status).toBe("pass");
  });

  it.each([
    { setupOk: false, stderr: "undefined: PortStat" },
    { testStarted: false, stderr: "undefined: PortStat" },
    { stderr: "bash: go: command not found" },
    { stderr: "npm ERR! Cannot read properties of undefined (reading 'stdin')" },
    { stderr: "" },
  ])("does not bless empty or broken no-op evidence: %j", (partial) => {
    const controls = classifyControls({
      noop: { result: report({ valid: false, parsedTests: 0, requiredTestsPassed: 0 }), execution: execution(partial) },
      gold: passingGold(),
    });
    expect(controls.ok).toBe(false);
    expect(controls.noop.acceptable).toBe(false);
  });

  it("keeps gold controls strict even when a no-op compile failure looks expected", () => {
    const controls = classifyControls({
      noop: { result: report({ valid: false, parsedTests: 0 }), execution: execution({ stderr: "a_test.go:1:1: undefined: Feature" }) },
      gold: { result: report({ valid: false, parsedTests: 0, requiredTestsPassed: 0 }), execution: execution({ stderr: "npm ERR! build failed" }) },
    });
    expect(controls.ok).toBe(false);
    expect(controls.gold.status).toBe("fail");
  });
});

describe("candidate attribution", () => {
  it("counts an evidenced candidate syntax failure in the comparison", () => {
    const verdict = classifyCandidate({
      result: report({ valid: false, parsedTests: 0, requiredTestsPassed: 0 }),
      controlsPassed: true,
      execution: execution({
        stdout: "collecting ... collected 0 items / 3 errors\nFile \"/app/pkg/model.py\", line 542\nSyntaxError: expected '('",
      }),
    });
    expect(verdict.status).toBe("fail");
    expect(verdict.validComparison).toBe(true);
  });

  it("does not attribute missing infrastructure evidence to the candidate", () => {
    const verdict = classifyCandidate({
      result: report({ valid: false, parsedTests: 0 }),
      controlsPassed: true,
      execution: execution({ testStarted: false, stderr: "SyntaxError: expected '('" }),
    });
    expect(verdict.validComparison).toBe(false);
    expect(verdict.status).toBe("unobserved");
  });

  it("failed preflight controls leave a candidate unobserved", () => {
    const verdict = classifyCandidate({
      result: report({ resolved: true, requiredTestsPassed: 2 }),
      controlsPassed: false,
      execution: execution({ testExitCode: 0 }),
    });
    expect(verdict.validComparison).toBe(false);
    expect(verdict.status).toBe("unobserved");
  });
});

describe("request lifecycle accounting", () => {
  const limits = { maximumRequestUsd: { flash: 0.7753728, astra: 16.4 } };
  it("HTTP response headers do not settle usage", () => {
    const state = analyzeRequestLifecycle(
      [
        { type: "provider_request", number: 1, model: "flash" },
        { type: "provider_response", number: 1, status: 200 },
        { type: "session_shutdown" },
      ],
      limits,
    );
    expect(state.uncertain).toBe(true);
    expect(state.unsettled).toHaveLength(1);
    expect(state.heldUsd).toBeCloseTo(0.7753728);
    expect(state.knownUsd).toBe(0);
  });
  it("finalized usage settles a request without double counting", () => {
    const state = analyzeRequestLifecycle(
      [
        { type: "provider_request", number: 1, model: "astra" },
        { type: "provider_response", number: 1, status: 200 },
        { type: "assistant_end", model: "astra", stopReason: "stop", usage: { cost: { total: 0.4 } } },
        { type: "session_shutdown" },
      ],
      limits,
    );
    expect(state.uncertain).toBe(false);
    expect(state.heldUsd).toBe(0);
    expect(state.knownUsd).toBeCloseTo(0.4);
  });
  it("aborted requests keep partial usage plus an uncertainty hold", () => {
    const state = analyzeRequestLifecycle(
      [
        { type: "provider_request", number: 1, model: "flash" },
        { type: "assistant_end", model: "flash", stopReason: "aborted", usage: { cost: { total: 0.02 } } },
      ],
      limits,
    );
    expect(state.uncertain).toBe(true);
    expect(state.knownUsd).toBeCloseTo(0.02);
    expect(state.heldUsd).toBeGreaterThan(0);
  });
  it("rejects duplicated request identities", () => {
    expect(() =>
      analyzeRequestLifecycle(
        [
          { type: "provider_request", number: 1, model: "flash" },
          { type: "provider_request", number: 1, model: "flash" },
        ],
        limits,
      )).toThrow(/duplicate/i);
  });
  it("rejects an unsettled request for a model without a conservative cap", () => {
    expect(() =>
      analyzeRequestLifecycle([{ type: "provider_request", number: 1, model: "unknown-model" }], limits)).toThrow(/cap/i);
  });
});

describe("truthful counters and checkpoint resume", () => {
  it("a pair of skipped schedule entries is not an executed pair", () => {
    const summary = summarizeAttempts([
      { id: "001", index: 0, mode: "astra", modelRequests: 0, failureKind: "grader-controls" },
      { id: "002", index: 0, mode: "prewalk", modelRequests: 0, failureKind: "grader-controls" },
      { id: "003", index: 1, mode: "astra", modelRequests: 2, validGrade: true, resolved: true },
    ]);
    expect(summary).toEqual({ processed: 3, attempted: 1, skipped: 2, graded: 1, resolved: 1, executedPairs: 0 });
  });
  it("never reissues a started run with missing evidence", () => {
    const plan = planResume([{ id: "001" }, { id: "002" }, { id: "003" }], [
      { id: "001", phase: "finished" },
      { id: "002", phase: "started" },
    ]);
    expect(plan.runnable.map((r) => r.id)).toEqual(["003"]);
    expect(plan.needsRecovery.map((r) => r.id)).toEqual(["002"]);
    expect(plan.completed.map((r) => r.id)).toEqual(["001"]);
  });
});

describe("lock-safe patch capture", () => {
  it("includes tracked and untracked edits without touching the original index, lock or HEAD", async () => {
    const root = temporary();
    const repo = path.join(root, "repo");
    const out = path.join(root, "capture");
    fs.mkdirSync(repo);
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    git("init", "-q");
    git("config", "user.name", "test");
    git("config", "user.email", "test@localhost");
    fs.writeFileSync(path.join(repo, "tracked.txt"), "before\n");
    fs.writeFileSync(path.join(repo, ".gitignore"), "ignored.txt\n");
    git("add", ".");
    git("commit", "-qm", "baseline");
    const baseline = git("rev-parse", "HEAD").trim();
    const index = fs.readFileSync(path.join(repo, ".git/index"));
    fs.writeFileSync(path.join(repo, "tracked.txt"), "after\n");
    fs.writeFileSync(path.join(repo, "new.txt"), "new content\n");
    fs.writeFileSync(path.join(repo, "ignored.txt"), "not part of the patch\n");
    const lock = path.join(repo, ".git/index.lock");
    fs.writeFileSync(lock, "intentional lock fixture\n");
    const captured = await capturePatch({ repo, baseline, out });
    const patch = fs.readFileSync(captured.patchPath, "utf8");
    expect(patch).toContain("+after");
    expect(patch).toContain("new.txt");
    expect(patch).not.toContain("ignored.txt");
    expect(fs.readFileSync(path.join(repo, ".git/index")).equals(index)).toBe(true);
    expect(fs.readFileSync(lock, "utf8")).toBe("intentional lock fixture\n");
    expect(git("rev-parse", "HEAD").trim()).toBe(baseline);
    expect(fs.readFileSync(path.join(repo, "tracked.txt"), "utf8")).toBe("after\n");
    await expect(capturePatch({ repo, baseline, out })).rejects.toThrow(/exist|overwrite/i);
  });
});
