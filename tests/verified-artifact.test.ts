import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe("verified kernel artifact receipt", () => {
  it("checks without Bend and rejects source, executable, and receipt drift", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-proof-artifact-"));
    temporary.push(dir);
    const manifestPath = "src/verified/generated/manifest.json";
    const manifest = JSON.parse(fs.readFileSync(path.join(root, manifestPath), "utf8")) as { inputs: Record<string, string> };
    for (const file of [...Object.keys(manifest.inputs), manifestPath, "src/verified/generated/kernel.js", "src/verified/generated/kernel.d.ts"]) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.copyFileSync(path.join(root, file), path.join(dir, file));
    }
    fs.symlinkSync(path.join(root, "node_modules"), path.join(dir, "node_modules"), "junction");
    const script = path.join(dir, "scripts/verified-kernels.mjs");
    const options = { encoding: "utf8" as const, env: { ...process.env, BEND_BIN: path.join(dir, "no-bend") }, timeout: 20_000 };
    expect(execFileSync(process.execPath, [script, "--artifact"], options)).toContain("matches its proof sources");
    for (const file of ["proofs/kernel.bend", "src/verified/generated/kernel.js", "src/verified/generated/kernel.d.ts", manifestPath]) {
      const target = path.join(dir, file);
      const original = fs.readFileSync(target, "utf8");
      fs.writeFileSync(target, file === manifestPath ? original.replace('"bend": "2.0.25"', '"bend": "0.0.0"') : original + "\n// changed\n");
      const result = spawnSync(process.execPath, [script, "--artifact"], options);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Verified kernel artifact is stale");
      fs.writeFileSync(target, original);
    }
  }, 30_000);
});
