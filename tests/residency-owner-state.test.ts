import { describe, expect, it } from "vitest";
import type { Liveness } from "../src/core/process-liveness.js";
import {
  RESIDENT_OWNER_STALE_MS,
  residentOwnerLive,
} from "../src/residency/owner-state.js";

const now = 1_000_000;
const verdict = (value: Liveness) => () => value;

describe("residentOwnerLive", () => {
  it("follows an observable verdict regardless of the heartbeat", () => {
    expect(residentOwnerLive({ pid: 42, heartbeatAt: 0 }, now, verdict("alive"))).toBe(true);
    expect(residentOwnerLive({ pid: 42, heartbeatAt: now }, now, verdict("dead"))).toBe(false);
  });

  it("keeps an unobservable owner with a fresh heartbeat live, so no second host starts", () => {
    const owner = { pid: 2, pidNamespace: "pid:[1]", heartbeatAt: now - RESIDENT_OWNER_STALE_MS };
    expect(residentOwnerLive(owner, now, verdict("unknown"))).toBe(true);
  });

  it("releases an unobservable owner whose heartbeat went stale, so the host does not wedge", () => {
    const owner = { pid: 2, pidNamespace: "pid:[1]", heartbeatAt: now - RESIDENT_OWNER_STALE_MS - 1 };
    expect(residentOwnerLive(owner, now, verdict("unknown"))).toBe(false);
  });

  it("falls back to readyAt for owners written before heartbeats", () => {
    expect(residentOwnerLive({ pid: 2, readyAt: now - 1_000 }, now, verdict("unknown"))).toBe(true);
    expect(residentOwnerLive({ pid: 2, readyAt: now - 60_000 }, now, verdict("unknown"))).toBe(false);
  });

  it("ages a startup lock by its creation time", () => {
    expect(residentOwnerLive({ pid: 2, createdAt: now - 1_000 }, now, verdict("unknown"))).toBe(true);
    expect(residentOwnerLive({ pid: 2, createdAt: now - 60_000 }, now, verdict("unknown"))).toBe(false);
  });

  it("releases an unobservable record without any timestamp", () => {
    expect(residentOwnerLive({ pid: 2 }, now, verdict("unknown"))).toBe(false);
  });

  it("rejects malformed pids and timestamps without probing", () => {
    let probed = false;
    const probe = () => { probed = true; return "alive" as const; };
    expect(residentOwnerLive({ pid: "2" }, now, probe)).toBe(false);
    expect(residentOwnerLive({ pid: 0 }, now, probe)).toBe(false);
    expect(probed).toBe(false);
    expect(residentOwnerLive({ pid: 2, heartbeatAt: "now" }, now, verdict("unknown"))).toBe(false);
  });

  it("uses the system probe by default", () => {
    expect(residentOwnerLive({ pid: process.pid })).toBe(true);
  });
});
