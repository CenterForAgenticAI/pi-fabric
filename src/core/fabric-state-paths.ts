import path from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

// Single source of truth for Fabric's own project state directory. The runtime
// writes caches and stores there, so mutation-drift detection must read those
// writes as runtime bookkeeping, never as user work.
export const FABRIC_STATE_DIR_NAME = "fabric";

export const fabricStateDir = (
  projectRoot: string,
  configDirName: string = CONFIG_DIR_NAME,
): string => path.join(projectRoot, configDirName, FABRIC_STATE_DIR_NAME);

// Relative-path form for surfaces that only see listing output (no root).
export const isFabricStateRelativePath = (relative: string): boolean => {
  const normalized = relative.replaceAll("\\", "/");
  const prefix = `${CONFIG_DIR_NAME}/${FABRIC_STATE_DIR_NAME}`;
  return normalized === prefix || normalized.startsWith(`${prefix}/`);
};
