import fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, Type, type AssistantMessage } from "@earendil-works/pi-ai";

// Offline provider with two models and a switch hook. Every entry into the
// provider's stream function is appended to MODEL_SWITCH_CALL_LOG, so a test can
// count the model calls each model received. MODEL_SWITCH_PHASE picks when the
// extension switches the session from `requested` to `other`:
//   before-start  at before_agent_start
//   between-turns at the end of the first turn (the first reply is a tool call)
//   context       inside a context handler, right before a model call
//   none          never
export default function (pi: ExtensionAPI) {
  const phase = process.env.MODEL_SWITCH_PHASE ?? "none";
  const log = (entry: Record<string, unknown>): void => {
    if (process.env.MODEL_SWITCH_CALL_LOG) fs.appendFileSync(process.env.MODEL_SWITCH_CALL_LOG, JSON.stringify(entry) + "\n");
  };
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  pi.registerProvider("switch-probe", {
    baseUrl: "http://127.0.0.1:1",
    apiKey: "offline-probe",
    api: "switch-probe-api",
    models: ["requested", "other"].map(id => ({
      id, name: id, reasoning: true, input: ["text"] as ("text" | "image")[],
      contextWindow: 200000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })),
    streamSimple(model, context) {
      log({ provider: model.provider, id: model.id });
      const toolTurn = phase === "between-turns" && !context.messages.some(message => message.role === "toolResult");
      const message: AssistantMessage = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: toolTurn
          ? [{ type: "toolCall", id: "call-1", name: "switch_probe_noop", arguments: {} }]
          : [{ type: "text", text: model.provider + "/" + model.id }],
        stopReason: toolTurn ? "toolUse" : "stop", timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: zero },
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
      stream.end();
      return stream;
    },
  });
  pi.registerTool({
    name: "switch_probe_noop", label: "No-op", description: "Offline fixture", parameters: Type.Object({}),
    async execute() { return { content: [{ type: "text", text: "done" }], details: {} }; },
  });
  let switched = false;
  const switchToOther = async (ctx: { modelRegistry: { find(provider: string, id: string): unknown } }): Promise<void> => {
    if (switched) return;
    switched = true;
    await pi.setModel(ctx.modelRegistry.find("switch-probe", "other") as Parameters<ExtensionAPI["setModel"]>[0]);
    log({ switched: phase });
  };
  if (phase === "before-start") pi.on("before_agent_start", async (_event, ctx) => { await switchToOther(ctx); });
  if (phase === "between-turns") pi.on("turn_end", async (_event, ctx) => { await switchToOther(ctx); });
  if (phase === "context") pi.on("context", async (_event, ctx) => { await switchToOther(ctx); });
}
