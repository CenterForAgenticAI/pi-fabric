import { describe, expect, it } from "vitest";
import {
  inheritedSessionPinEnvironment,
  inheritedSessionPinsFromEntries,
  inheritedSessionPinsFromEnv,
  inheritedSessionPinsFromUnknown,
  MULTIPROVIDER_SESSION_PIN_ENTRY_TYPE,
  MULTIPROVIDER_SESSION_PIN_ENV,
  resolveInheritedSessionPins,
  serializeInheritedSessionPins,
  withInheritedSessionPins,
} from "../src/agents/session-pins.js";

const entry = (data: unknown, customType = MULTIPROVIDER_SESSION_PIN_ENTRY_TYPE) => ({
  type: "custom" as const,
  customType,
  data,
});

describe("inherited session pins", () => {
  it("keeps the latest /switch-account decision per pool and drops foreign entries", () => {
    expect(inheritedSessionPinsFromEntries([
      { type: "message", id: "m1" },
      entry({ pool: "anthropic", key: "parent-session", accountId: "work", label: "Work" }),
      entry({ pool: "anthropic", key: "parent-session", accountId: "personal", label: "Personal" }),
      entry({ pool: "openai", key: "parent-session" }),
      entry({ pool: "other", accountId: "x" }, "other-extension:pin"),
      entry({ pool: "", accountId: "nope" }),
    ])).toEqual([
      { pool: "anthropic", accountId: "personal", label: "Personal" },
      { pool: "openai" },
    ]);
  });

  it("prefers the parent session journal over an inherited environment payload", () => {
    const env = {
      [MULTIPROVIDER_SESSION_PIN_ENV]: serializeInheritedSessionPins([
        { pool: "anthropic", accountId: "env-account", label: "Env" },
      ]),
    };
    expect(resolveInheritedSessionPins([
      entry({ pool: "anthropic", key: "parent", accountId: "session-account", label: "Session" }),
    ], env)).toEqual([
      { pool: "anthropic", accountId: "session-account", label: "Session" },
    ]);
    expect(resolveInheritedSessionPins([], env)).toEqual([
      { pool: "anthropic", accountId: "env-account", label: "Env" },
    ]);
    expect(resolveInheritedSessionPins([], { [MULTIPROVIDER_SESSION_PIN_ENV]: "{" })).toBeUndefined();
  });

  it("does not let an existing request pin be overwritten, and ignores malformed env", () => {
    const request = { task: "x", inheritedSessionPins: [{ pool: "anthropic", accountId: "kept" }] };
    expect(withInheritedSessionPins(request, [
      entry({ pool: "anthropic", accountId: "other" }),
    ])).toBe(request);
    expect(inheritedSessionPinsFromUnknown("nope")).toEqual([]);
    expect(inheritedSessionPinsFromEnv({ [MULTIPROVIDER_SESSION_PIN_ENV]: "[]" })).toEqual([]);
    expect(inheritedSessionPinEnvironment([{ pool: "anthropic", accountId: "work" }])).toEqual({
      [MULTIPROVIDER_SESSION_PIN_ENV]: '[{"pool":"anthropic","accountId":"work"}]',
    });
  });
});
