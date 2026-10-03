#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { isolatedSpawn } from "./prompt-probe-sandbox.mjs";

const root = process.env.PROMPT_PROBE_ROOT;
const cli = fileURLToPath(new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/cli.js", import.meta.url));
const extension = fileURLToPath(new URL("./prompt-probe-extension.ts", import.meta.url));
// The same fail-closed sandbox is behaviorally probed before any public Pi run.
const result = isolatedSpawn(root, process.execPath, [cli,
  "--no-context-files", "--no-skills", "--no-prompt-templates", "-e", extension,
  ...process.argv.slice(2),
], "inherit");
process.exitCode = result.status ?? 1;
