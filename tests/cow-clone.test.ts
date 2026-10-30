import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cloneTree, CowUnavailableError } from "../src/agents/cow-clone.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const sourceTree = (): { source: string; dest: string } => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-cow-clone-"));
  roots.push(root);
  const source = path.join(root, "source");
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, "file.txt"), "content\n");
  return { source, dest: path.join(root, "dest") };
};

describe("cloneTree error classification", () => {
  it.each(["ENOTSUP", "EOPNOTSUPP", "EXDEV", "ENOSYS", "ENOTTY"])(
    "reports %s as copy-on-write unavailable",
    async (code) => {
      const { source, dest } = sourceTree();
      vi.spyOn(fs.promises, "cp").mockRejectedValue(Object.assign(new Error(code), { code }));
      await expect(cloneTree(source, dest)).rejects.toBeInstanceOf(CowUnavailableError);
    },
  );

  it("passes other copy errors through unchanged", async () => {
    const { source, dest } = sourceTree();
    const failure = Object.assign(new Error("EACCES"), { code: "EACCES" });
    vi.spyOn(fs.promises, "cp").mockRejectedValue(failure);
    await expect(cloneTree(source, dest)).rejects.toBe(failure);
  });

  it("does not copy a destination that lies inside the source into itself", async () => {
    const { source } = sourceTree();
    const dest = path.join(source, "linked-wt");
    const copied: string[] = [];
    vi.spyOn(fs.promises, "cp").mockImplementation(async (from) => {
      copied.push(String(from));
    });
    await cloneTree(source, dest);
    expect(copied).toEqual([path.join(source, "file.txt")]);
  });
});
