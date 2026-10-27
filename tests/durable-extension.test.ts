// F-067: fabric_exec as a pi-durable extension inside a bare Harness, the way
// revere-pilot's agent host runs chat. Built against pi-durable, chord and
// pi-ai 1.4.0 (the revere-pilot versions), installed here as aliases next to
// the fork's 1.3.0 pins.
import { BACKGROUND_CONTEXT } from "chord-v14/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "pi-ai-v14";
import {
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  hook,
  MemoryStorage,
  ToolTask,
  type Extension,
} from "pi-durable-v14";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createFabricExtension, type FabricExtensionOptions } from "../src/durable-extension.js";

const ctx = BACKGROUND_CONTEXT;

interface Run {
  /** The text of the fabric_exec tool result the model saw next. */
  readonly result: string;
  /** Calls the stub tools received, in order. */
  readonly calls: { name: string; args: unknown }[];
  readonly status: string;
}

/** A bare Harness over memory storage: stub tools, a tenant guard like Revere's, and Fabric. */
async function runProgram(code: string, options: FabricExtensionOptions = {}): Promise<Run> {
  const calls: { name: string; args: unknown }[] = [];
  const stub = (name: string) => defineTool({
    name,
    description: `Stub ${name}`,
    parameters: Type.Object({ query: Type.Optional(Type.String()) }),
    execute: async (args) => {
      calls.push({ name, args });
      return { output: [{ type: "text", text: `${name}:${args.query ?? ""}` }] };
    },
  });
  const hostTools = defineExtension({ name: "host-tools", tools: [stub("search_knowledge"), stub("secret_admin")] });
  const guard = defineExtension({
    name: "tenant-guard",
    hooks: [hook(ToolTask, {
      beforeTool: (call) => call.name !== "fabric_exec" && JSON.stringify(call.arguments).includes("tenant") ? { block: "tool arguments may not name a tenant" } : undefined,
    })],
  });

  const faux = fauxProvider({ provider: "test", models: [{ id: "scripted" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  let result = "";
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("fabric_exec", { code }, { id: "call_1" })], { stopReason: "toolUse" }),
    (context) => {
      const last = context.messages.at(-1);
      if (last?.role === "toolResult") {
        result = last.content.map((part) => part.type === "text" ? part.text : "").join("");
      }
      return fauxAssistantMessage(fauxText("done"));
    },
  ]);

  const registry = createRegistry();
  registry.install(hostTools);
  registry.install(guard);
  registry.install(createFabricExtension({ timeoutMs: 10_000, ...options }) as unknown as Extension);
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
  try {
    const conversation = await harness.root(ctx, { agent: { model: { provider: "test", modelId: "scripted" } } });
    const submission = await conversation.submit({ type: "input", content: "go" }, ctx);
    const record = await submission.wait(ctx);
    return { result, calls, status: record.status };
  } finally {
    await harness.close(ctx);
  }
}

describe("createFabricExtension in a bare pi-durable Harness", () => {
  it("runs a program that calls a host tool through the conversation", async () => {
    const run = await runProgram(`
      const hit = await tools.search_knowledge({ query: "phishing" });
      return { hit, granted: Object.keys(tools).sort() };
    `, { tools: ["search_knowledge"] });
    expect(run.status).toBe("done");
    expect(run.calls).toEqual([{ name: "search_knowledge", args: { query: "phishing" } }]);
    expect(JSON.parse(run.result)).toEqual({ hit: "search_knowledge:phishing", granted: ["search_knowledge"] });
  });

  it("puts nested calls through the host's ToolTask hooks", async () => {
    const run = await runProgram(`
      try { await tools.search_knowledge({ query: "tenant t_other" }); return "ran"; }
      catch (error) { return "refused: " + error.message; }
    `);
    expect(run.calls).toEqual([]);
    expect(run.result).toMatch(/^refused: .*tenant/);
  });

  it("refuses a host tool the extension did not grant", async () => {
    const run = await runProgram(`
      const listed = Object.keys(tools).includes("secret_admin");
      let called;
      try { called = await tools.secret_admin({ query: "x" }); } catch (error) { called = "refused: " + error.message; }
      return { listed, called: String(called) };
    `, { tools: ["search_knowledge"] });
    expect(run.calls).toEqual([]);
    const value = JSON.parse(run.result) as { listed: boolean; called: string };
    expect(value.listed).toBe(false);
    expect(value.called).toMatch(/^refused: /);
  });

  it("refuses every Fabric provider and pi.* tool the host did not grant", async () => {
    const run = await runProgram(`
      const attempt = async (label, fn) => { try { await fn(); return label + ": ran"; } catch (error) { return label + ": " + error.message; } };
      return [
        await attempt("memory", () => memory.search({ query: "x" })),
        await attempt("call", () => fabric.tools.call({ ref: "state.get", args: {} })),
        await attempt("pi", () => pi.bash({ cmd: "id" })),
        await attempt("agents", () => agents.run({ task: "x" })),
        await attempt("granted", () => fabric.tools.call({ ref: "notes.add", args: { text: "ok" } })),
      ];
    `, { providers: { notes: { actions: { add: (args) => ({ added: args.text }) } } } });
    const lines = JSON.parse(run.result) as string[];
    expect(lines.slice(0, 4).every((line) => !line.endsWith(": ran") && /not granted|Not available/.test(line))).toBe(true);
    expect(lines[4]).toBe("granted: ran");
  });
});
