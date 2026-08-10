export function frameDeltaSeconds(now: number, previous: number, maximumSeconds = 0.1): number {
  if (!Number.isFinite(now) || !Number.isFinite(previous) || !Number.isFinite(maximumSeconds) || maximumSeconds <= 0) return 0;
  return Math.max(0, Math.min(maximumSeconds, (now - previous) / 1_000));
}
