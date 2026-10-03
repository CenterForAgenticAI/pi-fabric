import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";

// Loaded only in a fresh, network-isolated Pi with a synthetic provider.
export default function (pi: ExtensionAPI) {
  const root = process.env.PROMPT_PROBE_ROOT!;
  const mode = fs.readFileSync(path.join(root, "scenario"), "utf8");
  const sends = path.join(root, "provider-sends");
  fs.writeFileSync(sends, "0");
  fs.writeFileSync(path.join(root, "namespace-pid"), String(process.pid));
  pi.registerProvider("prompt-probe", {
    baseUrl: "http://127.0.0.1:1", apiKey: "synthetic-offline", api: "prompt-probe-api",
    models: [{ id: "offline", name: "Offline", reasoning: false, input: ["text"],
      contextWindow: 200000, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model) {
      fs.writeFileSync(sends, String(Number(fs.readFileSync(sends, "utf8")) + 1));
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: [{ type: "text", text: "offline accepted" }], stopReason: "stop", timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: "stop", message });
      stream.end();
      return stream;
    },
  });
  pi.on("input", () => {
    if (mode === "handled") return { action: "handled" };
    if (mode === "throw") throw new Error("synthetic input hook error");
    return { action: "continue" };
  });
}
