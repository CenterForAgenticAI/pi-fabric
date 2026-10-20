import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveAgentDir } from "../core/agent-dir.js";
import { saveFabricConfig } from "../config.js";
import type { FabricState } from "../fabric-state.js";
import type { SessionLabelStatus } from "../topology/session-label.js";
import { SESSION_LABEL_HERDR_TARGETS, SESSION_LABEL_POSITIONS } from "../topology/session-label-settings.js";

// Loaded on first use of `/fabric label`, so the command's parsing and text
// stay out of the startup graph.

const SESSION_LABEL_SETTINGS = {
  footer: { key: "footer", values: ["on", "off"] },
  herdr: { key: "herdr", values: SESSION_LABEL_HERDR_TARGETS },
  position: { key: "herdrPosition", values: SESSION_LABEL_POSITIONS },
} as const;

type SessionLabelSetting = keyof typeof SESSION_LABEL_SETTINGS;

const SESSION_LABEL_USAGE = [
  "Usage: /fabric label [footer on|off | herdr off|tab|pane|both | position prefix|suffix]",
  "With no arguments, shows where this session's Fabric label appears.",
].join("\n");

const isSessionLabelSetting = (value: string): value is SessionLabelSetting =>
  Object.hasOwn(SESSION_LABEL_SETTINGS, value);

/** One `/fabric label <setting> <value>` change, or undefined when the arguments are not one. */
const parseSessionLabelChange = (
  argumentsList: string[],
): { setting: SessionLabelSetting; key: string; value: string | boolean; shown: string } | undefined => {
  const [setting, shown, ...extra] = argumentsList;
  if (!setting || !shown || extra.length > 0 || !isSessionLabelSetting(setting)) return undefined;
  const spec = SESSION_LABEL_SETTINGS[setting];
  if (!(spec.values as readonly string[]).includes(shown)) return undefined;
  return { setting, key: spec.key, value: setting === "footer" ? shown === "on" : shown, shown };
};

/** Completion values replace the whole argument, so each carries the full `label …` text. */
export const sessionLabelCompletions = (prefix: string): AutocompleteItem[] | null => {
  const space = prefix.indexOf(" ");
  if (space < 0) {
    const matches = Object.keys(SESSION_LABEL_SETTINGS).filter((name) => name.startsWith(prefix));
    return matches.length > 0
      ? matches.map((name) => ({ value: `label ${name}`, label: name }))
      : null;
  }
  const setting = prefix.slice(0, space);
  const valuePrefix = prefix.slice(space + 1);
  if (!isSessionLabelSetting(setting) || valuePrefix.includes(" ")) return null;
  const matches = SESSION_LABEL_SETTINGS[setting].values.filter((value) => value.startsWith(valuePrefix));
  return matches.length > 0
    ? matches.map((value) => ({ value: `label ${setting} ${value}`, label: value }))
    : null;
};

const formatSessionLabelStatus = (status: SessionLabelStatus | undefined): string => {
  if (!status) return "Fabric label: not shown here; only a root Pi session shows its label.";
  const herdr = status.herdr.target === "off"
    ? "herdr: off"
    : `herdr: ${status.herdr.target} (${status.herdr.position})`;
  const herdrDetail = status.herdr.target === "off"
    ? ""
    : !status.herdr.available
      ? "; Herdr not detected in this session"
      : status.herdr.applied.length > 0
        ? `; on ${status.herdr.applied.join(", ")}`
        : "";
  return [
    `Fabric label: ${status.label ?? "not assigned yet (needs the Fabric mesh)"}`,
    `footer: ${status.footer ? "on" : "off"}; ${herdr}${herdrDetail}`,
    ...(status.herdr.error ? [`Herdr error: ${status.herdr.error}`] : []),
    "Change with /fabric label footer on|off, herdr off|tab|pane|both, position prefix|suffix.",
  ].join("\n");
};

/**
 * `/fabric label [setting value]`: with no arguments, report where the label
 * shows; with one setting and value, save it to the project config (global
 * when the project is untrusted), reload, and apply it now.
 */
export const runSessionLabelCommand = async (
  state: FabricState,
  context: ExtensionContext,
  argumentsList: string[],
): Promise<void> => {
  if (argumentsList.length === 0) {
    context.ui.notify(formatSessionLabelStatus(state.sessionLabel()?.status()), "info");
    return;
  }
  const change = parseSessionLabelChange(argumentsList);
  if (!change) {
    context.ui.notify(SESSION_LABEL_USAGE, "warning");
    return;
  }
  try {
    const projectTrusted = context.isProjectTrusted();
    const saved = saveFabricConfig(
      {
        cwd: context.cwd,
        agentDir: resolveAgentDir(),
        projectTrusted,
        scope: projectTrusted ? "project" : "global",
      },
      { ui: { sessionLabel: { [change.key]: change.value } } },
    );
    state.reloadConfig(context);
    await state.sessionLabel()?.sync();
    context.ui.notify(
      `Fabric label ${change.setting}: ${change.shown} (${saved.scope}: ${saved.path})`,
      "info",
    );
  } catch (error) {
    context.ui.notify(
      `Failed to update Fabric label setting: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  }
};
