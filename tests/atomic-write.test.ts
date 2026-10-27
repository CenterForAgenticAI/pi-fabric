import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatShortLockOwner,
  reapLockByRenameClaim,
  releaseShortLock,
  sweepStaleLockClaims,
  tryAcquireShortLock,
} from "../src/core/atomic-write.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const lockIn = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-atomic-write-"));
  roots.push(root);
  return path.join(root, "store.lock");
};

const claims = (lock: string): string[] =>
  fs.readdirSync(path.dirname(lock)).filter((name) => name.startsWith(`${path.basename(lock)}.reap-`));

const owner = (directory: string): string => fs.readFileSync(path.join(directory, "owner"), "utf8");

describe("short-lock rename-claim", () => {
  it("rename-claim: an owner that releases while a reaper holds its lock does not resurrect it", () => {
    const lock = lockIn();
    expect(tryAcquireShortLock(lock, formatShortLockOwner("held"))).toBe(true);
    let verified = 0;
    const removed = reapLockByRenameClaim(lock, (claimed) => {
      // A failed rename-back verifies again; the claim is gone by then.
      if (verified++ > 0) return fs.existsSync(claimed);
      // The reaper verifies; the owner's critical section ends meanwhile.
      expect(fs.existsSync(lock)).toBe(false);
      expect(owner(claimed).startsWith("held\n")).toBe(true);
      expect(releaseShortLock(lock, "held")).toBe(true);
      // A live owner: the reaper renames the claim back.
      return false;
    });
    expect(removed).toBe(false);
    expect(verified).toBe(2);
    expect(fs.existsSync(lock)).toBe(false);
    expect(claims(lock)).toEqual([]);
    expect(tryAcquireShortLock(lock, formatShortLockOwner("next"))).toBe(true);
  });

  it("rename-claim: a still-held lock is renamed back and later released", () => {
    const lock = lockIn();
    expect(tryAcquireShortLock(lock, formatShortLockOwner("held"))).toBe(true);
    const readdirSync = fs.readdirSync;
    let claim: string | undefined;
    // The reaper's rename-back lands after the release first looked at the
    // lock path and while it scans for claims.
    vi.spyOn(fs, "readdirSync").mockImplementationOnce(((directory: fs.PathLike, options?: unknown) => {
      if (claim) fs.renameSync(claim, lock);
      return readdirSync(directory, options as BufferEncoding);
    }) as typeof fs.readdirSync);
    claim = `${lock}.reap-1-t${Date.now()}-00000000-0000-4000-8000-000000000000`;
    fs.renameSync(lock, claim);
    expect(releaseShortLock(lock, "held")).toBe(true);
    expect(fs.existsSync(lock)).toBe(false);
    expect(claims(lock)).toEqual([]);
  });

  it("rename-claim: an owner releases its lock from a claim a failed rename-back left behind", () => {
    const lock = lockIn();
    expect(tryAcquireShortLock(lock, formatShortLockOwner("held"))).toBe(true);
    const intruder = formatShortLockOwner("intruder");
    let verified = 0;
    reapLockByRenameClaim(lock, () => {
      if (verified++ > 0) return false;
      // A new owner takes the free lock path, so the rename-back fails.
      expect(tryAcquireShortLock(lock, intruder)).toBe(true);
      return false;
    });
    expect(claims(lock)).toHaveLength(1);
    expect(releaseShortLock(lock, "held")).toBe(true);
    expect(claims(lock)).toEqual([]);
    expect(owner(lock)).toBe(intruder);
  });

  it("rename-claim: stale claim dirs are swept without touching the lock", () => {
    const lock = lockIn();
    expect(tryAcquireShortLock(lock, formatShortLockOwner("held"))).toBe(true);
    const uuid = "00000000-0000-4000-8000-000000000000";
    const dated = `${lock}.reap-7-t${Date.now() - 60_000}-${uuid}`;
    const legacy = `${lock}.reap-7-${uuid}`;
    const fresh = `${lock}.reap-8-t${Date.now()}-${uuid}`;
    for (const claim of [dated, legacy, fresh]) {
      fs.mkdirSync(claim);
      fs.writeFileSync(path.join(claim, "owner"), `old\n7\n${Date.now()}\n`);
    }
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(legacy, past, past);
    expect(sweepStaleLockClaims(lock, 30_000)).toBe(2);
    expect(claims(lock)).toEqual([path.basename(fresh)]);
    expect(owner(lock).startsWith("held\n")).toBe(true);
  });
});
