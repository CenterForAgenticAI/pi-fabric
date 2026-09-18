export const formatToolCallDuration = (
  startedAt: number | undefined,
  endedAt: number | undefined,
): string | undefined => {
  if (startedAt === undefined || endedAt === undefined) return undefined;
  const durationMs = endedAt - startedAt;
  if (!Number.isFinite(durationMs) || durationMs <= 0) return undefined;
  return durationMs < 1_000
    ? `${durationMs}ms`
    : `${(durationMs / 1_000).toFixed(1)}s`;
};
