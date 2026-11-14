import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildCliContext } from "../src/cli/context.js";
import { parseExpandArgv, runExpandCall } from "../src/cli/expand.js";
import { runRecall } from "../src/cli/recall.js";

const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const setup = (branch = false) => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-recall-continuation-"));
  temporary.push(dir);
  const sessions = path.join(dir, "sessions", "--review--");
  mkdirSync(sessions, { recursive: true });
  const file = path.join(sessions, "session.jsonl");
  const write = (text: string) => writeFileSync(file, [
    { type: "session", version: 3, id: "review", cwd: "/review", timestamp: "2026-11-11T00:00:00.000Z" },
    { type: "message", id: "a", parentId: null, message: { role: "user", content: text } },
    ...(branch ? [
      { type: "message", id: "b", parentId: "a", message: { role: "assistant", content: "abandoned" } },
      { type: "message", id: "c", parentId: "a", message: { role: "assistant", content: "active" } },
    ] : []),
  ].map(row => JSON.stringify(row)).join("\n") + "\n");
  write("A".repeat(600));
  return { file, write, context: buildCliContext({ agentDir: dir, config: { indexDir: path.join(dir, "index") } }) };
};

const continuation = (lines: string[]) => {
  const hint = lines.find(line => line.includes("more entries"));
  expect(hint).toBeDefined();
  const operands = hint!.split("continue with: ")[1]!.replace(/\)$/, "");
  // Decode the formatter's single-quoted fixture operands. The subprocess
  // test below separately verifies real POSIX and PowerShell escaping.
  const tokens = operands.match(/'(?:[^']|'')*'|\S+/g) ?? [];
  return parseExpandArgv(tokens.map(token => token.startsWith("'")
    ? token.slice(1, -1).replace(/''/g, "'") : token));
};

describe("bound CLI continuations", () => {
  test("retains all-branch selection and the page budget", async () => {
    const { file, context } = setup(true);
    const first = await runExpandCall({ session: file, idx: [0, 1, 2], branches: "all", maxChars: 256 }, context);
    expect(first.ok).toBe(true);
    const next = continuation(first.lines);
    expect(next.branches).toBe("all");
    expect(next.maxChars).toBe(256);
    expect(next.expectedSourceHash).toBeString();
    expect(next.expectedLineageFingerprint).toBeString();
    expect((await runExpandCall(next, context)).ok).toBe(true);
  });

  test("refuses a rewritten source even after rebuilding the index", async () => {
    const { file, write, context } = setup();
    await runRecall({ query: "A", scope: "global" }, context);
    const first = await runExpandCall({ id: "a", idx: [], maxChars: 256 }, context);
    expect(first.ok).toBe(true);
    const next = continuation(first.lines);
    expect(next.id).toBeUndefined();
    expect(next.session).toBe(file);
    write("B".repeat(600));
    await runRecall({ query: "B", scope: "global" }, context);
    const second = await runExpandCall(next, context);
    expect(second.ok).toBe(false);
    expect(second.lines.join("\n")).toContain("stale_pointer");
  });

  test("retains role filtering across every text page", async () => {
    const { file, context } = setup(true);
    let page = await runExpandCall({ session: file, idx: [0, 1, 2], branches: "all", role: "user", maxChars: 256 }, context);
    let pages = 0;
    while (true) {
      expect(page.ok).toBe(true);
      expect(page.lines.join("\n")).not.toContain("assistant");
      pages++;
      if (!page.lines.some(line => line.includes("more entries"))) break;
      const next = continuation(page.lines);
      expect(next.role).toBe("user");
      expect(pages).toBeLessThan(5);
      page = await runExpandCall(next, context);
    }
    expect(pages).toBe(3);
  });

  test("prints an executable continuation for paths with spaces and apostrophes", async () => {
    const { file, context } = setup();
    const quoted = path.join(path.dirname(file), "session with 'quote.jsonl");
    writeFileSync(quoted, [
      { type: "session", id: "quoted", cwd: "/review" },
      { type: "message", id: "q", parentId: null, message: { role: "user", content: "Q".repeat(600) } },
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    const first = await runExpandCall({ session: quoted, idx: [0], maxChars: 256 }, context);
    expect(first.ok).toBe(true);
    const hint = first.lines.find(line => line.includes("more entries"))!;
    const operands = hint.split("continue with: ")[1]!.replace(/\)$/, "");
    const bin = path.resolve(import.meta.dir, "../bin/pi-recall");
    const command = `bun "${bin}" expand ${operands}`;
    const proc = Bun.spawnSync(process.platform === "win32"
      ? ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command]
      : ["sh", "-c", command], {
      env: { ...process.env, PI_CODING_AGENT_DIR: context.agentDir, PI_RECALL_INDEX_DIR: context.config.indexDir! },
    });
    expect(new TextDecoder().decode(proc.stderr)).toBe("");
    expect(proc.exitCode).toBe(0);
    expect(new TextDecoder().decode(proc.stdout)).toContain("Q".repeat(256));
  });

  test("enforces a caller-supplied lineage binding", async () => {
    const { file, context } = setup();
    const page = await runExpandCall({ session: file, idx: [0], expectedLineageFingerprint: "stale" }, context);
    expect(page.ok).toBe(false);
    expect(page.lines.join("\n")).toContain("stale_pointer");
  });
});
