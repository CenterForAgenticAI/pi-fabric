/** The parent passes the pinned `provider/id` here; only the worker sets it. */
export const MODEL_PIN_ENV = "PI_FABRIC_MODEL_PIN";
/** Exit status of a child that stopped itself because the model was not the pin. */
export const MODEL_PIN_EXIT_CODE = 71;
/** Prefix of the single stderr line that names the violation for the worker. */
export const MODEL_PIN_MARKER = "[pi-fabric] model-pin-violation ";

export interface ModelPinViolation {
  pinned: string;
  /** `provider/id` of the model that was about to run, or "none". */
  actual: string;
}

/** Fixed run error; the worker builds it from the stderr marker. */
export const modelPinFailure = (violation: ModelPinViolation): string =>
  `Fabric exact model pin violated: only ${violation.pinned} may run, but ${violation.actual} was about to run. ` +
  "The provider call was stopped before any request was sent.";

/** Parse the marker line out of a child's stderr; undefined when absent or malformed. */
export const parseModelPinViolation = (stderr: string): ModelPinViolation | undefined => {
  const start = stderr.lastIndexOf(MODEL_PIN_MARKER);
  if (start < 0) return undefined;
  const line = stderr.slice(start + MODEL_PIN_MARKER.length).split("\n", 1)[0] ?? "";
  try {
    const value = JSON.parse(line) as Partial<ModelPinViolation>;
    return typeof value.pinned === "string" && typeof value.actual === "string"
      ? { pinned: value.pinned, actual: value.actual }
      : undefined;
  } catch {
    return undefined;
  }
};
