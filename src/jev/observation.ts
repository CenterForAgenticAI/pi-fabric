import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { prepareFabricActorHostPayload } from "../actors/host-event-payload.js";
import { validationMessage } from "../core/action-arguments.js";
import { object } from "./validation.js";
import type { JevAdvice, JevAdviceResult, JevHostEvent, JevHostEventName, JevJson, JevObserve, JevObservationStats } from "./types.js";

export const JEV_HOST_EVENTS = ["input", "turn_end", "tool_error", "agent_end", "agent_settled"] as const;
export const jevObserveSchema = Type.Object({
  events: Type.Array(Type.Union(JEV_HOST_EVENTS.map(event => Type.Literal(event))), { minItems: 1, maxItems: 5, uniqueItems: true }),
  include: Type.Optional(Type.Array(Type.Union([Type.Literal("inputText"), Type.Literal("assistantText"), Type.Literal("toolResults")]), { maxItems: 3, uniqueItems: true })),
  maxChars: Type.Optional(Type.Integer({ minimum: 256, maximum: 8192 })),
  queueSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 32 })),
  maxEventAgeMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 300_000 })),
  delivery: Type.Optional(Type.Union([Type.Literal("steer"), Type.Literal("followUp")])),
  triggerTurn: Type.Optional(Type.Boolean()),
  maxAdvice: Type.Optional(Type.Integer({ minimum: 1, maximum: 16 })),
}, { additionalProperties: false });

export function checkObserve(value: unknown): asserts value is JevObserve {
  if (!object(value)) throw new Error("Jev observation must be an object");
  const invalid = validationMessage(jevObserveSchema as unknown as Record<string, unknown>, value);
  if (invalid) throw new Error(`Invalid Jev observation: ${invalid}`);
  if (value.triggerTurn === true && value.delivery === undefined) throw new Error("triggerTurn requires an explicit observation delivery mode");
}

/** Select first, then redact and bound. Never serialize the raw host event. */
function project(event: JevHostEventName, raw: unknown, options: JevObserve): Pick<JevHostEvent, "payload" | "truncated"> {
  const p = object(raw) ? raw : {};
  const selected: Record<string, JevJson> = {};
  const maxChars = options.maxChars ?? 4096;
  let remaining = maxChars;
  let truncated = false;
  const take = (value: unknown): string => {
    if (typeof value !== "string") return "";
    const text = value.slice(0, remaining);
    truncated ||= text.length < value.length;
    remaining -= text.length;
    return text;
  };
  const text = (content: unknown): string => {
    if (typeof content === "string") return take(content);
    if (!Array.isArray(content)) return "";
    truncated ||= content.length > 32;
    return content.slice(0, 32).filter(b => object(b) && b.type === "text").map(b => take(b.text)).join("\n");
  };
  if (Number.isSafeInteger(p.turnIndex) && (p.turnIndex as number) >= 0) selected.turnIndex = p.turnIndex as number;
  if (typeof p.toolName === "string") selected.toolName = p.toolName.slice(0, 128);
  if (typeof p.isError === "boolean") selected.isError = p.isError;
  if (event === "input" && options.include?.includes("inputText")) selected.inputText = take(p.text);
  if (event === "turn_end") {
    if (object(p.message) && p.message.role === "assistant") {
      if (options.include?.includes("assistantText")) selected.assistantText = text(p.message.content);
      if (["stop", "length", "toolUse", "error", "aborted"].includes(p.message.stopReason as string)) selected.stopReason = p.message.stopReason as string;
    }
    if (Array.isArray(p.toolResults)) {
      selected.toolResultCount = p.toolResults.length;
      if (options.include?.includes("toolResults")) {
        truncated ||= p.toolResults.length > 16;
        selected.toolResults = p.toolResults.slice(0, 16).filter(object).map(result => ({
          toolName: typeof result.toolName === "string" ? result.toolName.slice(0, 128) : "unknown",
          isError: result.isError === true,
          text: text(result.content),
        }));
      }
    }
  }
  if (event === "tool_error" && options.include?.includes("toolResults")) selected.text = text(p.content);
  const prepared = prepareFabricActorHostPayload(selected, maxChars).payload as JevJson;
  return { payload: prepared, truncated: truncated || typeof prepared === "string" || JSON.stringify(selected).length > maxChars };
}

/** Session-local event source; no polling, transcript reads, or background model calls. */
export class JevObservationHost {
  readonly #subscriptions = new Set<JevSubscription>();
  readonly #seen = new WeakSet<object>();
  readonly #epoch = randomUUID();
  #sequence = 0;
  #revision = 0;
  #feedback = false;
  #closed = false;
  #halted = false;
  #signal: AbortSignal | undefined;
  readonly #abort = () => { this.halt(); };
  constructor(readonly sessionId: string, readonly deliver: (advice: JevAdvice) => void, readonly now: () => number = Date.now) {}
  get halted(): boolean { return this.#halted; }
  get size(): number { return this.#subscriptions.size; }
  get revision(): number { return this.#revision; }
  subscribe(options: JevObserve, run: { id: string; name: string }, controller: AbortController): JevSubscription {
    checkObserve(options);
    if (this.#closed || this.#halted) throw new Error("Jev observation host is closed or interrupted");
    controller.signal.throwIfAborted();
    const subscription = new JevSubscription(this, structuredClone(options), run, controller, () => this.#subscriptions.delete(subscription));
    this.#subscriptions.add(subscription);
    return subscription;
  }
  observe(event: string, payload: unknown, context: { sessionId: string; signal?: AbortSignal | undefined }): number {
    if (this.#closed) return 0;
    if (context.sessionId !== this.sessionId || event === "session_shutdown" || event === "session_tree") {
      this.halt();
      return 0;
    }
    if (event === "turn_end" && object(payload) && object(payload.message) && payload.message.stopReason === "aborted") {
      this.halt();
      return 0;
    }
    const selected = (JEV_HOST_EVENTS as readonly string[]).includes(event);
    if (selected && object(payload)) {
      if (this.#seen.has(payload)) return 0;
      this.#seen.add(payload);
    }
    if (event === "input" && (!object(payload) || payload.source !== "extension")) {
      this.#halted = false;
      this.#feedback = false;
      this.#revision++;
      for (const subscription of this.#subscriptions) subscription.discard();
    } else if (event === "turn_end" || event === "session_compact") {
      this.#revision++;
    }
    if (context.signal && context.signal !== this.#signal) {
      this.#signal?.removeEventListener("abort", this.#abort);
      this.#signal = context.signal;
      this.#signal.addEventListener("abort", this.#abort, { once: true });
    }
    if (context.signal?.aborted) this.halt();
    if (this.#halted || !selected) return 0;
    let count = 0;
    const sequence = ++this.#sequence;
    for (const subscription of this.#subscriptions) {
      if (!subscription.options.events.includes(event as JevHostEventName)) continue;
      subscription.push({
        id: `${this.#epoch}:${sequence}`, sequence, event: event as JevHostEventName,
        source: "main", sessionId: this.sessionId, revision: this.#revision, at: this.now(),
        ...project(event as JevHostEventName, payload, subscription.options),
      });
      count++;
    }
    return count;
  }
  send(advice: JevAdvice): JevAdviceResult {
    if (this.#closed || this.#halted) return { delivered: false, reason: "stale" };
    if (this.#feedback) return { delivered: false, reason: "feedback" };
    // One attempt across all observers per external input. Automatic continuations
    // cannot re-arm advice, even if delivery throws after producing an effect.
    this.#feedback = true;
    try { this.deliver(advice); return { delivered: true }; }
    catch { return { delivered: false, reason: "delivery_failed" }; }
  }
  halt(): number {
    this.#halted = true;
    this.#revision++;
    const subscriptions = [...this.#subscriptions];
    for (const subscription of subscriptions) subscription.cancel();
    return subscriptions.length;
  }
  close(): void {
    this.#closed = true;
    this.halt();
    this.#signal?.removeEventListener("abort", this.#abort);
    this.#signal = undefined;
  }
}

export class JevSubscription {
  readonly stats: JevObservationStats;
  readonly #queue: JevHostEvent[] = [];
  #pending: { resolve: (event: JevHostEvent) => void; reject: (error: Error) => void } | undefined;
  #current: Pick<JevHostEvent, "id" | "revision" | "at"> | undefined;
  #advised = false;
  #attempts = 0;
  #closed = false;
  readonly #abort = () => this.close();
  constructor(readonly host: JevObservationHost, readonly options: JevObserve, readonly run: { id: string; name: string }, readonly controller: AbortController, readonly dispose: () => void) {
    this.stats = { events: [...options.events], received: 0, consumed: 0, dropped: 0, queued: 0, adviceDelivered: 0, adviceSuppressed: 0 };
    controller.signal.addEventListener("abort", this.#abort, { once: true });
  }
  #consume(event: JevHostEvent): JevHostEvent {
    this.#current = { id: event.id, revision: event.revision, at: event.at };
    this.#advised = false;
    this.stats.consumed++;
    this.stats.queued = this.#queue.length;
    return event;
  }
  push(event: JevHostEvent): void {
    if (this.#closed) return;
    this.stats.received++;
    if (this.#pending) {
      const pending = this.#pending;
      this.#pending = undefined;
      pending.resolve(this.#consume(event));
      return;
    }
    if (this.#queue.length >= (this.options.queueSize ?? 8)) { this.#queue.shift(); this.stats.dropped++; }
    this.#queue.push(event);
    this.stats.queued = this.#queue.length;
  }
  async next(): Promise<JevHostEvent> {
    if (this.#closed) throw new Error("Jev observation closed");
    if (this.#pending) throw new Error("Only one program.nextEvent() may be pending");
    this.#current = undefined;
    while (this.#queue.length) {
      const event = this.#queue.shift()!;
      this.stats.queued = this.#queue.length;
      if (this.host.now() - event.at > (this.options.maxEventAgeMs ?? 30_000)) { this.stats.dropped++; continue; }
      return this.#consume(event);
    }
    return new Promise((resolve, reject) => { this.#pending = { resolve, reject }; });
  }
  advise(eventId: string, message: string): JevAdviceResult {
    const suppress = (reason: NonNullable<JevAdviceResult["reason"]>): JevAdviceResult => { this.stats.adviceSuppressed++; return { delivered: false, reason }; };
    if (!this.options.delivery) return suppress("disabled");
    const current = this.#current;
    if (this.#closed || !current || current.id !== eventId || current.revision !== this.host.revision || this.host.now() - current.at > (this.options.maxEventAgeMs ?? 30_000)) return suppress("stale");
    if (this.#advised) return suppress("duplicate");
    if (this.#attempts >= (this.options.maxAdvice ?? 4)) return suppress("budget");
    this.#advised = true;
    const result = this.host.send({ runId: this.run.id, name: this.run.name, eventId, message, delivery: this.options.delivery, triggerTurn: this.options.triggerTurn ?? false });
    if (result.reason !== "feedback" && result.reason !== "stale") this.#attempts++;
    if (result.delivered) this.stats.adviceDelivered++;
    else this.stats.adviceSuppressed++;
    return result;
  }
  discard(): void {
    this.stats.dropped += this.#queue.length;
    this.#queue.length = 0;
    this.stats.queued = 0;
    this.#current = undefined;
  }
  cancel(): void { this.controller.abort(new Error("Jev observer interrupted")); this.close(); }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.controller.signal.removeEventListener("abort", this.#abort);
    this.discard();
    this.#pending?.reject(new Error("Jev observation closed"));
    this.#pending = undefined;
    this.dispose();
  }
}
