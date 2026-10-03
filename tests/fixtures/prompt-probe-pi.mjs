#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = process.env.PROMPT_PROBE_ROOT;
const cli = fileURLToPath(new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/cli.js", import.meta.url));
const extension = fileURLToPath(new URL("./prompt-probe-extension.ts", import.meta.url));
// No inherited credentials, account pins, extensions, NODE_OPTIONS or live HOME.
// The fresh network namespace has no external interfaces or routes.
const result = spawnSync("/usr/bin/bwrap", [
  "--unshare-user", "--unshare-net", "--ro-bind", "/", "/", "--bind", root, root, "--",
  process.execPath, cli, "--no-context-files", "--no-skills", "--no-prompt-templates",
  "-e", extension, ...process.argv.slice(2),
], {
  stdio: "inherit", timeout: 20_000,
  env: { PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: path.join(root, "config"),
    PI_CODING_AGENT_DIR: path.join(root, "agent"), PI_OFFLINE: "1",
    TMPDIR: path.join(root, "tmp"), PROMPT_PROBE_ROOT: root },
});
process.exitCode = result.status ?? 1;
