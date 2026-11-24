#!/usr/bin/env node
// RPC fake pi for F-097 withdrawal and structured external-record tests.
// Modes via FAKE_PI_MODE:
// - "dialog" (default): raises extension_ui_request ui-1; steer "WITHDRAW" emits extension_ui_cancel ui-1.
// - "external": emits structured setStatus open with externalRecord; steer "WITHDRAW" emits structured withdraw.
// Steer "FINISH" emits final assistant text and agent_settled.
// Also responds to get_state with sessionId (FAKE_PI_SESSION_ID || "child-sess-1").
import fs from "node:fs";
import readline from "node:readline";

const send = (event) => process.stdout.write(JSON.stringify(event) + "\n");
const recordPath = process.env.FAKE_PI_QUESTION_LOG;
const record = (entry) => {
  if (recordPath) fs.appendFileSync(recordPath, JSON.stringify(entry) + "\n");
};

const mode = process.env.FAKE_PI_MODE ?? "dialog";
const sessionId = process.env.FAKE_PI_SESSION_ID ?? "child-sess-1";
const externalId = process.env.FAKE_PI_EXTERNAL_ID ?? "dec_ext_001";
const STATUS_KEY = "__pi_fabric_child_question__";

let prompted = false;
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (!line.trim()) return;
  let command;
  try {
    command = JSON.parse(line);
  } catch {
    return;
  }
  if (command.type === "get_state") {
    send({
      type: "response",
      id: command.id,
      command: "get_state",
      success: true,
      data: {
        sessionId,
        isStreaming: false,
        isCompacting: false,
        thinkingLevel: "off",
      },
    });
    return;
  }
  if (command.type === "prompt" && !prompted) {
    prompted = true;
    send({ type: "response", id: command.id, command: "prompt", success: true });
    send({ type: "agent_start" });
    if (mode === "external") {
      send({
        type: "extension_ui_request",
        id: "status-open-1",
        method: "setStatus",
        statusKey: STATUS_KEY,
        statusText: JSON.stringify({
          v: 1,
          action: "open",
          requestId: "ext-1",
          title: "Pick DB",
          externalRecord: { system: "pi-decision", id: externalId },
          hold: true,
        }),
      });
    } else {
      send({
        type: "extension_ui_request",
        id: "ui-1",
        method: "select",
        title: "Pick",
        options: ["A", "B"],
      });
    }
    return;
  }
  if (command.type === "extension_ui_response") {
    record(command);
    return;
  }
  if (command.type === "steer" && command.message === "WITHDRAW") {
    if (mode === "external") {
      send({
        type: "extension_ui_request",
        id: "status-withdraw-1",
        method: "setStatus",
        statusKey: STATUS_KEY,
        statusText: JSON.stringify({
          v: 1,
          action: "withdraw",
          requestId: "ext-1",
        }),
      });
    } else {
      send({ type: "extension_ui_cancel", id: "ui-1" });
    }
    return;
  }
  if (command.type === "steer" && command.message === "FINISH") {
    send({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "finished" }] },
    });
    setTimeout(() => send({ type: "agent_settled" }), 30);
  }
});
process.stdin.on("end", () => setTimeout(() => process.exit(0), 5));
process.stdin.resume();
