import { createHash } from "node:crypto";

/**
 * Degenerate-loop breaker for fabric_exec. Identical guest code back-to-back
 * is how lower-tier models burn a session (2026-09-15: 220x `bash echo noop`
 * on glm-5.3-flash). The fingerprint is the code plus the named payload
 * values, because a short wrapper such as `pi.bash({ cmd: π.cmd })` carries
 * its real work in the payloads. Display names and payload key order are
 * deliberately excluded: cosmetic variation is part of the loop signature,
 * not evidence of new work. Any differing fingerprint resets the count.
 */
export const FABRIC_REPEAT_WARN = 3;
export const FABRIC_REPEAT_BLOCK = 6;

export const fabricRepeatWarnText = (count: number, blockAt: number): string =>
  `[circuit-breaker] identical fabric_exec code has now run ${count} times in a row; at ${blockAt} identical runs will be blocked. Change the approach or finish your turn.`;

export const fabricRepeatBlockText = (count: number): string =>
  `Circuit breaker: this exact fabric_exec code has now executed ${count} times in a row and was blocked. Re-running identical code adds no information. Summarize what you already know and finish your turn; if the call is genuinely required, change the code materially.`;

/**
 * Digest of the code and the canonical payload entries (sorted by key, so key
 * order is cosmetic). The entries are JSON-encoded, so no choice of keys or
 * values can make two different calls serialize alike. Absent, undefined, and
 * empty payloads are one case.
 */
export const fabricRepeatFingerprint = (
  code: string,
  payloads?: Readonly<Record<string, string>>,
): string => {
  const entries = Object.entries(payloads ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash("sha256").update(JSON.stringify([code, entries])).digest("hex");
};

export class FabricRepeatGuard {
  #fingerprint: string | undefined;
  #count = 0;

  constructor(
    /** Consecutive identical executions that start producing a warning. */
    readonly warnAt: number,
    /** Consecutive identical executions that get blocked outright. */
    readonly blockAt: number,
  ) {}

  observe(
    code: string,
    payloads?: Readonly<Record<string, string>>,
  ): { count: number; blocked: boolean; warn: boolean } {
    const fingerprint = fabricRepeatFingerprint(code, payloads);
    this.#count = fingerprint === this.#fingerprint ? this.#count + 1 : 1;
    this.#fingerprint = fingerprint;
    return { count: this.#count, blocked: this.#count >= this.blockAt, warn: this.#count >= this.warnAt };
  }
}
