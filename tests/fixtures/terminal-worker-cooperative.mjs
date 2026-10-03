#!/usr/bin/env node
// Test transport only: the manager sends an IPC stop and the fixture child gets
// an explicit flush request. Real dist/worker.js owns terminal state, framing,
// projection, accounting, export and deadlines. No graceful Windows claim.
import fs from "node:fs";
const root = process.env.TERMINAL_PROBE_ROOT;
const realKill = process.kill.bind(process);
process.kill = (pid, signal) => {
  if (signal === "SIGTERM" && pid !== process.pid && pid !== 0) {
    fs.writeFileSync(`${root}/flush-request`, "true");
    return true;
  }
  return realKill(pid, signal);
};
process.on("message", message => {
  if (message === "stop") process.emit("SIGTERM");
});
await import("../../dist/worker.js");
// The worker starts its async main without top-level await. Keep IPC available
// during the run, but do not let that listener keep a settled worker alive.
process.channel?.unref();
