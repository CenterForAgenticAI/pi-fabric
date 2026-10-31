/** Decision over a host-supplied snapshot, not a distributed lock or reservation. */
export function actorNameDecision(hasActive: boolean, hasStopped: boolean): "available" | "active" | "stopped" {
  if (hasActive) return "active";
  if (hasStopped) return "stopped";
  return "available";
}
