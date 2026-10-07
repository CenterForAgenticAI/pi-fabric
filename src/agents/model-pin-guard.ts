import fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MODEL_PIN_ENV, MODEL_PIN_EXIT_CODE, MODEL_PIN_MARKER, type ModelPinViolation } from "./model-pin.js";

const identity = (model: unknown): string => {
  if (typeof model !== "object" || model === null) return "none";
  const { provider, id } = model as { provider?: unknown; id?: unknown };
  return typeof provider === "string" && provider && typeof id === "string" && id ? `${provider}/${id}` : "none";
};

/**
 * Child-side guard, loaded by the worker with -e only for `modelMatch: "exact"`.
 *
 * Pi swallows an exception thrown by an extension handler and goes on with the
 * request, so throwing is no veto. `ctx.abort()` also kept the provider from being
 * entered in Pi 1.0.4 probes, but only because credential lookup before the stream
 * honours the aborted signal, and the run would fail as a plain abort without a
 * fixed reason. Ending this process before the call depends on neither: the
 * check runs before each model call
 * (`context`, then `context_with_system` once every `context` handler has run)
 * and again inside the provider stream before the HTTP request
 * (`before_provider_request`). The model checked is Pi's current model, so a
 * switch made by any other extension, at any point, is seen.
 */
export default function fabricModelPinGuard(pi: ExtensionAPI): void {
  const pinned = process.env[MODEL_PIN_ENV] ?? "";
  const check = (context: { model?: unknown }): void => {
    let actual: string;
    try {
      actual = identity(context.model);
    } catch {
      // A stale context or a throwing getter is not evidence of the pin.
      actual = "none";
    }
    if (pinned !== "" && actual === pinned) return;
    const violation: ModelPinViolation = { pinned: pinned || "unset", actual };
    try {
      fs.writeSync(2, `\n${MODEL_PIN_MARKER}${JSON.stringify(violation)}\n`);
    } catch {
      // The exit status alone still fails the run.
    }
    process.exit(MODEL_PIN_EXIT_CODE);
  };
  pi.on("context", (_event, context) => { check(context); });
  pi.on("context_with_system", (_event, context) => { check(context); });
  pi.on("before_provider_request", (_event, context) => { check(context); });
}
