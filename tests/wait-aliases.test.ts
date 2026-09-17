import { readFileSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import { ActionRegistry } from "../src/core/action-registry.js";
import { FabricExecutionService } from "../src/execution-service.js";
import { projectFabricAuditArgs } from "../src/audit/projection.js";
import { AGENTS_ACTION_DESCRIPTORS } from "../src/providers/agents-actions.js";
import { JEV_ACTION_DESCRIPTORS } from "../src/providers/jev-provider.js";
import { agentServiceDescriptors } from "../src/agents/service-schema.js";
import { QuickJsRuntime } from "../src/runtime/quickjs-runtime.js";
import { NodeProcessRuntime } from "../src/runtime/node-process-runtime.js";
import { MontyRuntime } from "../src/runtime/monty-runtime.js";
import { guestTypeDeclarations } from "../src/runtime/guest-types.js";
import { typeCheckFabricCode } from "../src/runtime/type-checker.js";

const refs = ["agents.wait", "agents.join", "jev.wait", "jev.join"];
const typescript = `return Promise.all([
  agents.wait({id: 'a'}), agents.join({id: 'a'}),
  jev.wait<number>({id: 'j'}), jev.join<number>({id: 'j'}),
  ...${JSON.stringify(refs)}.map(ref => tools.call({ref, args: {id: 'generic'}})),
]);`;
const python = `results = [
  await agents.wait(id="a"), await agents.join(id="a"),
  await tools.call(ref="jev.wait", args={"id": "j"}), await tools.call(ref="jev.join", args={"id": "j"}),
]
for ref in ${JSON.stringify(refs)}:
    results.append(await tools.call(ref=ref, args={"id": "generic"}))
return results`;
const montyAvailable = await import("@pydantic/monty/node").then(() => true, () => false);

describe("wait is canonical and join is an equivalent alias", () => {
  it.each(["typescript", "python"])("documents canonical wait and both join aliases in the %s skills", (kernel) => {
    for (const relative of ["fabric-exec/SKILL.md", "fabric-jev/SKILL.md", "fabric-exec/references/agents.md"]) {
      const text = readFileSync(`skillsets/${kernel}/${relative}`, "utf8");
      expect(text).toContain("canonical");
      for (const ref of refs) expect(text, `${relative}: ${ref}`).toContain(ref);
    }
  });

  it("publishes identical argument schemas and risks for each provider pair", () => {
    for (const descriptors of [AGENTS_ACTION_DESCRIPTORS, JEV_ACTION_DESCRIPTORS, agentServiceDescriptors()]) {
      const wait = descriptors.find(d => d.name === "wait")!;
      const join = descriptors.find(d => d.name === "join")!;
      expect(wait).toBeDefined();
      expect(join.description).toContain("Alias for");
      expect(join.inputSchema).toEqual(wait.inputSchema);
      expect(join.risk).toBe(wait.risk);
      expect(join.effect).toEqual(wait.effect);
    }
    expect(typeCheckFabricCode(typescript, guestTypeDeclarations(true)).errors).toEqual([]);
  });

  it("projects agents.join metadata like agents.wait without retaining extra arguments", () => {
    const args = {id: "agent-123", message: "not a wait argument"};
    const waited = projectFabricAuditArgs("agents.wait", args);
    expect(projectFabricAuditArgs("agents.join", args)).toEqual(waited);
    expect(waited.value).toEqual({id: "agent-123"});
  });

  for (const backend of ["quickjs", "node", "bun", "monty"] as const) {
    it.skipIf(backend === "monty" && !montyAvailable)(`supports both names through ${backend} direct/generic guest calls`, async () => {
      const runtime = backend === "quickjs" ? new QuickJsRuntime() : backend === "monty" ? new MontyRuntime() : new NodeProcessRuntime(backend);
      const result = await runtime.execute(backend === "monty" ? python : typescript, async (rawRef, rawArgs) => {
        const ref = rawRef === "fabric.$call" ? rawArgs.ref as string : rawRef;
        const args = rawRef === "fabric.$call" ? rawArgs.args as Record<string, unknown> : rawArgs;
        expect(refs).toContain(ref);
        return {ref, id: args.id};
      }, {timeoutMs: 10000, memoryLimitBytes: 64 * 1024 * 1024});
      expect(result.terminationReason, result.error).toBe("completed");
      expect(result.value).toEqual([
        ...refs.map((ref, index) => ({ref, id: index < 2 ? "a" : "j"})),
        ...refs.map(ref => ({ref, id: "generic"})),
      ]);
    });
  }

  it.each(["agents", "jev"])("extends the outer deadline for computed wait/join refs on %s", async (provider) => {
    const registry = new ActionRegistry();
    const descriptors = ["wait", "join"].map(name => ({
      name, description: "blocking fixture", risk: "read" as const,
      inputSchema: {type: "object", properties: {id: {type: "string"}}, required: ["id"], additionalProperties: false},
    }));
    registry.register({
      name: provider, description: "blocking fixture",
      async list() { return descriptors; },
      async describe(name) { return descriptors.find(d => d.name === name); },
      async invoke(_name, args) {
        await new Promise(resolve => setTimeout(resolve, 250));
        return {id: args.id};
      },
    });
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.fullCodeMode = false;
    config.approvals.read = "allow";
    config.executor.timeoutMs = 100;
    config.agents.timeoutMs = 5000;
    const service = new FabricExecutionService(registry, config);
    const result = await service.execute({
      code: `const provider = ${JSON.stringify(provider)}; return Promise.all(["wait", "join"].map(name => tools.call({ref: provider + "." + name, args: {id: name}})));`,
      signal: undefined, parentToolCallId: "wait-alias-deadline",
      context: {cwd: process.cwd(), hasUI: false} as ExtensionContext,
      onPartial() {},
    });
    expect(result.success, result.error).toBe(true);
    expect(result.value).toEqual([{id: "wait"}, {id: "join"}]);
  });
});
