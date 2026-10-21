// `ui.sessionLabel` is checked here, where it is used, rather than in
// normalizeFabricConfig: the presenter, `/fabric label` and the settings UI all
// load at first use, so the check stays out of the startup graph.

export const SESSION_LABEL_HERDR_TARGETS = ["off", "tab", "pane", "both"] as const;
export const SESSION_LABEL_POSITIONS = ["prefix", "suffix"] as const;

/** Which Herdr name, if any, carries this session's Fabric peer label. */
export type FabricSessionLabelHerdrTarget = (typeof SESSION_LABEL_HERDR_TARGETS)[number];
export type FabricSessionLabelPosition = (typeof SESSION_LABEL_POSITIONS)[number];

/** Where a root session shows its Fabric peer label, such as `FAB-3`. */
export interface FabricSessionLabelConfig {
  /** Show the label as a Pi footer status. */
  footer: boolean;
  /** Add the label to the Herdr tab, the pane, both, or neither. */
  herdr: FabricSessionLabelHerdrTarget;
  /** Put the label before or after the existing Herdr name. */
  herdrPosition: FabricSessionLabelPosition;
}

const oneOf = <T extends string>(values: readonly T[], value: unknown, fallback: T): T =>
  values.includes(value as T) ? (value as T) : fallback;

/** The checked `ui.sessionLabel` setting; a missing or invalid value takes its default. */
export const sessionLabelSettings = (value: unknown): FabricSessionLabelConfig => {
  const raw: Record<string, unknown> =
    typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  return {
    footer: typeof raw.footer === "boolean" ? raw.footer : true,
    herdr: oneOf(SESSION_LABEL_HERDR_TARGETS, raw.herdr, "off"),
    herdrPosition: oneOf(SESSION_LABEL_POSITIONS, raw.herdrPosition, "prefix"),
  };
};
