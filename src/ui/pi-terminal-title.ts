import fs from "node:fs";
import path from "node:path";
import { hostSdkEntry } from "../core/host-sdk.js";

/** Pi's stock title; a branded install substitutes its `piConfig.name`. */
const DEFAULT_APP_TITLE = "π";

const readHostManifest = (sdkEntry: string): unknown => {
  let directory = path.dirname(sdkEntry);
  for (let depth = 0; depth < 4; depth += 1) {
    const file = path.join(directory, "package.json");
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
    directory = path.dirname(directory);
  }
  return undefined;
};

/**
 * The app name Pi itself prints, resolved the way Pi resolves it: a branded
 * `piConfig.name`, otherwise π. The manifest is read from the SDK entry the
 * running CLI already evaluated, so no host module is imported here.
 */
export const piAppTitle = (sdkEntry: string | undefined = hostSdkEntry()): string => {
  if (!sdkEntry) return DEFAULT_APP_TITLE;
  try {
    const manifest = readHostManifest(sdkEntry) as { piConfig?: { name?: unknown } } | undefined;
    const name = manifest?.piConfig?.name;
    return typeof name === "string" && name.trim() ? name.trim() : DEFAULT_APP_TITLE;
  } catch {
    // A bundled binary carries no package.json; the stock title still fits.
    return DEFAULT_APP_TITLE;
  }
};

/**
 * Pi titles its terminal `${app} - [${session} - ]${cwd}`. Fabric restores
 * exactly that shape instead of leaving a call title behind, and rebuilds it at
 * restore time so a session renamed mid-run still wins.
 */
export const piTerminalTitle = (context: {
  cwd: string;
  sessionManager: { getSessionName(): string | undefined };
}): string => {
  const directory = path.basename(context.cwd) || context.cwd;
  let name: string | undefined;
  try {
    name = context.sessionManager.getSessionName()?.trim();
  } catch {
    name = undefined;
  }
  return name
    ? `${piAppTitle()} - ${name} - ${directory}`
    : `${piAppTitle()} - ${directory}`;
};
