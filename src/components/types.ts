import type {
  FabricCommittedCapabilityView,
  FabricEffectKind,
  FabricEffectOrdering,
  FabricInvocationContext,
  FabricProvider,
} from "../protocol.js";

export type FabricComponentGuarantee = "managed" | "revertible";

export interface FabricCapabilityRequirement {
  ref: string;
  optional?: boolean;
}

export interface FabricComponentProvision {
  provider: string;
}

export type FabricComponentDisposer = () => void | Promise<void>;

export type FabricModelGuidanceTarget = "main" | "participant";
export type FabricModelGuidancePlacement = "append" | "replace";

export interface FabricModelGuidance {
  label: string;
  models: readonly string[];
  content: string;
  targets?: readonly FabricModelGuidanceTarget[];
  placement?: FabricModelGuidancePlacement;
  slot?: string;
}

type FabricComponentEffectValue =
  | void
  | FabricComponentDisposer
  | Iterable<FabricComponentDisposer, void, void>
  | AsyncIterable<FabricComponentDisposer, void, void>;

export type FabricComponentEffect =
  | FabricComponentEffectValue
  | Promise<FabricComponentEffectValue>;

export interface FabricComponentEffectOptions {
  label?: string;
  kind?: FabricEffectKind;
  resources?: readonly string[];
  ordering?: FabricEffectOrdering;
}

export type FabricComponentEffectRegistration = string | FabricComponentEffectOptions;

export interface FabricComponentDefinition<TConfig = unknown> {
  name: string;
  description?: string;
  /** JSON Schema for instance config, validated before any activation or replacement. */
  configSchema?: Record<string, unknown>;
  requires?: readonly (string | FabricCapabilityRequirement)[];
  provides?: readonly (string | FabricComponentProvision)[];
  guarantee?: FabricComponentGuarantee;
  activate(
    context: FabricComponentContext,
    config: TConfig,
  ): FabricComponentEffect;
}

export interface FabricComponentProviderLease {
  readonly bindingId: string;
  readonly name: string;
  readonly generation: number;
  readonly active: boolean;
  retire(): void;
  release(): Promise<void>;
}

export interface FabricComponentChildOptions<TConfig = unknown> {
  id?: string;
  config?: TConfig;
}

export interface FabricComponentStopOptions {
  force?: boolean;
}

export interface FabricComponentHandle {
  readonly id: string;
  status(): FabricComponentInfo;
  stop(options?: FabricComponentStopOptions): Promise<void>;
}

export interface FabricComponentContext {
  readonly id: string;
  readonly signal: AbortSignal;
  readonly view: FabricCommittedCapabilityView;
  readonly invocation: FabricInvocationContext;
  effect(
    setup: () => FabricComponentEffect,
    registration?: FabricComponentEffectRegistration,
  ): Promise<FabricComponentDisposer>;
  defer(
    disposer: FabricComponentDisposer,
    registration?: FabricComponentEffectRegistration,
  ): FabricComponentDisposer;
  provide(provider: FabricProvider): FabricComponentProviderLease;
  guide(guidance: FabricModelGuidance): FabricComponentDisposer;
  use<TConfig = unknown>(
    definition: FabricComponentDefinition<TConfig>,
    options?: FabricComponentChildOptions<TConfig>,
  ): FabricComponentHandle;
  acquire<T = unknown>(ref: string, args?: Record<string, unknown>): Promise<T>;
  call(ref: string, args?: Record<string, unknown>): Promise<unknown>;
}

export type FabricComponentState =
  | "waiting"
  | "loading"
  | "active"
  | "unloading"
  | "failed"
  | "quarantined"
  | "disposed";

export interface FabricComponentEntry {
  id: string;
  component: string;
  config?: unknown;
  disabled?: boolean;
}

export interface FabricComponentEffectInfo {
  label: string;
  kind: FabricEffectKind;
  resources: string[];
  ordering: FabricEffectOrdering;
}

export interface FabricModelGuidanceInfo {
  label: string;
  models: string[];
  targets: FabricModelGuidanceTarget[];
  placement: FabricModelGuidancePlacement;
  slot?: string;
  contentChars: number;
  contentHash: string;
}

export interface FabricComponentEffectConflict {
  withComponent: string;
  resources: string[];
  reason: "shared_resource" | "unknown_resource";
}

export interface FabricComponentInfo {
  id: string;
  component: string;
  parentId?: string;
  state: FabricComponentState;
  guarantee: FabricComponentGuarantee;
  requirements: string[];
  provisions: string[];
  missing: string[];
  optionalMissing: string[];
  effects?: FabricComponentEffectInfo[];
  effectConflicts?: FabricComponentEffectConflict[];
  guidance?: FabricModelGuidanceInfo[];
  targetDigest?: string;
  error?: string;
  cleanupErrors?: string[];
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface FabricComponentGraph {
  components: FabricComponentInfo[];
  edges: Array<{
    from: string;
    to: string;
    ref: string;
    kind?: "dependency" | "ownership";
  }>;
  cycles: string[][];
}

export interface FabricComponentRegistration {
  version: 1;
  component: FabricComponentDefinition;
  overwrite?: boolean;
}

export interface FabricComponentDiscovery {
  version: 1;
  register(
    component: FabricComponentDefinition,
    options?: { overwrite?: boolean },
  ): void;
}
