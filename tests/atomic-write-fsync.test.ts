import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fsyncDirectory, writeFileAtomic } from "../src/core/atomic-write.js";

const roots: string[] = [];
const tempRoot = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-atomic-fsync-"));
  roots.push(root);
  return root;
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const trackFsync = (): string[] => {
  const realOpen = fs.openSync;
  const names = new Map<number, string>();
  vi.spyOn(fs, "openSync").mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
    const descriptor = (realOpen as (...args: unknown[]) => number)(target, ...rest);
    names.set(descriptor, String(target));
    return descriptor;
  }) as typeof fs.openSync);
  const flushed: string[] = [];
  const realFsync = fs.fsyncSync;
  vi.spyOn(fs, "fsyncSync").mockImplementation((descriptor: number) => {
    flushed.push(names.get(descriptor) ?? "?");
    realFsync(descriptor);
  });
  return flushed;
};

describe("writeFileAtomic fsync", () => {
  it("flushes the temporary file and the parent directory only when asked", () => {
    const root = tempRoot();
    const target = path.join(root, "value.json");
    const flushed = trackFsync();

    writeFileAtomic(target, "one");
    expect(flushed).toEqual([]);

    writeFileAtomic(target, "two", { fsync: true });
    expect(fs.readFileSync(target, "utf8")).toBe("two");
    expect(path.basename(flushed[0]!)).toMatch(/^value\.json\..+\.tmp$/);
    // Windows cannot open a directory for fsync, so only the file is flushed there.
    expect(flushed.slice(1)).toEqual(process.platform === "win32" ? [] : [root]);
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(root)).toEqual(["value.json"]);
  });

  it("ignores directories the platform cannot flush and rethrows other errors", () => {
    const root = tempRoot();
    vi.spyOn(fs, "fsyncSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("not supported"), { code: "EINVAL" });
    });
    expect(() => fsyncDirectory(root)).not.toThrow();
    vi.spyOn(fs, "fsyncSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("disk failed"), { code: "EIO" });
    });
    expect(() => fsyncDirectory(root)).toThrow("disk failed");
  });
});
