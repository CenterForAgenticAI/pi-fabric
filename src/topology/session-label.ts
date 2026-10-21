import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { herdrSocketRequest } from "../agents/transports/herdr-socket.js";
import type { FabricSessionLabelConfig, FabricSessionLabelHerdrTarget } from "./session-label-settings.js";

/** Footer status key; Pi sorts extension statuses by key. */
export const SESSION_LABEL_STATUS_KEY = "fabric-label";

/** How often Fabric checks that its label is still on the Herdr names. */
const SESSION_LABEL_INTERVAL_MS = 5_000;
/** Debounce after a Pi session-name change, so a renamer that runs on the same event goes first. */
const SESSION_LABEL_EVENT_DELAY_MS = 500;

type HerdrName = "tab" | "pane";

interface AppliedName {
  kind: HerdrName;
  id: string;
  label: string;
  position: FabricSessionLabelConfig["herdrPosition"];
}

/** What `/fabric label` reports. */
export interface SessionLabelStatus {
  label?: string;
  footer: boolean;
  herdr: {
    available: boolean;
    target: FabricSessionLabelHerdrTarget;
    position: FabricSessionLabelConfig["herdrPosition"];
    applied: string[];
    error?: string;
  };
}

/** What `/fabric label` needs from a root session's presenter. */
export interface SessionLabelControl {
  status(): SessionLabelStatus;
  /** Apply changed settings now instead of on the next timer tick. */
  sync(): Promise<void>;
}

export interface SessionLabelPresenterOptions {
  /** The minted peer label, once the participant directory has one. */
  label: () => string | undefined;
  /** Read on every sync, so a config reload takes effect on the next one. */
  settings: () => FabricSessionLabelConfig;
  environment?: NodeJS.ProcessEnv;
  /** 0 disables the timer; tests drive sync() directly. */
  intervalMs?: number;
}

const tokens = (name: string): string[] => name.split(/\s+/).filter(Boolean);

/** Remove every whole-word copy of the label, keeping the rest of the name. */
const stripAffix = (name: string, label: string): string =>
  tokens(name).filter((token) => token !== label).join(" ");

const withAffix = (
  name: string,
  label: string,
  position: FabricSessionLabelConfig["herdrPosition"],
): string => {
  if (!name) return label;
  return position === "prefix" ? `${label} ${name}` : `${name} ${label}`;
};

/**
 * True when the label is already a whole word of the name. Two sessions can
 * share a tab, so the label need not be at the edge: each session keeps its
 * own word where it is instead of moving it back to the edge on every sync.
 */
const hasAffix = (name: string, label: string): boolean => tokens(name).includes(label);

const targets = (target: FabricSessionLabelHerdrTarget): HerdrName[] =>
  target === "both" ? ["tab", "pane"] : target === "off" ? [] : [target];

/**
 * Shows a root session's Fabric peer label (for example `FAB-3`) in the Pi
 * footer and, when configured, adds it to the Herdr tab or pane name.
 *
 * Herdr names have other writers (Pi name sync renames the pane on every
 * session-name change), so Fabric never caches a name: each sync reads the
 * live label, adds its own token only when missing, and on close or opt-out
 * strips only that token so another writer's changes survive.
 */
export class SessionLabelPresenter {
  readonly #unsubscribe: Array<() => void> = [];
  readonly #environment: NodeJS.ProcessEnv;
  readonly #applied = new Map<string, AppliedName>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #eventTimer: ReturnType<typeof setTimeout> | undefined;
  #footer: string | undefined;
  #syncing: Promise<void> | undefined;
  #syncAgain = false;
  #error: string | undefined;
  #closed = false;

  constructor(
    pi: ExtensionAPI,
    private readonly context: ExtensionContext,
    private readonly options: SessionLabelPresenterOptions,
  ) {
    this.#environment = options.environment ?? process.env;
    if (typeof pi.on === "function") {
      const unsubscribe = (pi.on as (event: string, handler: () => void) => unknown)(
        "session_info_changed",
        () => this.#scheduleEventSync(),
      );
      if (typeof unsubscribe === "function") this.#unsubscribe.push(unsubscribe as () => void);
    }
    const intervalMs = options.intervalMs ?? SESSION_LABEL_INTERVAL_MS;
    if (intervalMs > 0) {
      this.#timer = setInterval(() => void this.sync(), intervalMs);
      this.#timer.unref?.();
    }
  }

  /** True when this process may rename Herdr names: an interactive Pi inside Herdr. */
  get herdrAvailable(): boolean {
    return this.context.mode === "tui"
      && this.#environment.HERDR_ENV === "1"
      && Boolean(this.#environment.HERDR_SOCKET_PATH)
      && Boolean(this.#environment.HERDR_PANE_ID);
  }

  status(): SessionLabelStatus {
    const settings = this.options.settings();
    const label = this.options.label();
    return {
      ...(label ? { label } : {}),
      footer: settings.footer,
      herdr: {
        available: this.herdrAvailable,
        target: settings.herdr,
        position: settings.herdrPosition,
        applied: [...this.#applied.values()].map((name) => `${name.kind} ${name.id}`),
        ...(this.#error ? { error: this.#error } : {}),
      },
    };
  }

  /** Bring the footer and Herdr names in line with the label and settings. Never throws. */
  sync(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#syncing) {
      this.#syncAgain = true;
      return this.#syncing;
    }
    const run = (async () => {
      try {
        do {
          this.#syncAgain = false;
          await this.#syncOnce();
        } while (this.#syncAgain && !this.#closed);
      } finally {
        this.#syncing = undefined;
      }
    })();
    this.#syncing = run;
    return run;
  }

  /** Resolves after any scheduled or running sync has finished. */
  async settled(): Promise<void> {
    while (this.#syncing) await this.#syncing;
  }

  /** Stop syncing, clear the footer, and remove the label from every Herdr name Fabric changed. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe();
    if (this.#timer) clearInterval(this.#timer);
    if (this.#eventTimer) clearTimeout(this.#eventTimer);
    this.#timer = undefined;
    this.#eventTimer = undefined;
    await this.#syncing?.catch(() => undefined);
    this.#setFooter(undefined);
    for (const name of [...this.#applied.values()]) await this.#remove(name);
  }

  #scheduleEventSync(): void {
    if (this.#closed) return;
    if (this.#eventTimer) clearTimeout(this.#eventTimer);
    this.#eventTimer = setTimeout(() => {
      this.#eventTimer = undefined;
      void this.sync();
    }, SESSION_LABEL_EVENT_DELAY_MS);
    this.#eventTimer.unref?.();
  }

  async #syncOnce(): Promise<void> {
    const settings = this.options.settings();
    const label = this.options.label();
    this.#setFooter(settings.footer && label ? `Fabric ${label}` : undefined);
    const wanted = new Set<HerdrName>(label && this.herdrAvailable ? targets(settings.herdr) : []);
    try {
      this.#error = undefined;
      for (const [key, name] of [...this.#applied]) {
        if (!wanted.has(name.kind) || name.label !== label || name.position !== settings.herdrPosition) {
          await this.#remove(name);
          this.#applied.delete(key);
        }
      }
      if (!label) return;
      for (const kind of wanted) await this.#apply(kind, label, settings.herdrPosition);
    } catch (error) {
      this.#error = error instanceof Error ? error.message : String(error);
    }
  }

  #setFooter(text: string | undefined): void {
    if (text === this.#footer) return;
    this.#footer = text;
    if (this.context.hasUI) this.context.ui.setStatus(SESSION_LABEL_STATUS_KEY, text);
  }

  async #apply(
    kind: HerdrName,
    label: string,
    position: FabricSessionLabelConfig["herdrPosition"],
  ): Promise<void> {
    const current = await this.#read(kind);
    if (!current) return;
    const name: AppliedName = { kind, id: current.id, label, position };
    // The pane can move to another tab; forget the label on the old one.
    for (const [key, applied] of [...this.#applied]) {
      if (applied.kind === kind && applied.id !== current.id) {
        await this.#remove(applied);
        this.#applied.delete(key);
      }
    }
    this.#applied.set(`${kind}:${current.id}`, name);
    if (hasAffix(current.label, label)) return;
    const base = stripAffix(current.label, label);
    await this.#rename(kind, current.id, withAffix(base, label, position));
  }

  async #remove(name: AppliedName): Promise<void> {
    try {
      const current = await this.#read(name.kind, name.id);
      if (!current) return;
      const base = stripAffix(current.label, name.label);
      if (base !== current.label) await this.#rename(name.kind, name.id, base);
    } catch (error) {
      this.#error = error instanceof Error ? error.message : String(error);
    }
  }

  /** The live tab or pane and its current label. The tab comes from the pane, since a pane can move. */
  async #read(kind: HerdrName, id?: string): Promise<{ id: string; label: string } | undefined> {
    if (kind === "pane" || id === undefined) {
      const response = await this.#request("pane.get", { pane_id: this.#environment.HERDR_PANE_ID });
      const pane = (response as { result?: { pane?: { pane_id?: string; tab_id?: string; label?: string | null } } })
        .result?.pane;
      if (kind === "pane") return pane?.pane_id ? { id: pane.pane_id, label: pane.label ?? "" } : undefined;
      id = pane?.tab_id;
      if (!id) return undefined;
    }
    const response = await this.#request("tab.get", { tab_id: id });
    const tab = (response as { result?: { tab?: { tab_id?: string; label?: string } } }).result?.tab;
    return tab?.tab_id ? { id: tab.tab_id, label: tab.label ?? "" } : undefined;
  }

  async #rename(kind: HerdrName, id: string, label: string): Promise<void> {
    // An empty pane label clears it; Herdr requires a tab label.
    if (kind === "pane") await this.#request("pane.rename", { pane_id: id, label: label || null });
    else if (label) await this.#request("tab.rename", { tab_id: id, label });
  }

  #request(method: string, params: Record<string, unknown>): Promise<unknown> {
    return herdrSocketRequest(this.#environment.HERDR_SOCKET_PATH, { method, params }, "Fabric session label");
  }
}
