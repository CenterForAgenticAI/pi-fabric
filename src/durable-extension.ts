// pi-fabric/durable-extension: fabric_exec as a pi-durable registry extension (F-067 spike).
//
// A host that runs its own pi-durable Harness (no Pi session, no ExtensionAPI)
// installs createFabricExtension() next to its tool extensions. Programs run in
// the QuickJS kernel. Inside a program `tools.<name>` reaches only the tools the
// conversation lets other tools call (`Agent.callable`), narrowed further by
// `options.tools`; each call goes through `ToolExecutionApi.executeTool`, so the
// host's ToolTask hooks (tenant guards, audits) see it as a nested call. Every
// Fabric provider (memory, agents, mcp, pi.*, ...) is refused unless the host
// grants it in `options.providers`. Nothing here touches files, a shell, the
// Pi UI, compaction, prewalk or topology.
//
// The module imports pi-durable for types only: the extension is a plain object,
// so it does not pin a pi-durable runtime version.
import type { Context } from "@earendil-works/chord/context";
import type {
  Extension,
  JsonObject,
  PromptSection,
  ToolExecutionApi,
  ToolExecutionResult,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import type { FabricHostCall, FabricKernelRuntime, FabricSandboxResult } from "./runtime/kernel.js";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** One granted action of a host provider. Arguments are the program's object, copied. */
export type FabricDurableAction = (
  args: JsonObject,
  call: { readonly api: ToolExecutionApi; readonly context: Context },
) => unknown | Promise<unknown>;

/** A provider the host grants to programs, reachable as `tools.call({ ref: "<name>.<action>" })` or `<name>.<action>()`. */
export interface FabricDurableProvider {
  readonly description?: string;
  readonly actions: Readonly<Record<string, FabricDurableAction>>;
}

export interface FabricExtensionOptions {
  /** Registry extension name. Default `pi-fabric`. */
  readonly name?: string;
  /** Tool name. Default `fabric_exec`. */
  readonly toolName?: string;
  /**
   * Host tools programs may call, by name, out of the conversation's callable tools.
   * Omitted: every callable tool. An empty list grants none.
   */
  readonly tools?: readonly string[];
  /** Fabric providers granted to programs. Omitted: none; every provider ref is refused. */
  readonly providers?: Readonly<Record<string, FabricDurableProvider>>;
  /** Whole-program deadline. Default 30 s. */
  readonly timeoutMs?: number;
  /** QuickJS heap limit. Default 64 MiB. */
  readonly memoryLimitBytes?: number;
  /** Program log cap. Default 20 000 characters. */
  readonly maxLogChars?: number;
  /** Kernel override, for example a sandbox in another isolate. Default: the in-process QuickJS kernel. */
  readonly runtime?: FabricKernelRuntime;
}

const PROVIDER_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const ACTION_NAME = /^[A-Za-z_$][\w$]{0,127}$/;

/** Refusal raised to the program; the message reaches the guest as an Error. */
export class FabricDurableRefusal extends Error {
  override readonly name = "FabricDurableRefusal";
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Copy a program value into plain JSON: no prototypes, getters or cycles cross into the host. */
const jsonCopy = (value: unknown): JsonObject => {
  if (!isObject(value)) throw new FabricDurableRefusal("Tool arguments must be one object");
  return JSON.parse(JSON.stringify(value)) as JsonObject;
};

let quickJs: Promise<FabricKernelRuntime> | undefined;
const defaultRuntime = (): Promise<FabricKernelRuntime> =>
  quickJs ??= import("./runtime/quickjs-runtime.js").then(({ QuickJsRuntime }) => new QuickJsRuntime());

const formatResult = (result: FabricSandboxResult): { text: string; isError: boolean } => {
  const parts = [...result.logs];
  if (result.terminationReason !== "completed") {
    parts.push(`Error (${result.terminationReason}): ${result.error ?? "program failed"}`);
    return { text: parts.join("\n"), isError: true };
  }
  if (result.value !== undefined) {
    parts.push(typeof result.value === "string" ? result.value : JSON.stringify(result.value, null, 2));
  }
  return { text: parts.join("\n") || "(no result)", isError: false };
};

/** The fabric_exec tool and a short prompt section, as one pi-durable extension. */
export function createFabricExtension(options: FabricExtensionOptions = {}): Extension {
  const toolName = options.toolName ?? "fabric_exec";
  const toolAllowlist = options.tools === undefined ? undefined : new Set(options.tools);
  const providers = new Map<string, FabricDurableProvider>();
  for (const [name, provider] of Object.entries(options.providers ?? {})) {
    if (!PROVIDER_NAME.test(name)) throw new Error(`Invalid Fabric provider name: ${name}`);
    providers.set(name, provider);
  }

  /** The host's tools a program may call: callable in this conversation, granted, never fabric_exec itself. */
  const grantedTools = (callable: readonly ToolRegistration[]): ToolRegistration[] =>
    callable.filter((tool) => tool.name !== toolName && (toolAllowlist === undefined || toolAllowlist.has(tool.name)));

  const grantedAction = (ref: unknown): FabricDurableAction => {
    if (typeof ref !== "string") throw new FabricDurableRefusal("Fabric ref must be a string");
    const dot = ref.indexOf(".");
    const provider = dot < 0 ? ref : ref.slice(0, dot);
    const action = dot < 0 ? "" : ref.slice(dot + 1);
    const granted = providers.get(provider);
    if (granted === undefined) throw new FabricDurableRefusal(`Fabric provider not granted by this host: ${provider}`);
    const handler = ACTION_NAME.test(action) && Object.hasOwn(granted.actions, action) ? granted.actions[action] : undefined;
    if (handler === undefined) throw new FabricDurableRefusal(`Fabric action not granted by this host: ${ref}`);
    return handler;
  };

  const hostCall = (api: ToolExecutionApi, context: Context): FabricHostCall => {
    let catalog: Promise<ToolRegistration[]> | undefined;
    const tools = () => catalog ??= api.agent(context).then((agent) => grantedTools(agent.callable));
    return async (ref, args) => {
      switch (ref) {
        case "fabric.$piAllTools":
          return (await tools()).map((tool) => ({ name: tool.name, description: tool.description }));
        case "fabric.$nativeTool": {
          const name = args.name;
          if (typeof name !== "string" || !(await tools()).some((tool) => tool.name === name)) {
            throw new FabricDurableRefusal(`Tool not granted by this host: ${String(name)}`);
          }
          const result = await api.executeTool(name, jsonCopy(args.args ?? {}), context);
          if (result.isError) {
            const detail = result.diagnostics.map((item) => item.message).join("; ")
              || (typeof result.structuredOutput === "string" ? result.structuredOutput : "tool failed");
            throw new Error(`${name}: ${detail}`);
          }
          return result.structuredOutput ?? null;
        }
        case "fabric.$providers":
          return [...providers].map(([name, provider]) => ({ name, description: provider.description ?? "", actions: Object.keys(provider.actions) }));
        case "fabric.$call":
          return grantedAction(args.ref)(jsonCopy(args.args ?? {}), { api, context });
        default:
          // Provider globals (memory.x, state.x, ...) arrive as "<provider>.<action>";
          // pi.*, agents.*, mcp.*, native.* and other fabric.$ refs are never granted.
          if (!ref.startsWith("fabric.") && providers.has(ref.slice(0, ref.indexOf(".")))) {
            return grantedAction(ref)(jsonCopy(args), { api, context });
          }
          throw new FabricDurableRefusal(`Not available in this durable host: ${ref}`);
      }
    };
  };

  const tool: ToolRegistration = {
    name: toolName,
    description:
      "Run a TypeScript program in a sandbox. `tools.<name>(args)` calls this conversation's tools and returns their output; " +
      "`print()` logs; the program's return value is the result. No files, shell or network.",
    parameters: Type.Object({
      code: Type.String({ description: "TypeScript function body; top-level await and return are supported." }),
      payloads: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Named strings readable as π.<key>." })),
    }),
    // A program's side effects are not journaled: never rerun one after a restart.
    replay: "unsafe",
    // Programs cannot start programs.
    callers: ["model"],
    async execute(args, api, context) {
      const input = args as { code: string; payloads?: Record<string, string> };
      const runtime = options.runtime ?? await defaultRuntime();
      const result = await runtime.execute(input.code, hostCall(api, context), {
        timeoutMs: options.timeoutMs ?? 30_000,
        memoryLimitBytes: options.memoryLimitBytes ?? 64 * 1024 * 1024,
        maxLogChars: options.maxLogChars ?? 20_000,
        maxPendingTimers: 64,
        codemodeProfile: "native",
        nativeToolsEnabled: true,
        nativeStoreEnabled: false,
        providerGlobals: [...providers.keys()],
        ...(input.payloads === undefined ? {} : { strings: { ...input.payloads } }),
        ...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }),
      });
      const { text, isError } = formatResult(result);
      const output: ToolExecutionResult = { output: [{ type: "text", text }], ...(isError ? { isError } : {}) };
      return output;
    },
  };

  const guidance: PromptSection = {
    key: "fabric",
    render: (input) => {
      const names = grantedTools(input.agent.callable).map((item) => item.name);
      const granted = [...providers.keys()];
      return [
        `Use ${toolName} to batch several tool calls in one TypeScript program and return only the compact result.`,
        names.length ? `Programs can call: ${names.map((name) => `tools.${name}(args)`).join(", ")}.` : "Programs can call no tools here.",
        granted.length ? `Granted providers: ${granted.join(", ")}.` : "No Fabric providers are available.",
      ].join("\n");
    },
  };

  return { name: options.name ?? "pi-fabric", tools: [tool], sections: [guidance] };
}
