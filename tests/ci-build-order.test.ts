import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

describe("CI build prerequisites", () => {
  it("builds the published workers before every test step", () => {
    const workflow = parse(fs.readFileSync(fileURLToPath(new URL("../.github/workflows/test.yml", import.meta.url)), "utf8"));
    const steps = workflow.jobs.check.steps as Array<{ name?: string; run?: string }>;
    const build = steps.findIndex((step) => step.run === "bun run build");
    const tests = steps.flatMap((step, index) => /^(bunx vitest|bun run test:)/.test(step.run ?? "") ? [index] : []);
    expect(build).toBeGreaterThanOrEqual(0);
    expect(tests.length).toBeGreaterThan(0);
    for (const index of tests) expect(build, `build must precede ${steps[index]!.name}`).toBeLessThan(index);
  });
});
