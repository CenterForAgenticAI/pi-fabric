import { componentEntries, validateComponentConfig } from "./validation.js";
import { stableJsonHash } from "../core/stable-hash.js";
import { FabricComponentCatalog } from "./catalog.js";
import { FabricComponentSupervisor } from "./supervisor.js";
import type {
  FabricComponentDefinition,
  FabricComponentEntry,
  FabricComponentGraph,
  FabricComponentInfo,
} from "./types.js";

interface LoadedComponent {
  entry: FabricComponentEntry;
  definition: FabricComponentDefinition;
  definitionRevision: number;
  entryHash: string;
}

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
const cloneEntry = (entry: FabricComponentEntry): FabricComponentEntry => structuredClone(entry);
const entryHash = (entry: FabricComponentEntry): string => stableJsonHash(entry);

export class FabricComponentLoader {
  readonly #loaded = new Map<string, LoadedComponent>();
  readonly #errors = new Map<string, string>();
  readonly #firstSeen = new Map<string, number>();
  readonly #unsubscribeCatalog: () => void;
  #desired = new Map<string, FabricComponentEntry>();
  #pinned = new Map<string, FabricComponentEntry>();
  #tail: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(
    readonly catalog: FabricComponentCatalog,
    readonly supervisor: FabricComponentSupervisor,
  ) {
    this.#unsubscribeCatalog = catalog.subscribe((event) => {
      const affected = [...this.#targetEntries().values()].filter(
        (entry) => entry.component === event.name && entry.disabled !== true,
      );
      if (affected.length === 0 || this.#closed) return;
      void this.#enqueue(() => this.#applyDesired()).catch((error) => {
        for (const entry of affected) this.#errors.set(entry.id, message(error));
      });
    });
  }

  entries(): FabricComponentEntry[] {
    return [...this.#desired.values()].map(cloneEntry);
  }

  pinnedEntries(): FabricComponentEntry[] {
    return [...this.#pinned.values()].map(cloneEntry);
  }

  definitions(): Array<{
    name: string;
    description?: string;
    revision: number;
    configSchema?: Record<string, unknown>;
    requirements: string[];
    provisions: string[];
  }> {
    return this.catalog.list().map(({ definition, revision }) => ({
      name: definition.name,
      ...(definition.description ? { description: definition.description } : {}),
      revision,
      ...(definition.configSchema ? { configSchema: structuredClone(definition.configSchema) } : {}),
      requirements: (definition.requires ?? []).map((requirement) =>
        typeof requirement === "string" ? requirement : requirement.ref,
      ),
      provisions: (definition.provides ?? []).map((provision) =>
        typeof provision === "string" ? provision : provision.provider,
      ),
    }));
  }

  describe(name: string) {
    const definition = this.definitions().find(candidate => candidate.name === name);
    if (!definition) throw new Error(`Unknown Fabric component definition: ${name}`);
    return { ...definition, instances: this.list().filter(instance => instance.component === name) };
  }

  validateEntries(entries: readonly FabricComponentEntry[]): void {
    const next = this.#entryMap(entries);
    for (const id of next.keys()) {
      if (this.#pinned.has(id)) throw new Error(`Fabric component entry id is reserved by a pinned component: ${id}`);
    }
    const provisions = new Map<string, string>();
    for (const entry of [...this.#pinned.values(), ...next.values()]) {
      if (entry.disabled) continue;
      for (const provision of this.catalog.get(entry.component)?.definition.provides ?? []) {
        const name = typeof provision === "string" ? provision : provision.provider;
        const owner = provisions.get(name);
        if (owner) throw new Error(`Fabric components ${owner} and ${entry.id} declare the same provider: ${name}`);
        provisions.set(name, entry.id);
      }
    }
  }

  unavailableProviderMessage(provider: string): string | undefined {
    const definitions = this.definitions().filter(definition => definition.provisions.includes(provider));
    if (!definitions.length) return undefined;
    const names = definitions.map(definition => definition.name);
    const entries = [...this.#targetEntries().values()].filter(entry => names.includes(entry.component));
    if (entries.length) return `Component instances ${entries.map(entry => entry.id).join(", ")} provide ${provider}, but none is active. Inspect components.status and components.list configuration diagnostics; use components.reconcile after correcting configuration.`;
    const name = names[0]!;
    return `Component definition ${name} is registered, but no instance provides ${provider}. Call components.describe({component:${JSON.stringify(name)}}), then components.plan({entries:[{id:${JSON.stringify(provider)},component:${JSON.stringify(name)},config:{...}}]}) and components.apply with that plan's request and revision. Session scope needs no file edit or /fabric reload.`;
  }

  list(): FabricComponentInfo[] {
    const live = new Map(
      this.supervisor.list().map((info) => [
        info.id,
        this.#errors.has(info.id) ? { ...info, error: this.#errors.get(info.id)! } : info,
      ]),
    );
    for (const entry of this.#targetEntries().values()) {
      if (entry.disabled || live.has(entry.id) || this.catalog.get(entry.component)) continue;
      const now = this.#firstSeen.get(entry.id) ?? Date.now();
      this.#firstSeen.set(entry.id, now);
      live.set(entry.id, {
        id: entry.id,
        component: entry.component,
        state: "waiting",
        guarantee: "managed",
        requirements: [],
        provisions: [],
        missing: [`component:${entry.component}`],
        optionalMissing: [],
        effects: [],
        error: `Fabric component definition is unavailable: ${entry.component}`,
        revision: 0,
        createdAt: now,
        updatedAt: now,
      });
    }
    return [...live.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  status(id: string): FabricComponentInfo {
    const info = this.list().find((candidate) => candidate.id === id);
    if (!info) throw new Error(`Unknown Fabric component: ${id}`);
    return info;
  }

  graph(): FabricComponentGraph {
    const graph = this.supervisor.graph();
    const present = new Set(graph.components.map((component) => component.id));
    return {
      ...graph,
      components: [
        ...graph.components,
        ...this.list().filter((component) => !present.has(component.id)),
      ].sort((left, right) => left.id.localeCompare(right.id)),
    };
  }

  reload(id?: string): Promise<FabricComponentInfo[]> {
    this.supervisor.assertLifecycleEntryAllowed("reload the component loader");
    return this.#enqueue(async () => {
      const targets = id
        ? [[id, this.#loaded.get(id)] as const]
        : [...this.#loaded.entries()];
      if (id && !targets[0]?.[1]) {
        const desired = this.#targetEntries().get(id);
        if (desired && !this.catalog.get(desired.component)) {
          throw new Error(`Fabric component definition is unavailable: ${desired.component}`);
        }
        throw new Error(`Unknown Fabric component: ${id}`);
      }
      for (const [componentId, loaded] of targets) {
        if (!loaded) continue;
        try {
          await this.supervisor.replace(componentId, loaded.entry, loaded.definition);
          this.#errors.delete(componentId);
        } catch (error) {
          this.#errors.set(componentId, message(error));
          throw error;
        }
      }
      return id ? [this.status(id)] : this.list();
    });
  }

  installPinned(entries: readonly FabricComponentEntry[]): Promise<FabricComponentInfo[]> {
    this.supervisor.assertLifecycleEntryAllowed("install pinned components");
    if (entries.length > 256) throw new Error("Fabric supports at most 256 pinned components");
    const next = this.#entryMap(entries);
    return this.#enqueue(async () => {
      for (const id of next.keys()) {
        if (this.#desired.has(id)) {
          throw new Error(`Pinned Fabric component id conflicts with configured entry: ${id}`);
        }
      }
      const previous = this.#pinned;
      this.#pinned = next;
      try {
        await this.#applyDesired();
        return this.list();
      } catch (error) {
        this.#pinned = previous;
        throw error;
      }
    });
  }

  reconcile(entries: readonly FabricComponentEntry[]): Promise<FabricComponentInfo[]> {
    this.supervisor.assertLifecycleEntryAllowed("reconcile the component loader");
    if (entries.length > 256) throw new Error("Fabric configuration supports at most 256 components");
    const next = this.#entryMap(entries);
    return this.#enqueue(async () => {
      for (const id of next.keys()) {
        if (this.#pinned.has(id)) {
          throw new Error(`Fabric component entry id is reserved by a pinned component: ${id}`);
        }
      }
      const previous = this.#desired;
      this.#desired = next;
      try {
        await this.#applyDesired();
        return this.list();
      } catch (error) {
        this.#desired = previous;
        throw error;
      }
    });
  }

  async settle(): Promise<void> {
    await this.#tail;
    await this.supervisor.settle();
    await this.#tail;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.supervisor.assertLifecycleEntryAllowed("close the component loader");
    this.#closed = true;
    this.#unsubscribeCatalog();
    await this.#tail;
    await this.supervisor.close();
    this.#loaded.clear();
    this.#pinned.clear();
  }

  #entryMap(entries: readonly FabricComponentEntry[]): Map<string, FabricComponentEntry> {
    const next = new Map<string, FabricComponentEntry>();
    for (const entry of componentEntries(entries)) {
      const definition = this.catalog.get(entry.component)?.definition;
      if (definition) validateComponentConfig(entry, definition);
      next.set(entry.id, entry);
    }
    return next;
  }

  #targetEntries(): Map<string, FabricComponentEntry> {
    return new Map([...this.#pinned, ...this.#desired]);
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#closed) return Promise.reject(new Error("Fabric component loader is closed"));
    const run = this.#tail.then(operation, operation);
    this.#tail = run.then(() => undefined, () => undefined);
    return run;
  }

  async #applyDesired(): Promise<void> {
    const targets = new Map<string, LoadedComponent>();
    for (const entry of this.#targetEntries().values()) {
      if (entry.disabled) continue;
      const catalogEntry = this.catalog.get(entry.component);
      if (!catalogEntry) continue;
      validateComponentConfig(entry, catalogEntry.definition);
      targets.set(entry.id, {
        entry: cloneEntry(entry),
        definition: catalogEntry.definition,
        definitionRevision: catalogEntry.revision,
        entryHash: entryHash(entry),
      });
    }

    const added: string[] = [];
    const changed: Array<{ id: string; previous: LoadedComponent }> = [];
    const removed: LoadedComponent[] = [];
    try {
      for (const [id, target] of targets) {
        const current = this.#loaded.get(id);
        if (!current) {
          try {
            await this.supervisor.start(target.entry, target.definition);
            this.#loaded.set(id, target);
            added.push(id);
          } catch (error) {
            try { await this.supervisor.stop(id); } catch { /* Preserve the original load error. */ }
            throw error;
          }
          continue;
        }
        if (
          current.entryHash === target.entryHash &&
          current.definitionRevision === target.definitionRevision
        ) {
          continue;
        }
        await this.supervisor.replace(id, target.entry, target.definition);
        changed.push({ id, previous: current });
        this.#loaded.set(id, target);
      }

      for (const [id, current] of [...this.#loaded]) {
        if (targets.has(id)) continue;
        await this.supervisor.stop(id);
        this.#loaded.delete(id);
        removed.push(current);
      }
      for (const id of targets.keys()) {
        this.#errors.delete(id);
        this.#firstSeen.delete(id);
      }
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      for (const current of removed.reverse()) {
        try {
          await this.supervisor.start(current.entry, current.definition);
          this.#loaded.set(current.entry.id, current);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      for (const { id, previous } of changed.reverse()) {
        try {
          await this.supervisor.replace(id, previous.entry, previous.definition);
          this.#loaded.set(id, previous);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      for (const id of added.reverse()) {
        try {
          await this.supervisor.stop(id);
          this.#loaded.delete(id);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      for (const id of targets.keys()) this.#errors.set(id, message(error));
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          "Fabric component transaction and rollback failed",
        );
      }
      throw error;
    }
  }
}
