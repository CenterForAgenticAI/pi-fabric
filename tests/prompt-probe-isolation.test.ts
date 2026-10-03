import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { isolatedSpawn } from "./fixtures/prompt-probe-sandbox.mjs";

describe("isolated public RPC fixture contract", () => {
  it.skipIf(process.platform !== "linux")("denies socket creation and inherited credentials in the actual sandbox", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pr2-isolation-"));
    for (const dir of ["agent", "tmp"]) fs.mkdirSync(path.join(root, dir));
    vi.stubEnv("OPENAI_API_KEY", "SYNTHETIC_INHERITED_KEY");
    const outside = `${root}-synthetic-account`;
    fs.writeFileSync(outside, "SYNTHETIC_NONSECRET_ACCOUNT");
    try {
      const result = isolatedSpawn(root, process.execPath, ["--input-type=module", "-e", `
        import assert from 'node:assert/strict';
        import net from 'node:net';
        import fs from 'node:fs';
        import dgram from 'node:dgram';
        import { spawnSync } from 'node:child_process';
        assert.equal(process.env.OPENAI_API_KEY, undefined);
        assert.equal(process.env.NODE_OPTIONS, undefined);
        assert.equal(process.env.HOME, process.env.PROMPT_PROBE_ROOT);
        assert.deepEqual(fs.readdirSync(process.env.PI_CODING_AGENT_DIR), []);
        assert.equal(fs.existsSync(process.env.HOME + '-synthetic-account'), false);
        const server = net.createServer();
        await new Promise((resolve, reject) => {
          server.once('error', error => error.code === 'EPERM' ? resolve() : reject(error));
          server.once('listening', () => { server.close(); reject(new Error('socket creation permitted')); });
          server.listen(0, '127.0.0.1');
        });
        const udp = dgram.createSocket('udp4');
        await new Promise((resolve, reject) => {
          udp.once('error', error => { udp.close(); error.code === 'EPERM' ? resolve() : reject(error); });
          udp.once('listening', () => { udp.close(); reject(new Error('UDP socket creation permitted')); });
          udp.bind(0, '127.0.0.1');
        });
        const child = spawnSync(process.execPath, ['-e', "require('node:net').createServer().listen(0, '127.0.0.1')"], {encoding: 'utf8'});
        assert.notEqual(child.status, 0);
        assert.match(child.stderr, /EPERM/);
        console.log('socket-denied; credentials-empty; child-filter-inherited');
      `]);
      expect(result.status, result.stderr || result.error?.message).toBe(0);
      expect(result.stdout).toContain("socket-denied; credentials-empty; child-filter-inherited");
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(outside, { force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it("requires real isolated public RPC proof on the Linux CI job", () => {
    const workflow = fs.readFileSync(".github/workflows/test.yml", "utf8");
    expect(workflow).toContain("PI_FABRIC_REQUIRE_RPC_ISOLATION: '1'");
    expect(workflow).toContain("bunx vitest run tests/worker-prompt-rpc.test.ts");
  });
});
