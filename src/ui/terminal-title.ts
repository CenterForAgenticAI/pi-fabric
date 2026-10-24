import type { Theme } from "@earendil-works/pi-coding-agent";
import type { CodePreviewSettings } from "./code-preview.js";
import { nestedCallTitle, type FabricRenderAudit } from "./fabric-render.js";
import { safeText } from "./format.js";
import { observedThemeVariant } from "./highlight.js";

/** Window and tab chrome clips titles far earlier than the transcript does. */
export const MAX_TERMINAL_TITLE_CHARS = 120;

/**
 * A terminal title is written as one raw OSC string, so it cannot carry the
 * transcript's styling: theme escapes would render as literal glyphs in the
 * tab. `safeText` also keeps a nested call's arguments from smuggling control
 * characters into the terminal.
 */
export const terminalTitleText = (value: string | undefined): string => {
  const text = safeText(value);
  if (text.length <= MAX_TERMINAL_TITLE_CHARS) return text;
  return `${Array.from(text).slice(0, MAX_TERMINAL_TITLE_CHARS - 1).join("").trimEnd()}…`;
};

// Nested call titles style with fg/bold only. A paint-free theme reuses that
// exact vocabulary without emitting escapes; terminalTitleText strips what
// Shiki still highlights into a bash command title. The theme carries the
// variant already in force so the core tool title cannot re-sync it.
const plainTitleTheme = (): Theme => ({
  name: observedThemeVariant(),
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme);

export type TerminalTitleCore = {
  cwd: string;
  settings: CodePreviewSettings;
};

/** A nested call's display title as plain text, e.g. `read src/index.ts`. */
export const terminalCallTitle = (
  audit: FabricRenderAudit,
  core?: TerminalTitleCore,
): string =>
  terminalTitleText(nestedCallTitle(
    audit,
    plainTitleTheme(),
    undefined,
    // A window title that counted seconds would flicker; the card keeps timing.
    core ? { cwd: core.cwd, settings: { ...core.settings, toolCallTiming: false } } : undefined,
  ));

export type FabricTerminalTitleOptions = {
  /** Host title setter. Headless hosts resolve it to a no-op. */
  setTitle?: ((title: string) => void) | undefined;
  /** Pi's own window title, recomputed on restore so a renamed session wins. */
  base?: (() => string | Promise<string>) | undefined;
};

/** Runs that currently hold the window title. Only the last one restores it. */
const liveRuns = new Set<FabricTerminalTitle>();

// A closed or redirected terminal can fail the write; decoration must never
// fail the program that is doing the work.
const applyTitle = (setTitle: (title: string) => void, text: string): void => {
  try {
    setTitle(text);
  } catch {
    // Ignore: the transcript already carries the same information.
  }
};

/** Run `body` while owning the window title, handing it back on any exit. */
export const withTerminalTitle = async <T>(
  title: FabricTerminalTitle | undefined,
  intent: string,
  body: () => Promise<T>,
): Promise<T> => {
  title?.show(intent);
  try {
    return await body();
  } finally {
    await title?.restore();
  }
};

/**
 * Lends the window title to a live Fabric program. Parallel `fabric_exec`
 * calls share one title: whichever run still holds it decides when Pi's own
 * title returns.
 */
export class FabricTerminalTitle {
  readonly #setTitle: ((title: string) => void) | undefined;
  readonly #base: (() => string | Promise<string>) | undefined;
  #applied: string | undefined;
  #settled = false;

  constructor(options: FabricTerminalTitleOptions = {}) {
    this.#setTitle = options.setTitle;
    this.#base = options.base;
  }

  /** Show the latest nested call's display title, coalescing repeats. */
  show(title: string | undefined): void {
    const setTitle = this.#setTitle;
    if (!setTitle || this.#settled) return;
    const text = terminalTitleText(title);
    if (!text || text === this.#applied) return;
    this.#applied = text;
    liveRuns.add(this);
    applyTitle(setTitle, text);
  }

  /** Hand the window title back to Pi once this run has stopped. */
  async restore(): Promise<void> {
    if (this.#settled) return;
    this.#settled = true;
    if (this.#applied === undefined) return;
    liveRuns.delete(this);
    if (liveRuns.size > 0) return;
    const setTitle = this.#setTitle;
    const base = await this.#base?.();
    // A parallel run may have claimed the title while the base resolved.
    if (!setTitle || liveRuns.size > 0) return;
    const text = terminalTitleText(base);
    if (text) applyTitle(setTitle, text);
  }
}
