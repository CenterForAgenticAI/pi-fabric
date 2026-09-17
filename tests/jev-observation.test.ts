import { afterEach, describe, expect, it, vi } from "vitest";
import { JevObservationHost, checkObserve } from "../src/jev/observation.js";
import type { JevObserve, JevRequest } from "../src/jev/types.js";
import type { JevProvider } from "../src/providers/jev-provider.js";
import { callProgram, jevContext, launch, setupJev } from "./jev-test-helpers.js";

const context = { sessionId: "jev-test-session" };
const turn = (text = "Completed implementation without running tests") => ({
  turnIndex: 1,
  message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }, { type: "thinking", thinking: "private thought" }, { type: "image", data: "private image", mimeType: "image/png" }, { type: "toolCall", name: "bash", arguments: { secret: "private argument" } }] },
  toolResults: [{ toolName: "fixture", isError: true, content: [{ type: "text", text: "failed assertion" }], details: { secret: "private detail" } }],
  headers: { Authorization: "private header" },
});
const hosts: JevObservationHost[] = [];
const providers: JevProvider[] = [];
const makeHost = (deliver = vi.fn(), now = () => Date.now()) => {
  const host = new JevObservationHost(context.sessionId, deliver, now);
  hosts.push(host);
  return { host, deliver };
};
const subscribe = (host: JevObservationHost, options: Partial<JevObserve> = {}) => {
  const controller = new AbortController();
  return { controller, sub: host.subscribe({ events: ["turn_end"], ...options }, { id: "fixture", name: "advisor" }, controller) };
};
afterEach(async () => {
  hosts.splice(0).forEach(host => host.close());
  await Promise.all(providers.splice(0).map(provider => provider.close()));
});

describe("Jev event inbox and deterministic delivery policy", () => {
  it("defaults to metadata only and never traverses unrelated host data", async () => {
    const { host } = makeHost(); const { sub } = subscribe(host);
    const raw = { ...turn(), get unselectedSecret() { throw new Error("must not read"); } };
    expect(host.observe("turn_end", raw, context)).toBe(1);
    const event = await sub.next();
    expect(event).toMatchObject({ source: "main", sessionId: context.sessionId, event: "turn_end", payload: { turnIndex: 1, stopReason: "stop", toolResultCount: 1 } });
    expect(JSON.stringify(event)).not.toContain("private");
    expect(JSON.stringify(event)).not.toContain("failed assertion");
    expect(host.observe("turn_end", raw, context)).toBe(0);
  });

  it("shares only selected bounded text, redacts common secrets, and excludes thinking, media, arguments and details", async () => {
    const { host } = makeHost();
    const { sub } = subscribe(host, { include: ["assistantText", "toolResults"], maxChars: 512 });
    host.observe("turn_end", turn("Authorization: Bearer secret-value\nVisible response"), context);
    const event = await sub.next();
    const encoded = JSON.stringify(event.payload);
    expect(encoded).toContain("Visible response");
    expect(encoded).toContain("failed assertion");
    expect(encoded).toContain("redacted");
    expect(encoded).not.toMatch(/private|secret-value/);
    host.observe("turn_end", turn("x".repeat(100000)), context);
    const bounded = await sub.next();
    expect(bounded.truncated).toBe(true);
    expect(JSON.stringify(bounded.payload).length).toBeLessThanOrEqual(1026);
  });

  it("supports opt-in input text without sharing run transcripts at settlement", async () => {
    const { host } = makeHost();
    const { sub } = subscribe(host, { events: ["input", "agent_end", "agent_settled", "tool_error"], include: ["inputText", "assistantText", "toolResults"] });
    host.observe("input", { source: "interactive", text: "Review the tests", images: [{ data: "secret image" }] }, context);
    expect((await sub.next()).payload).toEqual({ inputText: "Review the tests" });
    host.observe("agent_end", { messages: [turn().message] }, context);
    expect((await sub.next()).payload).toEqual({});
    host.observe("agent_settled", {}, context);
    expect((await sub.next()).payload).toEqual({});
    host.observe("tool_error", { toolName: "test", isError: true, content: [{ type: "text", text: "failed test" }], details: { secret: "no" } }, context);
    expect((await sub.next()).payload).toEqual({ toolName: "test", isError: true, text: "failed test" });
  });

  it("bounds the queue, expires old events, and permits only one pending consumer", async () => {
    let now = 0; const { host } = makeHost(vi.fn(), () => now);
    const { sub } = subscribe(host, { queueSize: 2, maxEventAgeMs: 100 });
    for (let i = 0; i < 3; i++) host.observe("turn_end", turn(String(i)), context);
    expect(sub.stats).toMatchObject({ received: 3, queued: 2, dropped: 1 });
    expect((await sub.next()).sequence).toBe(2);
    now = 101;
    const pending = sub.next();
    await expect(sub.next()).rejects.toThrow("Only one");
    host.observe("turn_end", turn("fresh"), context);
    expect((await pending).sequence).toBe(4);
    expect(sub.stats).toMatchObject({ queued: 0, dropped: 2, consumed: 2 });
  });

  it("does not deliver by default; rejects stale, duplicate and expired advice", async () => {
    let now = 0; const { host, deliver } = makeHost(vi.fn(), () => now);
    const { sub: passive } = subscribe(host);
    const { sub } = subscribe(host, { delivery: "steer", maxEventAgeMs: 100 });
    host.observe("turn_end", turn(), context);
    expect(passive.advise((await passive.next()).id, "check")).toEqual({ delivered: false, reason: "disabled" });
    const event = await sub.next();
    expect(sub.advise("not-current", "check").reason).toBe("stale");
    expect(sub.advise(event.id, "check")).toEqual({ delivered: true });
    expect(sub.advise(event.id, "again").reason).toBe("duplicate");
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ triggerTurn: false, delivery: "steer", eventId: event.id }));
    host.observe("turn_end", turn(), context);
    const old = await sub.next();
    now = 101;
    expect(sub.advise(old.id, "expired").reason).toBe("stale");
    host.observe("turn_end", turn(), context);
    const superseded = await sub.next();
    host.observe("turn_end", turn(), context);
    expect(sub.advise(superseded.id, "late").reason).toBe("stale");
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("prevents cross-observer feedback until real input, and enforces lifetime advice limits", async () => {
    const { host, deliver } = makeHost();
    const { sub: first } = subscribe(host, { delivery: "followUp", triggerTurn: true, maxAdvice: 1 });
    const { sub: second } = subscribe(host, { delivery: "steer", maxAdvice: 1 });
    host.observe("turn_end", turn(), context);
    expect(first.advise((await first.next()).id, "verify").delivered).toBe(true);
    expect(second.advise((await second.next()).id, "verify").reason).toBe("feedback");
    host.observe("input", { source: "extension", text: "continue" }, context);
    host.observe("turn_end", turn(), context);
    expect(second.advise((await second.next()).id, "verify").reason).toBe("feedback");
    host.observe("input", { source: "rpc", text: "new task" }, context);
    host.observe("turn_end", turn(), context);
    expect(first.advise((await first.next()).id, "verify").reason).toBe("budget");
    expect(second.advise((await second.next()).id, "verify").delivered).toBe(true);
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it("does not retry an ambiguous delivery failure", async () => {
    const deliver = vi.fn(() => { throw new Error("private delivery detail"); });
    const { host } = makeHost(deliver);
    const { sub } = subscribe(host, { delivery: "steer" });
    host.observe("turn_end", turn(), context);
    expect(sub.advise((await sub.next()).id, "check")).toEqual({ delivered: false, reason: "delivery_failed" });
    host.observe("turn_end", turn(), context);
    expect(sub.advise((await sub.next()).id, "check").reason).toBe("feedback");
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it.each(["session_tree", "session_shutdown", "foreign-session", "abort", "aborted-turn", "escape"])("cancels pending work on %s without resurrection", async (cause) => {
    const { host } = makeHost(); const main = new AbortController();
    host.observe("turn_start", {}, { ...context, signal: main.signal });
    const { sub, controller } = subscribe(host);
    const rejected = expect(sub.next()).rejects.toThrow("closed");
    if (cause === "aborted-turn") host.observe("turn_end", { message: { stopReason: "aborted" } }, context);
    else if (cause === "abort") main.abort();
    else if (cause === "escape") host.halt();
    else host.observe(cause === "foreign-session" ? "turn_end" : cause, {}, { sessionId: cause === "foreign-session" ? "other" : context.sessionId });
    await rejected;
    expect(controller.signal.aborted).toBe(true);
    expect(host.size).toBe(0);
    expect(host.observe("turn_end", turn(), context)).toBe(0);
    host.observe("input", { source: "interactive" }, context);
    expect(host.size).toBe(0);
  });

  it("validates closed event and content allowlists and bounds", () => {
    for (const bad of [{ events: ["context"] }, { events: ["turn_end"], include: ["thinking"] }, { events: ["turn_end"], queueSize: 33 }, { events: ["turn_end"], maxChars: 999999 }, { events: ["turn_end"], triggerTurn: true }, { events: ["turn_end"], from: "peer" }]) {
      expect(() => checkObserve(bad)).toThrow();
    }
  });
});

const observerCode = `const event = await program.nextEvent();
const result = await jev.evaluate({state:{turn:event.payload},questions:{drift:{type:"noul",instructions:"Does this turn claim completion without evidence that the tests ran?"}}});
const advice = result.answers.drift.noul >= 0.9 ? await program.advise({eventId:event.id,message:"Verify the relevant tests before claiming completion."}) : {delivered:false};
await program.emit({eventId:event.id, probability:result.answers.drift.noul, advice});
return {probability:result.answers.drift.noul,advice};`;
const fixture = (agent: "allow" | "deny" = "allow", wait?: Promise<void>) => {
  const { host, deliver } = makeHost();
  const requests: JevRequest[] = [];
  const fetcher = vi.fn(async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)) as JevRequest);
    await wait;
    return new Response(JSON.stringify({ model: "jev-latest", answers: { drift: { type: "noul", noul: 0.99 } }, usage: { input_tokens: 4, output_tokens: 2 } }));
  }) as unknown as typeof fetch;
  const { provider, registry } = setupJev({ approvals: { read: "allow", execute: "allow", network: "allow", agent } }, fetcher, undefined, host);
  providers.push(provider);
  const request = { ...launch(observerCode, { requires: ["jev.evaluate", "jev.advise"] }), observe: { events: ["turn_end"], include: ["assistantText"], delivery: "steer" } as JevObserve };
  return { provider, registry, host, deliver, request, requests };
};

describe("Jev observation through the real sandbox and action registry", () => {
  it("waits without polling, classifies an actual projected turn, and delivers attributed advice", async () => {
    const { provider, host, deliver, request, requests } = fixture();
    const started = await callProgram(provider, "spawn", request);
    expect(started.observation).toMatchObject({ consumed: 0, received: 0 });
    expect(requests).toHaveLength(0);
    host.observe("turn_end", turn(), context);
    const result = await provider.manager.wait(started.id);
    expect(result.state, result.error).toBe("completed");
    expect(result.result).toEqual({ probability: 0.99, advice: { delivered: true } });
    expect(result.observation).toMatchObject({ consumed: 1, adviceDelivered: 1, queued: 0 });
    expect(result.evaluations).toBe(1);
    expect(result.usage).toEqual({ input_tokens: 4, output_tokens: 2 });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(requests)).toContain("Completed implementation");
    expect(JSON.stringify(requests)).not.toMatch(/private|failed assertion/);
    expect(host.size).toBe(0);
  }, 15000);

  it("preserves agent approvals and explicit advice capability grants", async () => {
    const { provider, host, deliver, request } = fixture("deny");
    const run = await callProgram(provider, "spawn", request);
    host.observe("turn_end", turn(), context);
    const result = await provider.manager.wait(run.id);
    expect(result.state).toBe("failed"); expect(result.error).toContain("denied");
    expect(deliver).not.toHaveBeenCalled();
    request.program.requires = ["jev.evaluate"];
    const ungranted = await callProgram(provider, "spawn", request);
    host.observe("turn_end", turn(), context);
    expect((await provider.manager.wait(ungranted.id)).error).toContain("Capability not granted");
  });

  it.each(["turn_start", "turn_end"])("checks completed-turn freshness when %s arrives during inference", async (next) => {
    let resume!: () => void;
    const pending = new Promise<void>(resolve => { resume = resolve; });
    const { provider, host, deliver, request, requests } = fixture("allow", pending);
    const run = await callProgram(provider, "spawn", request);
    host.observe("turn_end", turn(), context);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    host.observe(next, {}, context);
    resume();
    const result = await provider.manager.wait(run.id);
    expect(result.result).toEqual({ probability: 0.99, advice: next === "turn_end" ? { delivered: false, reason: "stale" } : { delivered: true } });
    expect(deliver).toHaveBeenCalledTimes(next === "turn_end" ? 0 : 1);
  });

  it("rejects foreground deadlocks and unavailable/wrong-session subscriptions before launch", async () => {
    const { provider, request } = fixture();
    await expect(callProgram(provider, "run", request)).rejects.toThrow("requires jev.spawn");
    const plain = setupJev().provider; providers.push(plain);
    await expect(callProgram(plain, "spawn", request)).rejects.toThrow("unavailable");
    const wrong = jevContext(); wrong.extensionContext = { ...wrong.extensionContext, sessionManager: { getSessionId: () => "other" } } as typeof wrong.extensionContext;
    await expect(callProgram(provider, "spawn", request, wrong)).rejects.toThrow("owning Main");
    expect(provider.manager.list()).toHaveLength(0);
  });

  it("does not resurrect a launch prepared across an interrupt and new input", async () => {
    const { provider, registry, host, request } = fixture();
    let resume!: () => void;
    const gate = new Promise<void>(resolve => { resume = resolve; });
    const original = registry.guestTypeSources.bind(registry);
    const pendingSources = vi.spyOn(registry, "guestTypeSources").mockImplementationOnce(async (...args) => {
      await gate;
      return original(...args);
    });
    const started = callProgram(provider, "spawn", request);
    const rejected = expect(started).rejects.toThrow("lifecycle changed");
    await vi.waitFor(() => expect(pendingSources).toHaveBeenCalled());
    host.halt();
    host.observe("input", {source:"interactive"}, context);
    resume();
    await rejected;
    expect(host.size).toBe(0);
    expect(provider.manager.list()).toHaveLength(0);
    pendingSources.mockRestore();
  });

  it("requires read approval before subscribing and cannot claim another run's advice identity", async () => {
    const { provider, host, request } = fixture();
    provider.manager.options.config.approvals.read = "deny";
    await expect(callProgram(provider, "spawn", request)).rejects.toThrow("read policy");
    expect(host.size).toBe(0);
    expect(provider.manager.list()).toHaveLength(0);
    provider.manager.options.config.approvals.read = "allow";
    const invalid = await callProgram(provider, "run", launch("return await tools.call({ref:'jev.advise',args:{id:'someone-else',eventId:'fake',message:'no'}});", {requires:["jev.advise"]}));
    expect(invalid.state).toBe("failed"); expect(invalid.error).toContain("own run");
    const missing = await callProgram(provider, "run", launch("return await program.nextEvent();"));
    expect(missing.error).toContain("requires observe");
  });

  it("aborts an in-flight judgment on Main cancellation and prevents late advice", async () => {
    let resume!: () => void;
    const pending = new Promise<void>(resolve => { resume = resolve; });
    const { provider, host, deliver, request, requests } = fixture("allow", pending);
    const main = new AbortController();
    host.observe("turn_start", {}, {...context, signal:main.signal});
    const run = await callProgram(provider, "spawn", request);
    host.observe("turn_end", turn(), {...context, signal:main.signal});
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    main.abort();
    const result = await provider.manager.wait(run.id);
    expect(result.state).toBe("cancelled");
    expect(host.size).toBe(0);
    resume();
    expect(deliver).not.toHaveBeenCalled();
  });

  it("stops waiting observers, retains terminal metrics, and does not turn wait cancellation into stop", async () => {
    const { provider, host } = fixture();
    const caller = new AbortController();
    const run = await callProgram(provider, "spawn", { ...launch("while(true) await program.nextEvent();"), observe: { events: ["turn_end"] } }, jevContext(caller.signal));
    caller.abort();
    await expect(provider.manager.wait(run.id, caller.signal)).rejects.toThrow();
    expect(provider.manager.status(run.id).state).toBe("running");
    const stopped = await provider.manager.stop(run.id);
    expect(stopped.state).toBe("cancelled"); expect(host.size).toBe(0);
    expect(stopped.observation?.queued).toBe(0);
    const deadline = await callProgram(provider, "spawn", { ...launch("await program.nextEvent(); return null;", { limits: { timeoutMs: 50 } }), observe: { events: ["turn_end"] } });
    expect((await provider.manager.wait(deadline.id)).state).toBe("timed_out");
    expect(host.size).toBe(0);
  });
});
