import fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("isolated public RPC fixture contract", () => {
  it("creates a user namespace before the network namespace (CAP_NET_ADMIN for loopback)", () => {
    const fixture = fs.readFileSync("tests/fixtures/prompt-probe-pi.mjs", "utf8");
    expect(fixture).toContain('"--unshare-user", "--unshare-net"');
  });
  it("requires real isolated public RPC proof on the Linux CI job", () => {
    const workflow = fs.readFileSync(".github/workflows/test.yml", "utf8");
    expect(workflow).toContain("PI_FABRIC_REQUIRE_RPC_ISOLATION: '1'");
    expect(workflow).toContain("bunx vitest run tests/worker-prompt-rpc.test.ts");
  });
});
