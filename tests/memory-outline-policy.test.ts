import { describe, expect, it } from "vitest";
import { schemaRefAllowedInEnforce } from "../src/schema/policy.js";
import { isSpeculationEligible } from "../src/speculation/eligibility.js";

describe("memory outline read policy", () => {
  it("has the same enforce and speculation treatment as other memory reads", () => {
    for (const ref of ["memory.recall", "memory.expand", "memory.outline", "memory.sessions"]) {
      expect(schemaRefAllowedInEnforce(ref)).toBe(true);
      expect(isSpeculationEligible({ ref, provider: "memory", risk: "read", effectKind: "none" }, [])).toBe(true);
      expect(isSpeculationEligible({ ref, provider: "memory", risk: "write", effectKind: "none" }, [])).toBe(false);
      expect(isSpeculationEligible({ ref, provider: "memory", risk: "read", effectKind: "emission" }, [])).toBe(false);
    }
  });
});
