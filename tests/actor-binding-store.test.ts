import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActorBindingStore } from "../src/actors/binding-store.js";
import { encodeOwnerIdentityLine } from "../src/core/atomic-write.js";

const roots: string[] = [];

const setup = (): { first: ActorBindingStore; second: ActorBindingStore } => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-bindings-"));
  roots.push(root);
  return {
    first: new ActorBindingStore("session:shared", root),
    second: new ActorBindingStore("session:shared", root),
  };
};

// A real pid that just exited, with the identity line the store writes.
const deadChildPid = (): number => {
  const child = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore", timeout: 10_000 });
  expect(child.status).toBe(0);
  expect(child.pid).toBeGreaterThan(0);
  return child.pid!;
};
const foreignNamespaceLine = (): string => {
  const own = JSON.parse(encodeOwnerIdentityLine()) as Record<string, unknown>;
  return JSON.stringify({
    hostname: own.hostname,
    pidNamespace: "pid:[1]",
    bootId: own.bootId,
    startedAt: own.startedAt,
  });
};

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("ActorBindingStore", () => {
  it("recovers a fresh lock at once when its local owner is provably dead", async () => {
    const { first } = setup();
    const lockPath = `${first.filePath!}.lock`;
    const pid = deadChildPid();
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, "owner"), `crashed\n${pid}\n${Date.now()}\n${encodeOwnerIdentityLine()}\n`);

    const started = performance.now();
    await first.setModel("actor:a", "provider/model-a");

    expect(performance.now() - started).toBeLessThan(2_000);
    expect(first.get("actor:a")).toMatchObject({ model: "provider/model-a" });
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("honours a fresh legacy or foreign lock with a dead pid until the timeout", async () => {
    const pid = deadChildPid();
    for (const identityLine of [undefined, foreignNamespaceLine()]) {
      const { first } = setup();
      const lockPath = `${first.filePath!}.lock`;
      vi.useFakeTimers();
      const owner = `previous\n${pid}\n${Date.now()}\n${identityLine ?? ""}`;
      fs.mkdirSync(lockPath, { recursive: true });
      fs.writeFileSync(path.join(lockPath, "owner"), owner);
      const result = expect(first.setModel("actor:a", "provider/model-a")).rejects.toThrow(
        "Timed out waiting for the Fabric actor binding lock",
      );
      await vi.advanceTimersByTimeAsync(5_000);
      await result;
      expect(fs.readFileSync(path.join(lockPath, "owner"), "utf8")).toBe(owner);
      vi.useRealTimers();
      expect(first.get("actor:a")).toBeUndefined();
    }
  });

  it("merges unrelated writes from stale stores under one session lock", async () => {
    const { first, second } = setup();

    await first.setModel("actor:a", "provider/model-a");
    await second.setThinking("actor:b", "high");

    expect(first.get("actor:a")).toMatchObject({ model: "provider/model-a" });
    expect(first.get("actor:b")).toMatchObject({ thinking: "high" });
    expect(second.get("actor:a")).toMatchObject({ model: "provider/model-a" });
  });

  it("deletes a binding from the latest file instead of a stale snapshot", async () => {
    const { first, second } = setup();
    await first.setModel("actor:a", "provider/model-a");
    await first.setModel("actor:b", "provider/model-b");

    await second.delete("actor:a");

    expect(first.get("actor:a")).toBeUndefined();
    expect(first.get("actor:b")).toMatchObject({ model: "provider/model-b" });
  });
});
