import type { FabricHostPolicyV1, FabricRisk } from "../protocol.js";

/** Providers whose calls replay Pi tool_call hooks, so the host's own guards see them. */
const HOOKED_PROVIDERS: ReadonlySet<string> = new Set(["pi", "extensions"]);

export interface FabricHostPolicyAction {
  ref: string;
  provider: string;
  name: string;
  risk: FabricRisk;
}

/**
 * Accumulated host restrictions for one Fabric instance. Each applied policy is
 * enforced independently, so adding a policy can only narrow what runs.
 */
export class FabricHostPolicy {
  readonly #policies: FabricHostPolicyV1[] = [];

  get active(): boolean {
    return this.#policies.length > 0;
  }

  apply(policy: FabricHostPolicyV1): void {
    this.#policies.push(structuredClone(policy));
  }

  /** Returns the refusal message, or undefined when every policy allows the action. */
  denial(action: FabricHostPolicyAction): string | undefined {
    for (const policy of this.#policies) {
      const message = denialFor(policy, action);
      if (message) return message;
    }
    return undefined;
  }

  /** Native executors run outside every tool hook, so any policy refuses them. */
  executorDenial(): string | undefined {
    const policy = this.#policies[0];
    if (!policy) return undefined;
    return `Fabric host policy from ${policy.owner} refuses native executors (CPython, node-process, bun-process): ${policy.reason}`;
  }
}

const denialFor = (policy: FabricHostPolicyV1, action: FabricHostPolicyAction): string | undefined => {
  const prefix = `${action.ref} is refused by the Fabric host policy from ${policy.owner}`;
  if (policy.deniedProviders?.includes(action.provider)) {
    return `${prefix}: provider ${action.provider} is unavailable here (${policy.reason})`;
  }
  if (HOOKED_PROVIDERS.has(action.provider)) {
    return policy.deniedTools?.includes(action.name)
      ? `${prefix}: tool ${action.name} is unavailable here (${policy.reason})`
      : undefined;
  }
  const allowed = policy.allowedUnhookedRisks ?? ["read"];
  return allowed.includes(action.risk)
    ? undefined
    : `${prefix}: ${action.risk} actions outside pi.* and extensions.* are unavailable here (${policy.reason})`;
};
