// Five times the recovery window: legacy hosts acknowledge before preflight,
// which can include slow input hooks and compaction. Modern hosts acknowledge
// after preflight; boot/model admission is bounded only by the overall deadline.
export const PI_INITIAL_TURN_TIMEOUT_MS = 300_000;
// An extension command can report "handled" and still start its own turn: it
// calls pi.sendUserMessage or pi.sendMessage without awaiting the run, so the
// receipt precedes agent_start by the run's preparation (compaction check and
// before_agent_start handlers). One recovery window covers that preparation.
export const PI_HANDLED_TASK_GRACE_MS = 60_000;
/** Id of the initial task prompt; later steer, follow-up and operator commands carry none. */
export const PI_TASK_PROMPT_ID = "fabric-task";

const HANDLED_TASK_ERROR = "Pi handled the task without starting a turn; terminating child";
const ACKNOWLEDGED_TASK_ERROR =
  `Pi acknowledged the task but did not start a turn within ${PI_INITIAL_TURN_TIMEOUT_MS}ms; terminating child`;

/** Tracks only the ordinary task prompt, never later steering or operator commands. */
export class PiTaskPromptLifecycle {
  #id: string | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #responded = false;
  #started = false;
  #disposed = false;
  #handled = false;
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
      this.#handled = false;
      this.#clearTimer();
      return;
    }
    if (event.type !== "response" || event.command !== "prompt" || event.id !== this.#id ||
        event.success !== true || this.#responded) return;
    this.#responded = true;
    if (this.#started) return;
    const data = event.data;
    if (typeof data === "object" && data !== null && !Array.isArray(data) &&
        (data as Record<string, unknown>).disposition === "handled") {
      this.#handled = true;
      this.#arm(PI_HANDLED_TASK_GRACE_MS, HANDLED_TASK_ERROR);
      return;
    }
    this.#arm(PI_INITIAL_TURN_TIMEOUT_MS, ACKNOWLEDGED_TASK_ERROR);
  }

  /** The child is gone, so a handled task can no longer start a turn: fail it now. */
  childExited(): void {
    const handled = this.#handled && !this.#disposed;
    this.dispose();
    if (handled) this.fail(HANDLED_TASK_ERROR);
  }

  #arm(delayMs: number, error: string): void {
    this.#timer = setTimeout(() => {
      this.dispose();
      this.fail(error);
    }, delayMs);
    this.#timer.unref?.();
  }

  #clearTimer(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  dispose(): void {
    this.#clearTimer();
    this.#handled = false;
    this.#disposed = true;
  }
}
