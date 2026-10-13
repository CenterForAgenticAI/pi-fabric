import { afterEach, describe, expect, it, vi } from "vitest";
import { PI_INITIAL_TURN_TIMEOUT_MS, PiTaskPromptLifecycle } from "../src/worker/prompt-lifecycle.js";

afterEach(() => vi.useRealTimers());

describe("Pi task prompt lifecycle", () => {
  it("bounds a legacy successful acknowledgement without any turn", () => {
    vi.useFakeTimers();
    const fail = vi.fn();
    const task = new PiTaskPromptLifecycle(fail);
    expect(PI_INITIAL_TURN_TIMEOUT_MS).toBe(300_000);
    task.sent("task");
    task.observe({ type: "response", command: "prompt", id: "task", success: true });
    vi.advanceTimersByTime(299_999);
    expect(fail).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fail).toHaveBeenCalledExactlyOnceWith(
      "Pi acknowledged the task but did not start a turn within 300000ms; terminating child",
    );
    expect(vi.getTimerCount()).toBe(0);
  });
  it("fails a matching handled task exactly once without retaining caller fields", () => {
    vi.useFakeTimers();
    const fail = vi.fn();
    const task = new PiTaskPromptLifecycle(fail);
    task.sent("task");
    const frame = { type: "response", command: "prompt", id: "task", success: true,
      data: { disposition: "handled", headers: "PRIVATE_SENTINEL" }, error: "PRIVATE_SENTINEL" };
    task.observe(frame);
    task.observe(frame);
    task.observe({ type: "agent_start" });
    vi.advanceTimersByTime(600_000);
    expect(fail).toHaveBeenCalledExactlyOnceWith("Pi handled the task without starting a turn; terminating child");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("names the child's last warning notice in a handled-task failure", () => {
    const fail = vi.fn();
    const task = new PiTaskPromptLifecycle(fail);
    const notify = (message: unknown, notifyType: unknown) =>
      task.observe({ type: "extension_ui_request", id: "ui", method: "notify", message, notifyType });
    notify("before the task was sent", "warning");
    task.sent("task");
    notify("first warning", "warning");
    notify("Refused: select\nopenai-codex/gpt-5.5\u202e now", "error");
    // Neither an info notice nor a non-string message replaces the refusal.
    notify("informational chatter", "info");
    notify(42, "warning");
    task.observe({ type: "response", command: "prompt", id: "task", success: true,
      data: { disposition: "handled", headers: "PRIVATE_SENTINEL" }, error: "PRIVATE_SENTINEL" });
    notify("after the response", "warning");
    expect(fail).toHaveBeenCalledExactlyOnceWith(
      "Pi handled the task without starting a turn; terminating child. Child notice: Refused: select openai-codex/gpt-5.5 now",
    );
  });

  it("bounds an oversized notice and ignores notices once a turn started", () => {
    const fail = vi.fn();
    const task = new PiTaskPromptLifecycle(fail);
    task.sent("task");
    task.observe({ type: "extension_ui_request", method: "notify", notifyType: "warning", message: "x".repeat(2_000) });
    task.observe({ type: "response", command: "prompt", id: "task", success: true, data: { disposition: "handled" } });
    const error = String(fail.mock.calls[0]?.[0]);
    expect(error).toBe(`Pi handled the task without starting a turn; terminating child. Child notice: ${"x".repeat(499)}…`);

    const started = vi.fn();
    const later = new PiTaskPromptLifecycle(started);
    later.sent("task");
    later.observe({ type: "agent_start" });
    later.observe({ type: "extension_ui_request", method: "notify", notifyType: "warning", message: "late" });
    later.observe({ type: "response", command: "prompt", id: "task", success: true, data: { disposition: "handled" } });
    expect(started).not.toHaveBeenCalled();
  });

  it.each([undefined, "started", "queued"])("allows a delayed turn after %s acknowledgement", disposition => {
    vi.useFakeTimers();
    const fail = vi.fn();
    const task = new PiTaskPromptLifecycle(fail);
    task.sent("task");
    // Boot, admission and modern preflight can consume the overall run budget.
    vi.advanceTimersByTime(600_000);
    expect(vi.getTimerCount()).toBe(0);
    task.observe({ type: "response", command: "prompt", id: "task", success: true, data: { disposition } });
    vi.advanceTimersByTime(299_999);
    task.observe({ type: "agent_start" });
    vi.advanceTimersByTime(600_000);
    expect(fail).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["started", "handled"])("allows start-before-ack and post-start %s receipts", disposition => {
    vi.useFakeTimers();
    const fail = vi.fn();
    const task = new PiTaskPromptLifecycle(fail);
    task.sent("task");
    task.observe({ type: "agent_start" });
    task.observe({ type: "response", command: "prompt", id: "task", success: true, data: { disposition } });
    task.observe({ type: "response", command: "steer", success: true, data: { disposition: "handled" } });
    vi.advanceTimersByTime(600_000);
    expect(fail).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not refresh the deadline on duplicate responses or lifecycle chatter", () => {
    vi.useFakeTimers();
    const fail = vi.fn();
    const task = new PiTaskPromptLifecycle(fail);
    task.sent("task");
    const ack = { type: "response", command: "prompt", id: "task", success: true };
    task.observe(ack);
    vi.advanceTimersByTime(250_000);
    task.observe(ack);
    task.observe({ type: "queue_update", steering: [] });
    vi.advanceTimersByTime(50_000);
    expect(fail).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores unmatched handled commands and leaves native rejection to the worker", () => {
    vi.useFakeTimers();
    const fail = vi.fn();
    const task = new PiTaskPromptLifecycle(fail);
    task.sent("task");
    for (const command of ["prompt", "steer", "follow_up"]) {
      task.observe({ type: "response", command, id: "operator", success: true, data: { disposition: "handled" } });
    }
    task.observe({ type: "response", command: "prompt", id: "task", success: false, error: "native error" });
    vi.advanceTimersByTime(600_000);
    expect(fail).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])("clears timers on teardown and ignores late messages (acknowledged=%s)", acknowledged => {
    vi.useFakeTimers();
    const fail = vi.fn();
    const task = new PiTaskPromptLifecycle(fail);
    task.sent("task");
    if (acknowledged) task.observe({ type: "response", command: "prompt", id: "task", success: true });
    task.dispose();
    task.observe({ type: "response", command: "prompt", id: "task", success: true, data: { disposition: "handled" } });
    task.sent("late-task");
    vi.advanceTimersByTime(600_000);
    expect(fail).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
