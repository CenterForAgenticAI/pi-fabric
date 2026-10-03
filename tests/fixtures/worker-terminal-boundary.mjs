import fs from "node:fs";
import { createInterface } from "node:readline";
const root = process.env.TERMINAL_PROBE_ROOT;
const scenario = fs.readFileSync(`${root}/scenario`, "utf8");
const encode = event => JSON.stringify(event) + "\n";
const usageFrame = { type: "message_end", message: { role: "assistant",
  content: "REVIEW_PRIVATE_MARKER_rejected_text", errorMessage: "REVIEW_PRIVATE_MARKER_error",
  stopReason: "aborted", provider: "REVIEW_PRIVATE_MARKER_provider", model: "REVIEW_PRIVATE_MARKER_model",
  timestamp: 123, usage: { input: 100, output: 40, cacheRead: 0, cacheWrite: 0, cost: { total: 0.7 },
    private: "REVIEW_PRIVATE_MARKER_usage" } } };
process.on("SIGTERM", () => {
  if (!scenario.includes("usage")) return;
  const flushed = scenario.includes("invalid")
    ? { ...usageFrame, message: { ...usageFrame.message, usage: { input: "900", output: 40, cacheRead: -8, cacheWrite: Number.MAX_SAFE_INTEGER + 1, cost: -1 } } }
    : usageFrame;
  let output = encode(flushed);
  if (scenario.includes("duplicate")) output += encode(flushed);
  if (scenario.includes("oversized")) output += encode({ type: "message_end", message: { role: "assistant", content: "REVIEW_PRIVATE_MARKER_" + "x".repeat(4 * 1024 * 1024) } });
  if (scenario.includes("tail")) output = output.trimEnd();
  process.stdout.write(output, () => {
    fs.writeFileSync(`${root}/usage-flushed`, "true");
    setTimeout(() => process.exit(0), 20);
  });
});
const input = createInterface({ input: process.stdin });
let emitted = false;
input.on("line", line => {
  const frame = JSON.parse(line);
  if (emitted || (frame.type !== "prompt" && frame.type !== "user")) return;
  emitted = true;
  fs.writeFileSync(`${root}/prompts`, "1");
  const handled = { type: "response", command: "prompt", id: frame.id, success: true, data: { disposition: "handled" } };
  const start = encode({ type: "agent_start" });
  const complete = start + encode({ type: "message_end", message: { role: "assistant", content: "synthetic completed" } }) +
    encode({ type: "turn_end" }) + encode({ type: "agent_settled" });
  if (scenario.includes("usage") && !scenario.startsWith("handled")) {
    let output = encode({ ...handled, data: { disposition: "started" } }) + start;
    if (scenario.includes("already")) output += encode({ ...usageFrame, message: { ...usageFrame.message, content: "completed work" } });
    process.stdout.write(output, () => fs.writeFileSync(`${root}/active`, "true"));
    setInterval(() => {}, 60000);
    return;
  }
  let output;
  if (scenario.startsWith("oversized-handled")) {
    output = encode({ ...handled, privateMetadata: "REVIEW_PRIVATE_MARKER_" + "x".repeat(4 * 1024 * 1024) });
  } else if (scenario.startsWith("handled-late-oversized")) {
    output = encode(handled) + encode({ type: "message_end", message: { role: "assistant", content: "REVIEW_PRIVATE_MARKER_" + "x".repeat(4 * 1024 * 1024) } });
  } else if (scenario === "handled-late-usage") {
    output = encode(handled) + encode(usageFrame);
  } else if (scenario.startsWith("native-reject")) {
    const reject = encode({ type: "response", command: "prompt", id: scenario.includes("noid") ? undefined : frame.id, success: false, error: "synthetic native rejection" });
    output = (scenario.includes("started") ? start : "") + reject + complete;
  } else if (scenario === "unmatched-reject") {
    output = encode({ type: "response", command: "prompt", id: "operator", success: false, error: "unrelated rejection" }) + complete;
  } else if (scenario === "claude-diagnostic") {
    output = "REVIEW_DIAGNOSTIC_LINE\nnull\n[]\n" + encode({ type: "result", subtype: "success", is_error: false, result: "synthetic completed", num_turns: 1 });
  } else {
    output = "REVIEW_DIAGNOSTIC_LINE\nnull\n[]\n" + encode({ ...handled, data: { disposition: "started" } }) + complete;
  }
  if (scenario.includes("tail")) output = output.trimEnd();
  const finish = () => setTimeout(() => process.exit(0), 20);
  if (scenario.includes("split")) {
    const boundary = output.indexOf("REVIEW_PRIVATE_MARKER_") + 10;
    process.stdout.write(output.slice(0, boundary), () => setTimeout(() => process.stdout.write(output.slice(boundary), finish), 10));
  } else process.stdout.write(output, finish);
});
