import {
  JEV_OPENROUTER_MODEL_PREFIX,
  JEV_TYPESAFE_MODEL_PREFIX,
  parseJevApprovalModel,
  type JevClassifierRoute,
} from "./model-key.js";

export interface JevRoute {
  readonly id: JevClassifierRoute;
  /** Human label used in host-visible errors and status. */
  readonly label: string;
  /** Fixed HTTPS endpoint receiving the typed System One request. */
  readonly endpoint: string;
  /** Pi auth provider whose auth.json login and environment keys authenticate this route. */
  readonly providerId: string;
  /** Environment fallbacks, checked when Pi provider auth is not configured. */
  readonly envKeys: readonly string[];
}

export const JEV_TYPESAFE_ROUTE: JevRoute = {
  id: "typesafe",
  label: "TypeSafe",
  endpoint: "https://api.typesafe.ai/v1/systemone",
  providerId: "jev",
  envKeys: ["TYPESAFE_API_KEY"],
};

/**
 * OpenRouter serves decisions models on its Decisions API, not chat completions.
 * The user's existing openrouter auth (`/login openrouter`, `OPENROUTER_API_KEY`)
 * is the primary credential; `TYPESAFE_OPENROUTER_API_KEY` is an explicit fallback.
 */
export const JEV_OPENROUTER_ROUTE: JevRoute = {
  id: "openrouter",
  label: "OpenRouter",
  endpoint: "https://openrouter.ai/api/alpha/decisions",
  providerId: "openrouter",
  envKeys: ["OPENROUTER_API_KEY", "TYPESAFE_OPENROUTER_API_KEY"],
};

const jevRouteById = (id: JevClassifierRoute): JevRoute =>
  id === "openrouter" ? JEV_OPENROUTER_ROUTE : JEV_TYPESAFE_ROUTE;

/** Direct TypeSafe aliases. All of them resolve to `jev-1.13.0` today. */
export const JEV_TYPESAFE_MODELS: readonly string[] = ["jev-latest", "jev-1.13", "jev-1.13.0", "jev-preview"];

/** OpenRouter decisions model IDs by alias. OpenRouter has no `jev-preview` alias. */
export const JEV_OPENROUTER_MODELS: Readonly<Record<string, string>> = {
  "jev-latest": "~typesafe/jev-latest",
  "jev-1.13": "typesafe/jev-1.13",
};

const TYPESAFE_MODEL = /^[a-zA-Z0-9._-]{1,128}$/;
/** OpenRouter decisions IDs are `~typesafe/<family>` or `typesafe/<build>`. */
export const isJevOpenRouterModelId = (model: string): boolean =>
  /^~?typesafe\/[a-zA-Z0-9._-]{1,120}$/.test(model);
/** A bare TypeSafe alias or a routable OpenRouter decisions ID. */
export const isJevModelId = (model: string): boolean =>
  TYPESAFE_MODEL.test(model) || isJevOpenRouterModelId(model);

export interface JevRouteTarget {
  readonly route: JevRoute;
  readonly model: string;
}

/** Route and upstream model ID for a raw `jev.model` value. */
export const resolveJevModelRoute = (model: string): JevRouteTarget =>
  isJevOpenRouterModelId(model)
    ? { route: JEV_OPENROUTER_ROUTE, model }
    : { route: JEV_TYPESAFE_ROUTE, model };

/** Upstream model ID for an alias or override on an already-selected route. */
export const resolveJevUpstreamModel = (route: JevRoute, model: string): string | undefined => {
  if (route.id === "openrouter") {
    return JEV_OPENROUTER_MODELS[model] ?? (isJevOpenRouterModelId(model) ? model : undefined);
  }
  return TYPESAFE_MODEL.test(model) ? model : undefined;
};

export type JevClassifierTarget =
  | { readonly ok: true; readonly route: JevRoute; readonly model: string }
  | { readonly ok: false; readonly message: string };

/** Route and upstream model ID for a stored `pi-fabric/<route>/<model>` approvals key. */
export const resolveJevClassifierTarget = (key: string): JevClassifierTarget => {
  const parsed = parseJevApprovalModel(key);
  if (!parsed) {
    return {
      ok: false,
      message: `Invalid Jev auto-approval model; use ${JEV_TYPESAFE_MODEL_PREFIX}<model-id> or ${JEV_OPENROUTER_MODEL_PREFIX}<model-id>`,
    };
  }
  const route = jevRouteById(parsed.route);
  const model = resolveJevUpstreamModel(route, parsed.model);
  if (model) return { ok: true, route, model };
  return {
    ok: false,
    message: route.id === "openrouter"
      ? `OpenRouter serves ${Object.keys(JEV_OPENROUTER_MODELS).join(", ")}; "${parsed.model}" is not available`
      : `Invalid Jev auto-approval model; use ${JEV_TYPESAFE_MODEL_PREFIX}<model-id>`,
  };
};

export interface JevClassifierPickerModel {
  readonly provider: "pi-fabric";
  readonly id: string;
  readonly name: string;
}

/** Approvals picker entries: every supported classifier key plus the configured model. */
export const jevClassifierModels = (configuredModel?: string): JevClassifierPickerModel[] => {
  const configured = configuredModel ? resolveJevModelRoute(configuredModel) : undefined;
  const typesafe = new Set(JEV_TYPESAFE_MODELS);
  if (configured?.route.id === "typesafe" && configuredModel) typesafe.add(configuredModel);
  const openrouter = new Set(Object.keys(JEV_OPENROUTER_MODELS));
  if (configured?.route.id === "openrouter" && configuredModel) openrouter.add(configuredModel);
  return [
    ...[...typesafe].map((model): JevClassifierPickerModel => ({
      provider: "pi-fabric", id: `typesafe/${model}`,
      name: `Jev (TypeSafe safety classifier · ${model})`,
    })),
    ...[...openrouter].map((model): JevClassifierPickerModel => ({
      provider: "pi-fabric", id: `openrouter/${model}`,
      name: `Jev (OpenRouter safety classifier · ${model})`,
    })),
  ];
};
