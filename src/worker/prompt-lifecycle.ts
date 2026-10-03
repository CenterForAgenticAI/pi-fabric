// Five times the recovery window: legacy hosts acknowledge before preflight,
// which can include slow input hooks and compaction. Modern hosts acknowledge
// after preflight; boot/model admission is bounded only by the overall deadline.
export const PI_INITIAL_TURN_TIMEOUT_MS = 300_000;

/** Tracks only the ordinary task prompt, never later steering or operator commands. */
export class PiTaskPromptLifecycle {
  #id: string | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #responded = false;
  #started = false;
  #disposed = false;
  private readonly fail: (error: string) => void;

  constructor(fail: (error: string) => void) {
    this.fail = fail;
  }

  sent(id: string): void {
    if (this.#id || this.#disposed) return;
    this.#id = id;
  }

  observe(event: Record<string, unknown>): void {
    if (this.#disposed || !this.#id) return;
    if (event.type === "agent_start") {
      this.#started = true;
      this.#clearTimer();
      return;
    }
    if (event.type !== "response" || event.command !== "prompt" || event.id !== this.#id ||
        event.success !== true || this.#responded) return;
    this.#responded = true;
    const data = event.data;
    if (!this.#started && typeof data === "object" && data !== null && !Array.isArray(data) &&
        (data as Record<string, unknown>).disposition === "handled") {
      this.dispose();
      this.fail("Pi handled the task without starting a turn; terminating child");
      return;
    }
    if (!this.#started) {
      this.#timer = setTimeout(() => {
        this.dispose();
        this.fail("Pi acknowledged the task but did not start a turn within 300000ms; terminating child");
      }, PI_INITIAL_TURN_TIMEOUT_MS);
      this.#timer.unref?.();
    }
  }

  #clearTimer(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  dispose(): void {
    this.#clearTimer();
    this.#disposed = true;
  }
}
