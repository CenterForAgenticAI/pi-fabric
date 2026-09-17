import path from "node:path";
import { pathToFileURL } from "node:url";
import { runAbortable } from "../async-settlement.js";
import { validationMessage } from "../core/action-arguments.js";
import type { FabricComponentDefinition } from "../components/types.js";
import type { FabricActionDescriptor, FabricInvocationContext, FabricProvider } from "../protocol.js";

export interface BrowserHarnessConfig {
  /** Trusted module path to browser-harness-js/skills/cdp/sdk/session.ts. */
  modulePath: string;
  /** Explicit debug endpoint; never auto-discover or auto-approve a personal browser. */
  wsUrl: string;
  allowedMethods: string[];
  callTimeoutMs?: number;
}
export interface BrowserHarnessSession {
  connect(options: { wsUrl: string; autoAllow: false; timeoutMs: number }): Promise<void>;
  isConnected(): boolean;
  _call(method: string, params: unknown, options?: { sessionId?: string }): Promise<unknown>;
  close(): void;
}
export type BrowserHarnessSessionLoader = (modulePath: string) => Promise<BrowserHarnessSession>;
const loadSession: BrowserHarnessSessionLoader = async modulePath => {
  const module = await import(pathToFileURL(modulePath).href);
  if (typeof module.Session !== "function") throw new Error("Browser Harness module must export Session");
  return new module.Session() as BrowserHarnessSession;
};
export class BrowserHarnessProvider implements FabricProvider {
  readonly name = "browser";
  readonly description = "Optional persistent Browser Harness CDP connection with host-configured method grants";
  readonly #descriptors: FabricActionDescriptor[];
  #session: Promise<BrowserHarnessSession> | undefined;
  #closed = false;
  #pending = new Set<Promise<unknown>>();
  readonly #timeoutMs: number;
  constructor(readonly config: BrowserHarnessConfig, private readonly loader: BrowserHarnessSessionLoader = loadSession) {
    if (!config || typeof config.modulePath !== "string" || !path.isAbsolute(config.modulePath)) throw new Error("Browser Harness modulePath must be an absolute trusted path");
    const url = new URL(config.wsUrl);
    if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password) throw new Error("Browser Harness needs an explicit ws/wss debugging URL without credentials");
    if (!Array.isArray(config.allowedMethods) || config.allowedMethods.length < 1 || config.allowedMethods.length > 128 ||
        !config.allowedMethods.every(m => typeof m === "string" && /^[A-Z][A-Za-z0-9]+\.[a-z][A-Za-z0-9]+$/.test(m)))
      throw new Error("Browser Harness needs 1–128 exact allowedMethods");
    this.#timeoutMs = Math.max(100, Math.min(60_000, Number.isFinite(config.callTimeoutMs) ? config.callTimeoutMs! : 10_000));
    this.#descriptors = [
      { name:"connect", description:"Connect to the host-configured Browser Harness debugging endpoint. Does not auto-discover browsers or dismiss permission prompts.", inputSchema:{type:"object",properties:{},additionalProperties:false},risk:"execute" },
      { name:"cdp",description:"Call one host-allowlisted CDP method. Always treated as execute: Runtime.evaluate can mutate the page. Use explicit sessionId for page-scoped methods; no shared active-tab pointer. Cancellation cannot undo a sent CDP command.",risk:"execute",inputSchema:{
        type:"object",properties:{method:{type:"string",enum:[...new Set(config.allowedMethods)]},params:{type:"object"},sessionId:{type:"string",minLength:1,maxLength:256}},required:["method"],additionalProperties:false,
      } },
    ];
  }
  async list() { return this.#descriptors; }
  async describe(name: string) { return this.#descriptors.find(d => d.name === name); }
  async invoke(name: string, args: Record<string, unknown>, context: FabricInvocationContext): Promise<unknown> {
    if (this.#closed) throw new Error("Browser Harness provider closed");
    const descriptor = await this.describe(name);
    if (!descriptor) throw new Error("Unknown Browser Harness action");
    const invalid = validationMessage(descriptor.inputSchema,args);
    if (invalid) throw new Error(`Invalid browser.${name} arguments: ${invalid}`);
    context.signal?.throwIfAborted();
    if (this.#pending.size >= 16) throw new Error("Browser Harness outstanding call limit reached");
    const signal = AbortSignal.any([...(context.signal ? [context.signal] : []),AbortSignal.timeout(this.#timeoutMs)]);
    if (name === "connect") {
      this.#session ??= this.loader(this.config.modulePath).then(session => {
        if (this.#closed) { session.close(); throw new Error("Browser Harness provider closed"); }
        return session;
      }).catch(error => { this.#session = undefined; throw error; });
      const session = await runAbortable(signal, () => this.#session!);
      const connecting = session.connect({wsUrl:this.config.wsUrl,autoAllow:false,timeoutMs:this.#timeoutMs}).then(() => {
        // The SDK has no AbortSignal for connect. A late successful connection
        // must not survive a cancelled call or component teardown.
        if (this.#closed || signal.aborted) session.close();
      });
      await runAbortable(signal, () => connecting);
      if (this.#closed || signal.aborted) { session.close(); signal.throwIfAborted(); throw new Error("Browser Harness provider closed"); }
      return { connected:session.isConnected() };
    }
    if (!this.#session) throw new Error("Call browser.connect before browser.cdp");
    const session = await runAbortable(signal, () => this.#session!);
    if (this.#closed || !session.isConnected()) throw new Error("Browser Harness disconnected; explicitly reconnect before retrying");
    const method = args.method as string;
    if (!/^(Browser|Target|Chrome)\./.test(method) && typeof args.sessionId !== "string") throw new Error("Page-scoped CDP calls require an explicit sessionId");
    if (this.#pending.size >= 16) throw new Error("Browser Harness outstanding call limit reached");
    const task = session._call(method,args.params ?? {},typeof args.sessionId === "string" ? {sessionId:args.sessionId} : undefined);
    this.#pending.add(task);
    void task.then(() => this.#pending.delete(task),() => this.#pending.delete(task));
    return runAbortable(signal, () => task);
  }
  async close(): Promise<void> {
    this.#closed = true;
    const session = await this.#session?.catch(() => undefined);
    session?.close();
  }
}
export const browserHarnessComponent: FabricComponentDefinition<BrowserHarnessConfig> = {
  name:"browser-harness",
  description:"Optional Browser Harness JS connector; explicit debugging endpoint and exact CDP method grants",
  provides:["browser"], guarantee:"managed",
  activate(context, config) {
    const provider = new BrowserHarnessProvider({ ...config, modulePath:path.resolve(context.invocation.cwd,config.modulePath) });
    try { context.provide(provider); } catch (error) { void provider.close(); throw error; }
  },
};
