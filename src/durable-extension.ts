// pi-fabric/durable-extension: fabric_exec as a pi-durable registry extension.
//
// A host that runs its own pi-durable Harness (no Pi session, no ExtensionAPI)
// installs createFabricExtension() next to its tool extensions. Programs run in
// the QuickJS kernel. Inside a program `tools.<name>` reaches only the tools the
// conversation lets other tools call (`Agent.callable`), narrowed further by
// `options.tools`; each call goes through `ToolExecutionApi.executeTool`, so the
// host's ToolTask hooks (tenant guards, audits) see it as a nested call. Every
// Fabric provider (memory, agents, mcp, pi.*, ...) is refused unless the host
// grants it in `options.providers`. Nothing here touches files, a shell, the
// Pi UI, compaction, prewalk or topology. See docs/durable-extension.md.
//
// The module imports pi-durable and chord for types only: the extension is a
// plain object, so it does not pin a pi-durable runtime version, and its static
// graph holds no Node-only module (scripts/assert-build-artifacts.mjs checks).
import type { Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord";
import type {
  ConversationId,
  Extension,
  JsonObject,
  NestedToolExecutionResult,
  PromptSection,
  ToolExecutionApi,
  ToolExecutionResult,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { describeFabricActionDeclaration } from "./runtime/dynamic-guest-types.js";
import type { FabricHostCall, FabricKernelRuntime, FabricSandboxOptions, FabricSandboxResult } from "./runtime/kernel.js";

/** One granted action of a host provider. Arguments are the program's object, copied to plain JSON. */
export type FabricDurableAction = (
  args: JsonObject,
  call: { readonly api: ToolExecutionApi; readonly context: Context },
) => unknown | Promise<unknown>;

/** A provider the host grants to programs, reachable as `<name>.<action>(args)` or `fabric.tools.call({ ref: "<name>.<action>", args })`. */
export interface FabricDurableProvider {
  readonly description?: string;
  readonly actions: Readonly<Record<string, FabricDurableAction>>;
}

/** Where an internal failure happened, for `onError`. Holds no program source or arguments. */
export interface FabricDurableErrorInfo {
  readonly conversationId: ConversationId;
  readonly callId: string;
}

export interface FabricExtensionOptions {
  /** Registry extension name; pi-durable reports section errors under it. Default `pi-fabric`. */
  readonly name?: string;
  /** Tool name. Default `fabric_exec`. */
  readonly toolName?: string;
  /**
   * Host tools programs may call, by name, out of the conversation's callable tools (`Agent.callable`).
   * Omitted: every callable tool. An empty list grants none. Never widens what the conversation allows.
   */
  readonly tools?: readonly string[];
  /** Fabric providers granted to programs. Omitted: none; every provider ref is refused. */
  readonly providers?: Readonly<Record<string, FabricDurableProvider>>;
  /** Whole-program deadline in milliseconds, nested calls included. Default 30 000. */
  readonly timeoutMs?: number;
  /** QuickJS heap limit in bytes. Default 64 MiB (67 108 864). */
  readonly memoryLimitBytes?: number;
  /** Characters of `print()`/`console.*` output kept per program; more is cut with a notice. Default 20 000. */
  readonly maxLogChars?: number;
  /** Characters of the whole result the model sees; more is cut with a notice. Default 40 000. */
  readonly maxResultChars?: number;
  /** Largest JSON argument object, in UTF-8 bytes, a program may pass to one nested tool call or provider action. Default 262 144. */
  readonly maxArgumentBytes?: number;
  /** Token budget (4 characters a token) for the tool declarations in the prompt section. Default 3 000. */
  readonly sectionTokenBudget?: number;
  /**
   * A precompiled QuickJS wasm module for the default kernel, for hosts that cannot compile wasm from bytes
   * (Cloudflare Workers). It must be the `@jitl/quickjs-singlefile-mjs-release-sync` build this package depends on.
   * Ignored when `runtime` is set. Default: the module compiles the wasm it bundles.
   */
  readonly quickJsWasmModule?: WebAssembly.Module;
  /** Kernel override, for example a sandbox in another isolate. Default: the in-process QuickJS kernel. */
  readonly runtime?: FabricKernelRuntime;
  /**
   * Receives internal failures: the kernel failing to load, a bug in this extension, a granted provider action
   * throwing anything but `FabricDurableRefusal`. The model sees only a fixed error either way. Its own throw is
   * dropped. Default: none (pi-durable gives a tool no report channel).
   */
  readonly onError?: (error: unknown, info: FabricDurableErrorInfo) => void;
}

/** The defaults `createFabricExtension` applies, for hosts that want to show or derive from them. */
export const FABRIC_DURABLE_DEFAULTS = Object.freeze({
  name: "pi-fabric",
  toolName: "fabric_exec",
  timeoutMs: 30_000,
  memoryLimitBytes: 64 * 1024 * 1024,
  maxLogChars: 20_000,
  maxResultChars: 40_000,
  maxArgumentBytes: 256 * 1024,
  sectionTokenBudget: 3_000,
});

const PROVIDER_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const ACTION_NAME = /^[A-Za-z_$][\w$]{0,127}$/;
const MAX_PENDING_TIMERS = 64;
const DEFAULT_SEARCH_LIMIT = 8;
const MAX_LISTED_CALLS = 20;
const CHARS_PER_TOKEN = 4;
const TEXT_OUTPUT_SCHEMA = { type: "string" } as const;

/**
 * Refusal raised to the program; its message reaches the program as an Error. A granted provider action may throw
 * it to show the program a message; any other error becomes the fixed `Fabric action <ref> failed`.
 */
export class FabricDurableRefusal extends Error {
  override readonly name = "FabricDurableRefusal";
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

const positive = (value: number | undefined, fallback: number, label: string): number => {
  const chosen = value ?? fallback;
  if (!Number.isSafeInteger(chosen) || chosen < 1) throw new Error(`createFabricExtension: ${label} must be a positive integer`);
  return chosen;
};

let sharedKernel: Promise<FabricKernelRuntime> | undefined;
const loadKernel = (wasmModule: WebAssembly.Module | undefined): Promise<FabricKernelRuntime> => {
  const load = () => import("./runtime/quickjs-runtime.js").then(({ QuickJsRuntime }) => new QuickJsRuntime({ ...(wasmModule ? { wasmModule } : {}) }));
  if (wasmModule !== undefined) return load();
  // A failed load is not cached: the next call retries.
  sharedKernel ??= load().catch((error: unknown) => {
    sharedKernel = undefined;
    throw error;
  });
  return sharedKernel;
};

/** The text of a schema-less tool's collapsed output: a string, or the text items of an array. */
const textOf = (value: JsonValue | undefined): string => {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.flatMap((item) => isObject(item) && item.type === "text" && typeof item.text === "string" ? [item.text] : []).join("\n");
};

/** What a program gets for a nested call, as pi-durable's codemode does. */
const outcomeOf = (name: string, structured: boolean, result: NestedToolExecutionResult): { ok: true; value: unknown } | { ok: false; message: string } => {
  const value = structured ? result.structuredOutput : textOf(result.structuredOutput);
  if (!result.isError || (structured && value !== undefined)) return { ok: true, value: value ?? null };
  const message = structured ? "" : value as string;
  const diagnostics = result.diagnostics.filter((item) => item.severity === "error").map((item) => item.message).join("\n");
  return { ok: false, message: message || diagnostics || `Tool ${name} failed` };
};

const words = (text: string): string[] => text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 1);

/** Rank tools by query words in their name (weight 3) and description (weight 1). */
const searchCatalog = (tools: readonly ToolRegistration[], query: string, limit: number) => {
  const terms = words(query);
  return tools
    .map((tool, index) => {
      const name = new Set(words(tool.name));
      const description = new Set(words(tool.description));
      const score = terms.reduce((sum, term) => sum + (name.has(term) ? 3 : 0) + (description.has(term) ? 1 : 0), 0);
      return { tool, index, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map(({ tool }) => ({ name: tool.name, description: tool.description }));
};

const schemaOf = (value: unknown): Record<string, unknown> => isObject(value) ? value : {};

/** The TypeScript declaration of one tool as programs call it. */
export const fabricToolDeclaration = (tool: Pick<ToolRegistration, "name" | "parameters" | "structuredOutputSchema">): string =>
  describeFabricActionDeclaration(tool.name, schemaOf(tool.parameters), schemaOf(tool.structuredOutputSchema ?? TEXT_OUTPUT_SCHEMA));

const toolEntry = (tool: ToolRegistration): string =>
  `### \`${tool.name}\`\n${tool.description.trim()}\n\`\`\`ts\ndeclare const tools: { ${fabricToolDeclaration(tool)} };\n\`\`\``;

/** Cheapest declarations first, until the budget is spent; returns the entries shown and whether any were cut. */
const selectEntries = (tools: readonly ToolRegistration[], budgetTokens: number) => {
  const entries = tools.map((tool, index) => {
    const text = toolEntry(tool);
    return { index, text, cost: Math.ceil(text.length / CHARS_PER_TOKEN) };
  });
  let remaining = budgetTokens;
  const shown = new Set<number>();
  for (const entry of [...entries].sort((a, b) => a.cost - b.cost || a.index - b.index)) {
    if (entry.cost > remaining) break;
    remaining -= entry.cost;
    shown.add(entry.index);
  }
  return { shown: entries.filter((entry) => shown.has(entry.index)).map((entry) => entry.text), cut: shown.size < entries.length };
};

interface CallRecord {
  readonly name: string;
  ok?: boolean;
}

const describeCalls = (calls: readonly CallRecord[]): string => {
  if (calls.length === 0) return "No nested calls were made.";
  const listed = calls.slice(0, MAX_LISTED_CALLS).map((call) => `${call.name} (${call.ok === undefined ? "unfinished" : call.ok ? "ok" : "failed"})`);
  const more = calls.length > MAX_LISTED_CALLS ? `, and ${calls.length - MAX_LISTED_CALLS} more` : "";
  return `Nested calls made before the error (they are not undone): ${listed.join(", ")}${more}.`;
};

const cut = (text: string, max: number, what: string): string =>
  text.length <= max ? text : `${text.slice(0, max)}\n[${what} truncated: ${max} of ${text.length} characters shown]`;

/** The fabric_exec tool and its prompt section, as one pi-durable extension. */
export function createFabricExtension(options: FabricExtensionOptions = {}): Extension {
  const d = FABRIC_DURABLE_DEFAULTS;
  const name = options.name ?? d.name;
  const toolName = options.toolName ?? d.toolName;
  const timeoutMs = positive(options.timeoutMs, d.timeoutMs, "timeoutMs");
  const memoryLimitBytes = positive(options.memoryLimitBytes, d.memoryLimitBytes, "memoryLimitBytes");
  const maxLogChars = positive(options.maxLogChars, d.maxLogChars, "maxLogChars");
  const maxResultChars = positive(options.maxResultChars, d.maxResultChars, "maxResultChars");
  const maxArgumentBytes = positive(options.maxArgumentBytes, d.maxArgumentBytes, "maxArgumentBytes");
  const sectionTokenBudget = positive(options.sectionTokenBudget, d.sectionTokenBudget, "sectionTokenBudget");
  const toolAllowlist = options.tools === undefined ? undefined : new Set(options.tools);
  const providers = new Map<string, FabricDurableProvider>();
  for (const [provider, granted] of Object.entries(options.providers ?? {})) {
    if (!PROVIDER_NAME.test(provider)) throw new Error(`Invalid Fabric provider name: ${provider}`);
    providers.set(provider, granted);
  }

  const report = (error: unknown, info: FabricDurableErrorInfo): void => {
    try {
      options.onError?.(error, info);
    } catch {
      // A throwing onError must not change the tool call.
    }
  };

  /** The host's tools a program may call: callable in this conversation, granted, never fabric_exec itself. */
  const grantedTools = (callable: readonly ToolRegistration[]): ToolRegistration[] =>
    callable.filter((tool) => tool.name !== toolName && (toolAllowlist === undefined || toolAllowlist.has(tool.name)));

  /** Copy a program value into plain JSON within the argument cap: no prototypes, getters or cycles cross into the host. */
  const copyArguments = (value: unknown, target: string): JsonObject => {
    if (value === undefined) value = {};
    if (!isObject(value)) throw new FabricDurableRefusal(`${target} takes one argument object`);
    const json = JSON.stringify(value);
    if (utf8Bytes(json) > maxArgumentBytes) {
      throw new FabricDurableRefusal(`${target} arguments exceed ${maxArgumentBytes} bytes`);
    }
    return JSON.parse(json) as JsonObject;
  };

  const hostCall = (api: ToolExecutionApi, context: Context, calls: CallRecord[]): FabricHostCall => {
    const info = { conversationId: api.conversationId, callId: api.callId };
    // Per program: the catalog is read from this call's own conversation and never shared.
    let catalog: Promise<ToolRegistration[]> | undefined;
    const tools = () => catalog ??= api.agent(context).then((agent) => grantedTools(agent.callable));
    const granted = async (toolNameArg: unknown): Promise<ToolRegistration> => {
      const tool = typeof toolNameArg === "string" ? (await tools()).find((item) => item.name === toolNameArg) : undefined;
      if (tool === undefined) throw new FabricDurableRefusal(`Tool not granted by this host: ${String(toolNameArg)}`);
      return tool;
    };
    const grantedAction = (ref: unknown): { ref: string; action: FabricDurableAction } => {
      if (typeof ref !== "string") throw new FabricDurableRefusal("Fabric ref must be a string");
      const dot = ref.indexOf(".");
      const provider = dot < 0 ? ref : ref.slice(0, dot);
      const actionName = dot < 0 ? "" : ref.slice(dot + 1);
      const grantedProvider = providers.get(provider);
      if (grantedProvider === undefined) throw new FabricDurableRefusal(`Fabric provider not granted by this host: ${provider}`);
      const action = ACTION_NAME.test(actionName) && Object.hasOwn(grantedProvider.actions, actionName) ? grantedProvider.actions[actionName] : undefined;
      if (typeof action !== "function") throw new FabricDurableRefusal(`Fabric action not granted by this host: ${ref}`);
      return { ref, action };
    };
    const runAction = async (ref: unknown, args: unknown): Promise<unknown> => {
      const { ref: resolved, action } = grantedAction(ref);
      const copied = copyArguments(args, resolved);
      try {
        const value = await action(copied, { api, context });
        return value === undefined ? null : JSON.parse(JSON.stringify(value)) as unknown;
      } catch (error) {
        if (error instanceof FabricDurableRefusal) throw new FabricDurableRefusal(error.message);
        report(error, info);
        throw new FabricDurableRefusal(`Fabric action ${resolved} failed`);
      }
    };
    return async (ref, args) => {
      switch (ref) {
        case "fabric.$piAllTools":
          return (await tools()).map((tool) => ({ name: tool.name, description: tool.description }));
        case "fabric.$piSearch": {
          if (typeof args.query !== "string") throw new FabricDurableRefusal("searchTools() expects a query string");
          const limit = args.limit ?? DEFAULT_SEARCH_LIMIT;
          if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1) throw new FabricDurableRefusal("searchTools() limit must be a positive integer");
          return searchCatalog(await tools(), args.query, limit);
        }
        case "fabric.$piDescribe": {
          const tool = await granted(args.name);
          return `${tool.description}\n\n${fabricToolDeclaration(tool)}`;
        }
        case "fabric.$nativeTool": {
          const tool = await granted(args.name);
          const copied = copyArguments(args.args, tool.name);
          const call: CallRecord = { name: tool.name };
          calls.push(call);
          const result = await api.executeTool(tool.name, copied, context);
          const outcome = outcomeOf(tool.name, tool.structuredOutputSchema !== undefined, result);
          call.ok = outcome.ok;
          if (!outcome.ok) throw new Error(outcome.message);
          return outcome.value;
        }
        case "fabric.$providers":
          return [...providers].map(([provider, entry]) => ({ name: provider, description: entry.description ?? "", actions: Object.keys(entry.actions) }));
        case "fabric.$call":
          return runAction(args.ref, args.args);
        default:
          // pi.*, agents.*, memory.*, mcp.*, jev.*, mesh.*, native.*, models and every other fabric.$ ref.
          throw new FabricDurableRefusal(`Not available in this durable host: ${ref}`);
      }
    };
  };

  const formatResult = (result: FabricSandboxResult, calls: readonly CallRecord[]): ToolExecutionResult => {
    const parts = [...result.logs];
    const failed = result.terminationReason !== "completed";
    if (failed) {
      parts.push(`Error (${result.terminationReason}): ${result.error ?? "program failed"}`, describeCalls(calls));
    } else if (result.value !== undefined) {
      parts.push(typeof result.value === "string" ? result.value : JSON.stringify(result.value, null, 2));
    }
    const text = cut(parts.join("\n") || "(no result)", maxResultChars, `${toolName} output`);
    return { output: [{ type: "text", text }], ...(failed ? { isError: true } : {}) };
  };

  const internalError: ToolExecutionResult = {
    output: [{ type: "text", text: `${toolName} failed with an internal error. The program may not have run.` }],
    isError: true,
  };

  const tool: ToolRegistration = {
    name: toolName,
    description:
      "Run a TypeScript program in a sandbox. `tools.<name>(args)` calls this conversation's tools and returns their output; " +
      "run independent calls together with Promise.all. `searchTools(query)` and `describeTool(name)` find tools the prompt does not list. " +
      "`print()` logs; the program's return value is the result. No files, shell or network.",
    parameters: Type.Object({
      code: Type.String({ description: "TypeScript function body; top-level await and return are supported." }),
      payloads: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Named strings readable as π.<key>." })),
    }),
    // A program's side effects are not journaled: never rerun one after a restart.
    replay: "unsafe",
    // Programs cannot start programs.
    callers: ["model"],
    // This tool cuts its own output with a notice; the Harness limit only stops a runaway.
    outputLimits: { maxBytes: maxResultChars * 4 + 4_096, maxLines: 1_000_000 },
    async execute(args, api, context) {
      try {
        const input = args as { code: string; payloads?: Record<string, string> };
        const runtime = options.runtime ?? await loadKernel(options.quickJsWasmModule);
        const calls: CallRecord[] = [];
        const sandbox: FabricSandboxOptions = {
          timeoutMs,
          memoryLimitBytes,
          maxLogChars,
          maxPendingTimers: MAX_PENDING_TIMERS,
          codemodeProfile: "native",
          nativeToolsEnabled: true,
          nativeStoreEnabled: false,
          providerGlobals: [...providers.keys()],
          ...(input.payloads === undefined ? {} : { strings: { ...input.payloads } }),
          ...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }),
        };
        const result = await runtime.execute(input.code, hostCall(api, context, calls), sandbox);
        return formatResult(result, calls);
      } catch (error) {
        report(error, { conversationId: api.conversationId, callId: api.callId });
        return internalError;
      }
    },
  };

  const guidance: PromptSection = {
    key: "fabric",
    render: (input) => {
      const callable = grantedTools(input.agent.callable);
      // Deferred tools stay callable but unlisted, as pi-durable's codemode does.
      const listed = callable.filter((item) => item.deferred !== true);
      const { shown, cut: budgetCut } = selectEntries(listed, sectionTokenBudget);
      const hidden = budgetCut || listed.length < callable.length;
      const granted = [...providers.keys()];
      return [
        `Use ${toolName} to batch several tool calls in one TypeScript program and return only the compact result.`,
        callable.length === 0 ? "Programs can call no tools here." : "Tools programs can call (`await tools.<name>(args)`):",
        ...shown,
        ...(hidden ? ["Some tools are not listed: find them with `searchTools(query)` and read one with `describeTool(name)`."] : []),
        granted.length ? `Granted providers: ${granted.join(", ")}.` : "No Fabric providers are available.",
      ].join("\n");
    },
  };

  return { name, tools: [tool], sections: [guidance] };
}
