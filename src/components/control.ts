import { stableJsonHash } from "../core/stable-hash.js";
import type { FabricComponentLoader } from "./loader.js";
import type { FabricComponentEntry } from "./types.js";
import type { ComponentConfigurationStore, ComponentConfigScope, ComponentConfigSnapshot } from "./configuration.js";
import { COMPONENT_ID_PATTERN, componentEntries } from "./validation.js";

export interface ComponentChangeRequest {
  scope?: ComponentConfigScope;
  entries?: FabricComponentEntry[];
  remove?: string[];
  reset?: string[];
}
export interface ComponentChangePlan {
  revision: string;
  request: Required<ComponentChangeRequest>;
  changes: Array<{ id: string; operation: "add" | "replace" | "remove"; component: string; requirements: string[]; provisions: string[] }>;
  warnings: string[];
  sources: ComponentConfigSnapshot["sources"];
}
interface PreparedChange {
  plan: ComponentChangePlan;
  snapshot: ComponentConfigSnapshot | undefined;
  base: FabricComponentEntry[];
  overrides: Map<string, FabricComponentEntry | null>;
  effective: FabricComponentEntry[];
  persisted: FabricComponentEntry[] | undefined;
}
const hash = (value: unknown) => stableJsonHash(value);

/** Session overlay and disk reconciliation share one transaction queue; neither reloads the host. */
export class FabricComponentControl {
  #base: FabricComponentEntry[];
  #overrides = new Map<string, FabricComponentEntry | null>();
  #snapshot: ComponentConfigSnapshot | undefined;
  #tail: Promise<void> = Promise.resolve();
  #epoch = 0;
  #closed = false;
  #error: string | undefined;

  constructor(readonly loader: FabricComponentLoader, readonly options: {
    store?: ComponentConfigurationStore;
    initialEntries?: FabricComponentEntry[];
    assertMutable?: () => void;
    applied?: (entries: FabricComponentEntry[]) => void;
  } = {}) {
    this.#base = structuredClone(options.initialEntries ?? loader.entries());
    try { this.#snapshot = options.store?.read(); }
    catch (error) { this.#error = error instanceof Error ? error.message : String(error); }
  }

  configuration() {
    return {
      sessionOverrides: [...this.#overrides.keys()].sort(),
      sources: structuredClone(this.#snapshot?.sources ?? []),
      warnings: [...(this.#snapshot?.warnings ?? [])],
      ...(this.#error ? { error: this.#error } : {}),
      removalPolicy: "drain" as const,
    };
  }

  plan(request: ComponentChangeRequest): Promise<ComponentChangePlan> {
    return this.#enqueue(() => this.#prepare(request).plan);
  }

  apply(request: ComponentChangeRequest & { expectedRevision: string }, signal?: AbortSignal) {
    return this.#enqueue(async () => {
      this.options.assertMutable?.();
      signal?.throwIfAborted();
      await this.loader.settle();
      signal?.throwIfAborted();
      const prepared = this.#prepare(request);
      if (request.expectedRevision !== prepared.plan.revision) throw new Error("Component plan is stale; call components.plan again");
      const previous = this.loader.entries();
      await this.loader.reconcile(prepared.effective);
      let snapshot = prepared.snapshot;
      try {
        // Once activation starts, finish commit or compensation even if the caller stops waiting.
        if (prepared.persisted) {
          snapshot = this.options.store!.write(prepared.plan.request.scope as "global" | "project", prepared.persisted, snapshot!.revision);
        } else if (snapshot && this.options.store!.read().revision !== snapshot.revision) {
          throw new Error("Component configuration changed during activation; plan again");
        }
      } catch (error) {
        try { await this.loader.reconcile(previous); }
        catch (rollback) { throw new AggregateError([error, rollback], "Component apply and rollback failed"); }
        throw error;
      }
      this.#base = prepared.base;
      this.#overrides = prepared.overrides;
      this.#snapshot = snapshot;
      this.#epoch++;
      this.#error = undefined;
      this.options.applied?.(structuredClone(prepared.effective));
      return { components: this.loader.list(), configuration: this.configuration(), scope: prepared.plan.request.scope };
    });
  }

  reconcile(entries?: FabricComponentEntry[]) {
    return this.#enqueue(async () => {
      this.options.assertMutable?.();
      const snapshot = this.options.store?.read();
      if (!entries && !snapshot) throw new Error("No host configuration source is available for components.reconcile");
      if (!entries && snapshot?.revision === this.#snapshot?.revision && hash(snapshot?.entries) === hash(this.#base)) {
        this.#snapshot = snapshot;
        this.#error = undefined;
        return { components: this.loader.list(), configuration: this.configuration() };
      }
      const base = componentEntries(entries ?? snapshot!.entries);
      const effective = this.#effective(base, this.#overrides);
      this.loader.validateEntries(effective);
      await this.loader.reconcile(effective);
      this.#base = base;
      this.#snapshot = snapshot;
      this.#epoch++;
      this.#error = undefined;
      this.options.applied?.(structuredClone(effective));
      return { components: this.loader.list(), configuration: this.configuration() };
    });
  }

  reload(id?: string) {
    return this.#enqueue(async () => {
      const components = await this.loader.reload(id);
      this.#epoch++;
      this.#error = undefined;
      return { components };
    });
  }

  async settle(): Promise<void> { await this.#tail; }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#tail;
  }

  #prepare(input: ComponentChangeRequest): PreparedChange {
    const scope = input.scope ?? "session";
    if (!["session", "global", "project"].includes(scope)) throw new Error("Invalid component configuration scope");
    const entries = componentEntries(input.entries ?? []);
    const ids = (values: unknown): string[] => {
      if (!Array.isArray(values) || values.length > 256 || values.some(id => typeof id !== "string" || !COMPONENT_ID_PATTERN.test(id))) throw new Error("Invalid component change IDs");
      return [...values] as string[];
    };
    const remove = ids(input.remove ?? []);
    const reset = ids(input.reset ?? []);
    const changed = [...entries.map(entry => entry.id), ...remove, ...reset];
    if (!changed.length) throw new Error("Component plan needs entries, remove, or reset");
    if (new Set(changed).size !== changed.length) throw new Error("A component may appear only once in a change request");
    const pinned = new Set(this.loader.pinnedEntries().map(entry => entry.id));
    if (changed.some(id => pinned.has(id) || id.startsWith("fabric.provider.")) || entries.some(entry => entry.component.startsWith("fabric.provider."))) throw new Error("Live component changes cannot modify reserved built-in components");
    if (scope !== "session" && reset.length) throw new Error("reset is available only for session overrides");
    const snapshot = this.options.store?.read();
    if (scope !== "session" && !snapshot) throw new Error("Persistent component configuration is unavailable in this host");
    if (scope === "project" && !snapshot!.sources.find(source => source.scope === "project")?.trusted) throw new Error("Cannot write project components in an untrusted project");
    const base = structuredClone(snapshot?.entries ?? this.#base);
    const overrides = new Map(this.#overrides);
    let nextBase = base;
    let persisted: FabricComponentEntry[] | undefined;
    if (scope === "session") {
      for (const entry of entries) overrides.set(entry.id, entry);
      for (const id of remove) overrides.set(id, null);
      for (const id of reset) overrides.delete(id);
    } else {
      const layer = scope === "global" ? snapshot!.layers.global : snapshot!.layers.project ?? snapshot!.layers.global;
      const patched = new Map(layer.map(entry => [entry.id, entry]));
      for (const entry of entries) patched.set(entry.id, entry);
      for (const id of remove) patched.delete(id);
      persisted = [...patched.values()];
      this.loader.validateEntries(persisted);
      nextBase = scope === "global" ? snapshot!.layers.project ?? persisted : persisted;
    }
    if (overrides.size > 256) throw new Error("Fabric supports at most 256 session component overrides, including removal masks");
    const effective = this.#effective(nextBase, overrides);
    this.loader.validateEntries(effective);
    const before = new Map(this.loader.entries().map(entry => [entry.id, entry]));
    const after = new Map(effective.map(entry => [entry.id, entry]));
    const definitions = this.loader.definitions();
    const changes: ComponentChangePlan["changes"] = [];
    for (const id of [...new Set([...before.keys(), ...after.keys()])].sort()) {
      const old = before.get(id), next = after.get(id);
      if (hash(old ?? null) === hash(next ?? null)) continue;
      const entry = (next ?? old)!;
      const definition = definitions.find(candidate => candidate.name === entry.component);
      changes.push({ id, operation: !next ? "remove" : old ? "replace" : "add", component: entry.component, requirements: definition?.requirements ?? [], provisions: definition?.provisions ?? [] });
    }
    const warnings = [...(snapshot?.warnings ?? [])];
    if (scope === "global" && snapshot?.layers.project) warnings.push("The project's components array shadows the global array; this write may not change live instances.");
    if (scope !== "session" && changed.some(id => overrides.has(id))) warnings.push("Session overrides remain in effect; reset those IDs in session scope to use persisted values.");
    for (const entry of effective) {
      if (!entry.disabled && !this.loader.catalog.get(entry.component)) warnings.push(`Definition ${entry.component} is unavailable; ${entry.id} will wait for registration.`);
    }
    if (changes.some(change => change.operation !== "add")) warnings.push("Replacement/removal retires the old generation; existing committed views may drain. This is not immediate revocation or rollback of issued effects.");
    const revision = hash({ epoch: this.#epoch, source: snapshot?.revision, entries: this.loader.entries(), definitions, instances: this.loader.list().map(({ id, revision }) => ({ id, revision })) });
    return {
      plan: { revision, request: { scope, entries, remove, reset }, changes, warnings, sources: structuredClone(snapshot?.sources ?? []) },
      snapshot, base: structuredClone(nextBase), overrides, effective, persisted,
    };
  }

  #effective(base: FabricComponentEntry[], overrides: Map<string, FabricComponentEntry | null>): FabricComponentEntry[] {
    const effective = new Map(base.map(entry => [entry.id, entry]));
    for (const [id, entry] of overrides) { if (entry) effective.set(id, entry); else effective.delete(id); }
    return componentEntries([...effective.values()]);
  }

  #enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    this.loader.supervisor.assertLifecycleEntryAllowed("change component configuration");
    if (this.#closed) return Promise.reject(new Error("Component control is closed"));
    const task = this.#tail.then(() => {
      if (this.#closed) throw new Error("Component control is closed");
      return operation();
    });
    this.#tail = task.then(() => undefined, error => { this.#error = error instanceof Error ? error.message : String(error); });
    return task;
  }
}
