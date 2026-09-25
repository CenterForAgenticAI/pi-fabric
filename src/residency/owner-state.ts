// Whether a resident host owner record, or the lock of a host that is still
// starting, names a running host.
//
// A client or a second host in another PID namespace cannot probe the owner's
// PID, so the running host refreshes `heartbeatAt` in its owner record. A
// fresh heartbeat keeps an unobservable owner live (no second host, no split
// brain); a stale one releases it (no wedge after the owner died).

import { processLiveness, stampFromRecord, type Liveness, type ProcessStamp } from "../core/process-liveness.js";

/** How often a running resident host refreshes its owner record. */
export const RESIDENT_HEARTBEAT_MS = 5_000;
/** How long an owner that cannot be probed stays live after its last refresh. */
export const RESIDENT_OWNER_STALE_MS = 30_000;

export interface ResidentOwnerRecord {
  pid?: unknown;
  pidNamespace?: unknown;
  startTime?: unknown;
  /** Owner record: last refresh by the running host. */
  heartbeatAt?: unknown;
  /** Owner record written before heartbeats: the host became ready. */
  readyAt?: unknown;
  /** Startup lock: when the starting host took it. */
  createdAt?: unknown;
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

const lastSeen = (record: ResidentOwnerRecord): number | undefined =>
  [record.heartbeatAt, record.readyAt, record.createdAt].find(finite);

export const residentOwnerLive = (
  record: ResidentOwnerRecord,
  now = Date.now(),
  liveness: (stamp: ProcessStamp) => Liveness = processLiveness,
): boolean => {
  const stamp = stampFromRecord(record);
  if (!Number.isSafeInteger(stamp.pid) || stamp.pid <= 0) return false;
  const verdict = liveness(stamp);
  if (verdict !== "unknown") return verdict === "alive";
  const seen = lastSeen(record);
  return seen !== undefined && now - seen <= RESIDENT_OWNER_STALE_MS;
};
