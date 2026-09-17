import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { JevObservationHost } from "../src/jev/observation.js";
import type { JevLaunch, JevRunInfo } from "../src/jev/types.js";
import { QuickJsRuntime } from "../src/runtime/quickjs-runtime.js";
import { MontyRuntime } from "../src/runtime/monty-runtime.js";
import { jevContext, setupJev } from "./jev-test-helpers.js";

const montyAvailable = await import("@pydantic/monty/node").then(() => true, () => false);
type Kernel = "typescript" | "python";
const example = (kernel: Kernel) => {
  const text = readFileSync(`skillsets/${kernel}/fabric-jev/SKILL.md`, "utf8");
  const section = text.split("## Event-driven Main-turn advisor")[1]!;
  const code = section.match(kernel === "typescript" ? /```ts\r?\n([\s\S]*?)\r?\n```/ : /```python\r?\n([\s\S]*?)\r?\n```/)?.[1];
  if (!code) throw new Error(`Missing ${kernel} observer example`);
  return code;
};
const execute = async (kernel: Kernel, host: (ref: string, args: Record<string, unknown>) => Promise<unknown>) => {
  const runtime = kernel === "typescript" ? new QuickJsRuntime() : new MontyRuntime();
  const result = await runtime.execute(example(kernel), (ref, args) => host(
    ref === "fabric.$call" ? args.ref as string : ref,
    ref === "fabric.$call" ? args.args as Record<string, unknown> : args,
  ), { timeoutMs: 15000, memoryLimitBytes: 64 * 1024 * 1024 });
  expect(result.terminationReason, result.error).toBe("completed");
  return result.value as { id: string; state: string };
};

for (const kernel of ["typescript", "python"] as const) {
  describe.skipIf(kernel === "python" && !montyAvailable)(`${kernel} observer skill`, () => {
    it.each([0.1, 0.99])("runs the published example against a synthetic judgment of %s", async probability => {
      const delivered: unknown[] = [];
      const observationHost = new JevObservationHost("jev-test-session", advice => delivered.push(advice));
      const requests: unknown[] = [];
      const fetcher = (async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({model:"jev-latest", answers:{contradiction:{type:"noul",noul:probability}}, usage:{input_tokens:4,output_tokens:1}}));
      }) as typeof fetch;
      const { provider } = setupJev({approvals:{agent:"allow",network:"allow",execute:"allow",read:"allow"}}, fetcher, undefined, observationHost);
      try {
        const run = await execute(kernel, async (ref, args) => {
          expect(ref).toBe("jev.spawn");
          // Preserve the documented artifact and terminate it via its public lifecycle.
          return provider.invoke("spawn", args, jevContext());
        });
        expect(run.state).toBe("running");
        expect(requests).toHaveLength(0);
        observationHost.observe("turn_end", { turnIndex:1, message:{role:"assistant",content:[{type:"text",text:"The work is complete."}]}, toolResults:[{toolName:"test",isError:true,content:[{type:"text",text:"Test failed."}]}] }, {sessionId:"jev-test-session"});
        await expect.poll(() => provider.manager.status(run.id).events.length).toBe(1);
        const status = provider.manager.status(run.id);
        expect(status.evaluations).toBe(1);
        expect(delivered).toHaveLength(probability >= 0.9 ? 1 : 0);
        expect(status.events[0]?.value).toMatchObject({probability,advice:probability >= 0.9 ? {delivered:true} : null});
        expect(requests).toHaveLength(1);
        expect((await provider.invoke("stop", {id:run.id}, jevContext()) as JevRunInfo).state).toBe("cancelled");
        expect(observationHost.size).toBe(0);
      } finally { observationHost.close(); await provider.close(); }
    }, 20000);
  });
}

it.skipIf(!montyAvailable)("uses identical observer artifacts and options from both kernels", async () => {
  const launches: JevLaunch[] = [];
  for (const kernel of ["typescript", "python"] as const) {
    await execute(kernel, async (_ref, args) => {
      launches.push(args as unknown as JevLaunch);
      return {id:"fixture",state:"running"};
    });
  }
  expect(launches[1]).toEqual(launches[0]);
});
