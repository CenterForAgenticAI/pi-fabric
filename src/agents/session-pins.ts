export const MULTIPROVIDER_SESSION_PIN_ENTRY_TYPE = "pi-multiprovider:switch-account";
export const MULTIPROVIDER_SESSION_PIN_ENV = "PI_MULTIPROVIDER_SESSION_PINS";

/** Parent /switch-account decision rebound onto a child session. */
export interface InheritedSessionPin {
  pool: string;
  /** Pinned account; omitted means an explicit return to automatic selection. */
  accountId?: string;
  label?: string;
}

const inheritedPinFromRecord = (value: unknown): InheritedSessionPin | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const pool = typeof record.pool === "string" ? record.pool.trim() : "";
  if (!pool) return undefined;
  const accountId = typeof record.accountId === "string" ? record.accountId.trim() : undefined;
  if (record.accountId !== undefined && !accountId) return undefined;
  const label = typeof record.label === "string" && record.label.trim() !== ""
    ? record.label
    : undefined;
  return {
    pool,
    ...(accountId === undefined ? {} : { accountId }),
    ...(label === undefined ? {} : { label }),
  };
};

/** Latest inherited pin per pool; foreign and malformed records are dropped. */
export const inheritedSessionPinsFromUnknown = (value: unknown): InheritedSessionPin[] => {
  if (!Array.isArray(value)) return [];
  const latest = new Map<string, InheritedSessionPin>();
  for (const item of value) {
    const pin = inheritedPinFromRecord(item);
    if (!pin) continue;
    latest.set(pin.pool, pin);
  }
  return [...latest.values()];
};

export const inheritedSessionPinsFromEntries = (entries: Iterable<unknown>): InheritedSessionPin[] => {
  const latest = new Map<string, InheritedSessionPin>();
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const candidate = entry as { type?: unknown; customType?: unknown; data?: unknown };
    if (candidate.type !== "custom" || candidate.customType !== MULTIPROVIDER_SESSION_PIN_ENTRY_TYPE) {
      continue;
    }
    const pin = inheritedPinFromRecord(candidate.data);
    if (!pin) continue;
    latest.set(pin.pool, pin);
  }
  return [...latest.values()];
};

export const inheritedSessionPinsFromEnv = (
  env: NodeJS.ProcessEnv = process.env,
): InheritedSessionPin[] => {
  const raw = env[MULTIPROVIDER_SESSION_PIN_ENV];
  if (typeof raw !== "string" || raw.trim() === "") return [];
  try {
    return inheritedSessionPinsFromUnknown(JSON.parse(raw) as unknown);
  } catch {
    return [];
  }
};

export const serializeInheritedSessionPins = (pins: readonly InheritedSessionPin[]): string =>
  JSON.stringify(inheritedSessionPinsFromUnknown(pins));

/**
 * Session journal wins when the parent recorded a /switch-account decision.
 * Otherwise a nested Fabric child reuses PI_MULTIPROVIDER_SESSION_PINS.
 */
export const resolveInheritedSessionPins = (
  entries: Iterable<unknown> = [],
  env: NodeJS.ProcessEnv = process.env,
): InheritedSessionPin[] | undefined => {
  const fromSession = inheritedSessionPinsFromEntries(entries);
  if (fromSession.length > 0) return fromSession;
  const fromEnv = inheritedSessionPinsFromEnv(env);
  return fromEnv.length > 0 ? fromEnv : undefined;
};

export const withInheritedSessionPins = <T extends { inheritedSessionPins?: InheritedSessionPin[] }>(
  request: T,
  entries: Iterable<unknown>,
  env: NodeJS.ProcessEnv = process.env,
): T => {
  if (request.inheritedSessionPins && request.inheritedSessionPins.length > 0) return request;
  const pins = resolveInheritedSessionPins(entries, env);
  return pins ? { ...request, inheritedSessionPins: pins } : request;
};

export const inheritedSessionPinEnvironment = (
  pins: InheritedSessionPin[] | undefined,
): Record<string, string> => {
  if (!pins || pins.length === 0) return {};
  return { [MULTIPROVIDER_SESSION_PIN_ENV]: serializeInheritedSessionPins(pins) };
};
