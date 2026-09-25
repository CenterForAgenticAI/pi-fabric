// Cross-process exclusive lock for Fabric's durable stores (the repair
// table, the compiled entropy surface). Acquisition is a bounded retry over
// mkdir; stale-lock recovery is an exclusive rename claim, so racing
// reapers can never delete a lock a fresh writer owns.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { formatLockOwner, parseLockOwner, processLiveness } from "./process-liveness.js";

const DEFAULT_LOCK_ATTEMPTS = 50;
const DEFAULT_LOCK_DELAY_MS = 5;
const DEFAULT_STALE_LOCK_MS = 30_000;

export interface ExclusiveLockOptions {
  directory: string;
  lockName: string;
  /** Error message when acquisition times out. */
  timeoutMessage: string;
  staleMs?: number;
  attempts?: number;
  delayMs?: number;
}

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;

const sleepSync = (() => {
  try {
    const buffer = new Int32Array(new SharedArrayBuffer(4));
    return (ms: number): void => {
      Atomics.wait(buffer, 0, 0, ms);
    };
  } catch {
    return (): void => undefined;
  }
})();

const sleepAsync = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const reapStaleLockAsync = async (
  lock: string,
  verify: (claimed: string) => Promise<boolean>,
): Promise<boolean> => {
  const claim = `${lock}.reap-${process.pid}-${randomUUID()}`;
  try {
    await fs.promises.rename(lock, claim);
  } catch {
    return false;
  }
  if (!(await verify(claim))) {
    try {
      await fs.promises.rename(claim, lock);
    } catch {
      if (await verify(claim)) {
        await fs.promises.rm(claim, { recursive: true, force: true });
      }
    }
    return false;
  }
  await fs.promises.rm(claim, { recursive: true, force: true });
  return true;
};

export const withExclusiveFileLockAsync = async <T>(
  options: ExclusiveLockOptions,
  operation: () => T | Promise<T>,
): Promise<T> => {
  const attempts = options.attempts ?? DEFAULT_LOCK_ATTEMPTS;
  const delayMs = options.delayMs ?? DEFAULT_LOCK_DELAY_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_LOCK_MS;
  await fs.promises.mkdir(options.directory, { recursive: true, mode: 0o700 });
  const lock = path.join(options.directory, options.lockName);
  const ownerPath = path.join(lock, "owner");
  const token = randomUUID();
  let acquired = false;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await fs.promises.mkdir(lock, { mode: 0o700 });
      try {
        await fs.promises.writeFile(ownerPath, formatLockOwner(token), {
          encoding: "utf-8",
          mode: 0o600,
        });
      } catch (error) {
        await fs.promises.rm(lock, { recursive: true, force: true });
        throw error;
      }
      acquired = true;
      break;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      try {
        const firstOwner = await fs.promises.readFile(ownerPath, "utf8");
        const { createdAt, stamp } = parseLockOwner(firstOwner);
        const stale = Date.now() - createdAt > staleMs;
        if (stale && processLiveness(stamp) !== "alive") {
          const secondOwner = await fs.promises.readFile(ownerPath, "utf8");
          if (
            secondOwner === firstOwner &&
            await reapStaleLockAsync(lock, async (claimed) => {
              try {
                const owner = await fs.promises.readFile(path.join(claimed, "owner"), "utf8");
                const claimedOwner = parseLockOwner(owner);
                return Date.now() - claimedOwner.createdAt > staleMs &&
                  processLiveness(claimedOwner.stamp) !== "alive";
              } catch {
                return false;
              }
            })
          ) {
            continue;
          }
        }
      } catch {
        try {
          const first = await fs.promises.stat(lock);
          if (
            Date.now() - first.mtimeMs > staleMs &&
            await reapStaleLockAsync(lock, async (claimed) => {
              try {
                return Date.now() - (await fs.promises.stat(claimed)).mtimeMs > staleMs;
              } catch {
                return false;
              }
            })
          ) {
            continue;
          }
        } catch {
          // Lock creation or stale recovery raced; retry the bounded acquisition.
        }
      }
      if (attempt === attempts - 1) break;
      await sleepAsync(delayMs);
    }
  }
  if (!acquired) throw new Error(options.timeoutMessage);
  try {
    return await operation();
  } finally {
    try {
      const owner = await fs.promises.readFile(ownerPath, "utf8");
      if (owner.startsWith(`${token}\n`)) {
        await fs.promises.rm(lock, { recursive: true, force: true });
      }
    } catch {
      // A recovering process already removed this lock.
    }
  }
};

// Stale-lock recovery must be an exclusive claim. Stat-then-delete is
// TOCTOU: two reapers (or a reaper and a fresh writer that recreated the
// lock in between) can both pass their checks, and the slower rm then
// deletes a lock the faster one already replaced. rename() is the claim —
// only one process can move the directory, and removal targets the claimed
// path, never the live lock path. A claim that turns out to hold a live
// lock is renamed back before any destructive step; a live lock is never
// deleted, even if the rename-back races a fresh writer.
const reapStaleLock = (lock: string, verify: (claimed: string) => boolean): boolean => {
  const claim = `${lock}.reap-${process.pid}-${randomUUID()}`;
  try {
    fs.renameSync(lock, claim);
  } catch {
    return false;
  }
  if (!verify(claim)) {
    try {
      fs.renameSync(claim, lock);
    } catch {
      // `lock` was recreated after the claim. Re-verify before any
      // destructive step so a claimed live lock is only ever abandoned as
      // garbage, never deleted.
      if (verify(claim)) fs.rmSync(claim, { recursive: true, force: true });
    }
    return false;
  }
  fs.rmSync(claim, { recursive: true, force: true });
  return true;
};

export const withExclusiveFileLock = <T>(
  options: ExclusiveLockOptions,
  operation: () => T,
): T => {
  const attempts = options.attempts ?? DEFAULT_LOCK_ATTEMPTS;
  const delayMs = options.delayMs ?? DEFAULT_LOCK_DELAY_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_LOCK_MS;
  fs.mkdirSync(options.directory, { recursive: true, mode: 0o700 });
  const lock = path.join(options.directory, options.lockName);
  const ownerPath = path.join(lock, "owner");
  const token = randomUUID();
  let acquired = false;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
      try {
        fs.writeFileSync(ownerPath, formatLockOwner(token), {
          encoding: "utf-8",
          mode: 0o600,
        });
      } catch (error) {
        fs.rmSync(lock, { recursive: true, force: true });
        throw error;
      }
      acquired = true;
      break;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      try {
        const firstOwner = fs.readFileSync(ownerPath, "utf8");
        const { createdAt, stamp } = parseLockOwner(firstOwner);
        const stale = Date.now() - createdAt > staleMs;
        if (stale && processLiveness(stamp) !== "alive") {
          const secondOwner = fs.readFileSync(ownerPath, "utf8");
          if (
            secondOwner === firstOwner &&
            reapStaleLock(lock, (claimed) => {
              try {
                const owner = fs.readFileSync(path.join(claimed, "owner"), "utf8");
                const claimedOwner = parseLockOwner(owner);
                return Date.now() - claimedOwner.createdAt > staleMs &&
                  processLiveness(claimedOwner.stamp) !== "alive";
              } catch {
                return false;
              }
            })
          ) {
            continue;
          }
        }
      } catch {
        try {
          // Ownerless lock (crash between mkdir and the owner write): age is
          // the only signal, and the claim re-verifies it after the rename.
          const first = fs.statSync(lock);
          if (
            Date.now() - first.mtimeMs > staleMs &&
            reapStaleLock(lock, (claimed) => {
              try {
                return Date.now() - fs.statSync(claimed).mtimeMs > staleMs;
              } catch {
                return false;
              }
            })
          ) {
            continue;
          }
        } catch {
          // Lock creation or stale recovery raced; retry the bounded acquisition.
        }
      }
      if (attempt === attempts - 1) break;
      sleepSync(delayMs);
    }
  }
  if (!acquired) throw new Error(options.timeoutMessage);
  try {
    return operation();
  } finally {
    try {
      const owner = fs.readFileSync(ownerPath, "utf8");
      if (owner.startsWith(`${token}\n`)) {
        fs.rmSync(lock, { recursive: true, force: true });
      }
    } catch {
      // A recovering process already removed this lock.
    }
  }
};