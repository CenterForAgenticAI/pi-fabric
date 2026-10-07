import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

const fixture = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-build-artifacts-"));
  temporary.push(dir);
  fs.cpSync(path.join(root, "dist"), path.join(dir, "dist"), { recursive: true });
  for (const file of ["package.json", "scripts/assert-build-artifacts.mjs", "src/verified/generated/manifest.json"]) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.copyFileSync(path.join(root, file), path.join(dir, file));
  }
  fs.cpSync(path.join(root, "node_modules", "pi-coralbricks-provider"), path.join(dir, "node_modules", "pi-coralbricks-provider"), { recursive: true, dereference: true });
  return dir;
};
const rejected = (dir: string, reason: string): void => {
  const result = spawnSync(process.execPath, [path.join(dir, "scripts/assert-build-artifacts.mjs")], { encoding: "utf8", timeout: 20_000 });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(reason);
};

describe("published build artifact guards", () => {
  it("uses host-only wildcard peers and exact Pi development dependencies", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    expect(manifest.dependencies["pi-fabric-worker-sdk"]).toBe(`npm:@earendil-works/pi-coding-agent@${manifest.devDependencies["@earendil-works/pi-coding-agent"]}`);
    for (const name of ["@earendil-works/pi-ai", "@earendil-works/pi-agent-core", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"]) {
      expect(manifest.dependencies[name]).toBeUndefined();
      expect(manifest.peerDependencies[name]).toBe("*");
      expect(manifest.devDependencies[name]).toBe(name === "typebox" ? "1.3.27" : "1.3.0");
      expect(manifest.overrides?.[name]).toBeUndefined();
      expect(manifest.resolutions?.[name]).toBeUndefined();
    }
  });
  it("rejects a public export omitted from the compiled tree", () => {
    const dir = fixture();
    const file = path.join(dir, "package.json");
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    manifest.exports["./missing"] = { import: "./dist/missing.js" };
    fs.writeFileSync(file, JSON.stringify(manifest));
    rejected(dir, "Missing or unpackaged public entrypoint: ./dist/missing.js");
  });
  it.each(["yaml", "pi-fabric-worker-sdk"])("rejects eager %s in the actual extension entry", (dependency) => {
    const dir = fixture();
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    expect(manifest.pi.extensions[0]).toBe("./dist/extension-bootstrap.js");
    fs.appendFileSync(path.join(dir, manifest.pi.extensions[0]), `\nimport "${dependency}";\n`);
    rejected(dir, `Startup eagerly imports optional dependency ${dependency}`);
  });
  it.each([
    ["an entry outside bundledDependencies", (manifest: any) => { manifest.bundledDependencies = []; }, "is not a bundled dependency"],
    ["a ranged bundled dependency", (manifest: any) => { manifest.dependencies["pi-coralbricks-provider"] = "^1.0.0"; }, "must be an exact runtime dependency"],
    ["an entry the bundled package does not declare", (manifest: any) => { manifest.pi.extensions[1] = "./node_modules/pi-coralbricks-provider/settings.ts"; }, "is not declared by pi-coralbricks-provider"],
  ])("rejects %s", (_label, mutate, reason) => {
    const dir = fixture();
    const file = path.join(dir, "package.json");
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    mutate(manifest);
    fs.writeFileSync(file, JSON.stringify(manifest));
    rejected(dir, reason);
  });
  it("rejects a bundled Pi package that depends on a host package", () => {
    const dir = fixture();
    const file = path.join(dir, "node_modules/pi-coralbricks-provider/package.json");
    const bundled = JSON.parse(fs.readFileSync(file, "utf8"));
    bundled.dependencies = { "@earendil-works/pi-ai": "1.3.0" };
    fs.writeFileSync(file, JSON.stringify(bundled));
    rejected(dir, "must declare host package @earendil-works/pi-ai as a peer");
  });
  it("rejects a missing standalone worker validator", () => {
    const dir = fixture();
    fs.rmSync(path.join(dir, "dist/worker/result.js"));
    rejected(dir, "worker/result.js");
  });
  it.each(["worker.js", "durable/worker.js"])("rejects external dependencies in %s bootstrap", (entry) => {
    const dir = fixture();
    fs.appendFileSync(path.join(dir, "dist", entry), '\nimport "typebox/value";\n');
    rejected(dir, "Worker bootstrap imports an external package: typebox/value");
  });
  it("rejects a validator that relies on host modules", () => {
    const dir = fixture();
    fs.appendFileSync(path.join(dir, "dist/worker/result.js"), '\nimport "typebox/value";\n');
    rejected(dir, "Worker validator must be self-contained");
  });
  it("rejects a missing lazy Bend grammar entry", () => {
    const dir = fixture();
    fs.rmSync(path.join(dir, "dist/ui/languages/bend.js"));
    rejected(dir, "ui/languages/bend.js");
  });
  it("rejects a missing stable image-overlay entry", () => {
    const dir = fixture();
    fs.rmSync(path.join(dir, "dist/ui/image-overlays.js"));
    rejected(dir, "ui/image-overlays.js");
  });
  it.each(["native-discovery.js", "memory/extractive-history.js", "durable/worker.js", "durable/worker-host.js"])("requires stable optional entry %s", (entry) => {
    const dir = fixture();
    fs.rmSync(path.join(dir, "dist", entry));
    rejected(dir, entry);
  });
  it("rejects an eager extractive engine implementation", () => {
    const dir = fixture();
    fs.appendFileSync(path.join(dir, "dist/extension-bootstrap.js"), "\n// src/memory/extractive-index.ts\n");
    rejected(dir, "Startup static graph contains lazy module marker: src/memory/extractive-index.ts");
  });
  it("rejects a missing generated ABI declaration", () => {
    const dir = fixture();
    fs.rmSync(path.join(dir, "dist/verified/generated/storage.d.ts"));
    rejected(dir, "storage.d.ts");
  });
  it("rejects a modified generated library in the bundle", () => {
    const dir = fixture();
    fs.appendFileSync(path.join(dir, "dist/verified/generated/storage.js"), "\n// changed\n");
    rejected(dir, "Bundled verified artifact differs");
  });
  it("rejects a bundle that loads the prover", () => {
    const dir = fixture();
    fs.appendFileSync(path.join(dir, "dist/extension-bootstrap.js"), '\nimport("gdp-wired/machine");\n');
    rejected(dir, "Published bundle loads the gdp-wired prover");
  });
  it("rejects a stale bundled receipt", () => {
    const dir = fixture();
    fs.appendFileSync(path.join(dir, "dist/verified/generated/manifest.json"), "\n");
    rejected(dir, "Bundled verified artifact receipt differs from source");
  });
});
