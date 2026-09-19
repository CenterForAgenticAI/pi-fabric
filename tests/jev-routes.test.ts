import { describe, expect, it } from "vitest";
import { isJevApprovalModel, normalizeJevApprovalModel, parseJevApprovalModel } from "../src/jev/model-key.js";
import {
  JEV_OPENROUTER_MODELS,
  JEV_OPENROUTER_ROUTE,
  JEV_TYPESAFE_MODELS,
  JEV_TYPESAFE_ROUTE,
  isJevOpenRouterModelId,
  jevClassifierModels,
  resolveJevClassifierTarget,
  resolveJevModelRoute,
  resolveJevUpstreamModel,
} from "../src/jev/routes.js";

describe("Jev route selection", () => {
  it("keeps legacy keys canonical and parses both classifier prefixes", () => {
    expect(normalizeJevApprovalModel("jev/jev-latest")).toBe("pi-fabric/typesafe/jev-latest");
    expect(parseJevApprovalModel("pi-fabric/typesafe/jev-1.13")).toEqual({ route: "typesafe", model: "jev-1.13" });
    expect(parseJevApprovalModel("pi-fabric/openrouter/jev-latest")).toEqual({ route: "openrouter", model: "jev-latest" });
    expect(parseJevApprovalModel("anthropic/claude")).toBeUndefined();
    expect(isJevApprovalModel("pi-fabric/openrouter/~typesafe/jev-latest")).toBe(true);
    expect(isJevApprovalModel("pi-fabric/openrouter/")).toBe(true);
  });

  it("routes raw model ids: bare aliases direct, decisions ids to OpenRouter", () => {
    expect(resolveJevModelRoute("jev-latest")).toMatchObject({ route: JEV_TYPESAFE_ROUTE, model: "jev-latest" });
    expect(resolveJevModelRoute("jev-preview")).toMatchObject({ route: JEV_TYPESAFE_ROUTE, model: "jev-preview" });
    expect(resolveJevModelRoute("typesafe/jev-1.13")).toMatchObject({ route: JEV_OPENROUTER_ROUTE, model: "typesafe/jev-1.13" });
    expect(resolveJevModelRoute("~typesafe/jev-latest")).toMatchObject({ route: JEV_OPENROUTER_ROUTE, model: "~typesafe/jev-latest" });
    expect(isJevOpenRouterModelId("typesafe/jev-1.13-20260917")).toBe(true);
    expect(isJevOpenRouterModelId("openrouter/typesafe/jev-1.13")).toBe(false);
  });

  it("maps aliases per route and rejects cross-route overrides", () => {
    expect(resolveJevUpstreamModel(JEV_OPENROUTER_ROUTE, "jev-latest")).toBe("~typesafe/jev-latest");
    expect(resolveJevUpstreamModel(JEV_OPENROUTER_ROUTE, "typesafe/jev-1.13")).toBe("typesafe/jev-1.13");
    expect(resolveJevUpstreamModel(JEV_OPENROUTER_ROUTE, "jev-preview")).toBeUndefined();
    expect(resolveJevUpstreamModel(JEV_TYPESAFE_ROUTE, "~typesafe/jev-latest")).toBeUndefined();
    expect(resolveJevUpstreamModel(JEV_TYPESAFE_ROUTE, "jev-1.13.0")).toBe("jev-1.13.0");
  });

  it("resolves classifier targets and lists offered aliases without duplicates", () => {
    expect(resolveJevClassifierTarget("pi-fabric/typesafe/jev-preview")).toMatchObject({ ok: true, route: JEV_TYPESAFE_ROUTE, model: "jev-preview" });
    expect(resolveJevClassifierTarget("pi-fabric/openrouter/jev-1.13")).toMatchObject({ ok: true, route: JEV_OPENROUTER_ROUTE, model: "typesafe/jev-1.13" });
    expect(resolveJevClassifierTarget("pi-fabric/openrouter/typesafe/jev-1.13")).toMatchObject({ ok: true, model: "typesafe/jev-1.13" });
    expect(resolveJevClassifierTarget("pi-fabric/openrouter/jev-preview")).toMatchObject({ ok: false });
    const keys = jevClassifierModels("typesafe/jev-1.13").map(model => `${model.provider}/${model.id}`);
    expect(keys).toEqual([
      "pi-fabric/typesafe/jev-latest", "pi-fabric/typesafe/jev-1.13", "pi-fabric/typesafe/jev-1.13.0", "pi-fabric/typesafe/jev-preview",
      "pi-fabric/openrouter/jev-latest", "pi-fabric/openrouter/jev-1.13", "pi-fabric/openrouter/typesafe/jev-1.13",
    ]);
    expect(new Set(keys).size).toBe(keys.length);
    expect(JEV_TYPESAFE_MODELS).toEqual(["jev-latest", "jev-1.13", "jev-1.13.0", "jev-preview"]);
    expect(Object.keys(JEV_OPENROUTER_MODELS)).toEqual(["jev-latest", "jev-1.13"]);
    expect(JEV_TYPESAFE_ROUTE.envKeys).toEqual(["TYPESAFE_API_KEY"]);
    expect(JEV_OPENROUTER_ROUTE.envKeys).toEqual(["OPENROUTER_API_KEY", "TYPESAFE_OPENROUTER_API_KEY"]);
  });
});
