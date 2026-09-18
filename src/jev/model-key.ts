/** Fabric classifier keys, not Pi chat-provider or upstream TypeSafe model IDs. */
export const JEV_APPROVAL_MODEL_PREFIX = "pi-fabric/typesafe/";

/** Keep saved pre-namespace overrides usable without moving /login jev credentials. */
export const normalizeJevApprovalModel = (key: string | undefined): string | undefined =>
  key?.startsWith("jev/") ? `${JEV_APPROVAL_MODEL_PREFIX}${key.slice(4)}` : key;

export const isJevApprovalModel = (key: string | undefined): boolean =>
  normalizeJevApprovalModel(key)?.startsWith(JEV_APPROVAL_MODEL_PREFIX) ?? false;
