import { parentPort, threadId } from "node:worker_threads";

parentPort.on("message", ({ id, args, branch }) => {
  if (args.exit) process.exit(0);
  if (args.crash) throw new Error("fixture worker crashed");
  parentPort.postMessage({ id, type: "progress", text: "started" });
  if (args.gate) Atomics.wait(new Int32Array(args.gate), 0, 0);
  if (args.error) {
    parentPort.postMessage({ id, type: "error", name: "RangeError", message: "fixture request failed" });
  } else {
    parentPort.postMessage({ id, type: "result", value: { threadId, branch, marker: args.marker } });
  }
});
