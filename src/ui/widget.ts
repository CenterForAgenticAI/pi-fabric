import type { Component, Focusable, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { FabricUiWidgetMode } from "../config.js";
import { spinnerFrame } from "./spinner.js";
import { FabricWidgetRetention, isRecentWidgetCompletion } from "./retention.js";
import { FABRIC_CONVERSATION_HINT } from "./conversation-shortcut.js";
import type { FabricAgentTranscript } from "./transcript.js";
import {
  FABRIC_WIDGET_FOCUS_HINT,
  FABRIC_WIDGET_FOCUS_SHORTCUT,
  WIDGET_ACTIVITY_ROWS,
  widgetActivityLines,
  widgetDivider,
} from "./widget-activity.js";
import type {
  FabricActivityRun,
  FabricActivityStatus,
} from "../activity/types.js";
import { formatCost, formatDuration, formatTokens, safeText } from "./format.js";
import {
  isActiveStatus,
  orderAgentsByCreation,
  type FabricDashboardSnapshot,
  type FabricUiAgent,
} from "./types.js";

const statusGlyph = (status: string): string => {
  if (status === "completed" || status === "done" || status === "exited") return "✓";
  if (status === "failed" || status === "timed_out") return "✗";
  if (status === "blocked") return "!";
  if (status === "stopped" || status === "cancelled" || status === "killed") return "■";
  if (status === "queued" || status === "pending" || status === "ready") return "○";
  if (status === "idle" || status === "state") return "·";
  return spinnerFrame();
};

const colorStatus = (theme: Theme, status: string, value: string): string => {
  if (status === "completed" || status === "done" || status === "exited") return theme.fg("success", value);
  if (status === "failed" || status === "timed_out") return theme.fg("error", value);
  if (status === "blocked" || status === "stopping") return theme.fg("warning", value);
  if (status === "running" || status === "in_progress" || status === "spilled") return theme.fg("accent", value);
  return theme.fg("dim", value);
};

const phaseProgress = (
  run: FabricActivityRun,
  phaseId: string,
): { completed: number; total: number } => {
  const phase = run.phases.find((candidate) => candidate.id === phaseId);
  const statuses: FabricActivityStatus[] = [
    ...run.calls.filter((call) => call.phaseId === phaseId).map((call) => call.status),
    ...run.items.filter((item) => item.phaseId === phaseId).map((item) => item.status),
  ];
  const completed = statuses.filter((status) => status === "completed").length;
  return { completed, total: Math.max(phase?.total ?? 0, statuses.length) };
};

const totalTokens = (
  snapshot: FabricDashboardSnapshot,
  run: FabricActivityRun | undefined,
): number =>
  snapshot.agents
    .filter((agent) => (run ? agent.runId === run.id : isActiveStatus(agent.status)))
    .reduce(
      (sum, agent) => sum + (agent.usage ? agent.usage.input + agent.usage.output : 0),
      0,
    );

const totalCost = (
  snapshot: FabricDashboardSnapshot,
  run: FabricActivityRun | undefined,
): number =>
  snapshot.agents
    .filter((agent) => (run ? agent.runId === run.id : isActiveStatus(agent.status)))
    .reduce((sum, agent) => sum + (agent.usage?.cost ?? 0), 0);

/** A widget row that can be selected and expanded to show its live activity. */
export interface FabricWidgetRow {
  /** Agent id, or actor id for an actor's worker row. */
  id: string;
  kind: "agent" | "actor";
  name: string;
}

/** Optional interaction wiring; without it the widget stays a passive status box. */
export interface FabricWidgetInteraction {
  /** Live activity for an expanded row, read from the participant's event log. */
  activity: (row: FabricWidgetRow) => FabricAgentTranscript | undefined;
  /**
   * Return focus to the editor. `forward` is a key the widget does not use; the
   * editor receives it, because Pi handles Ctrl+C and extension shortcuts there.
   */
  release: (forward?: string) => void;
  /** Pi's hideThinkingBlock: the pane keeps the thinking marker and drops its text. */
  hideThinking?: () => boolean;
  /** Ask the host to redraw (selection and expansion change without a snapshot change). */
  requestRender: () => void;
}

const agentLines = (
  theme: Theme,
  agent: FabricUiAgent,
  now: number,
): string[] => {
  const status = colorStatus(theme, agent.status, statusGlyph(agent.status));
  const activity =
    agent.currentTool ??
    (agent.error
      ? `error: ${truncateToWidth(safeText(agent.error), 48)}`
      : agent.text && !isActiveStatus(agent.status)
        ? `result: ${truncateToWidth(safeText(agent.text), 48)}`
        : agent.status === "running"
          ? "thinking"
          : agent.status);
  const metrics = [
    agent.toolCalls !== undefined ? `${agent.toolCalls} calls` : undefined,
    agent.usage ? `${formatTokens(agent.usage.input + agent.usage.output)} tok` : undefined,
    agent.startedAt
      ? formatDuration((agent.finishedAt ?? now) - agent.startedAt)
      : undefined,
  ].filter((value): value is string => Boolean(value));
  const indent = "  ".repeat(1 + Math.max(0, agent.nestingDepth ?? 0));
  return [
    `${indent}${status} ${theme.fg("muted", safeText(agent.name))}  ${theme.fg("muted", safeText(activity))}${
      metrics.length > 0 ? theme.fg("dim", ` · ${metrics.join(" · ")}`) : ""
    }`,
  ];
};

export const shouldShowFabricWidget = (
  snapshot: FabricDashboardSnapshot,
  mode: FabricUiWidgetMode,
  retention = new FabricWidgetRetention(),
): boolean => {
  if (mode === "hidden") return false;
  if (mode === "always") return true;
  retention.sync(snapshot);
  if (snapshot.shells?.some(job => job.finishedAt === undefined || isRecentWidgetCompletion(job.finishedAt, snapshot.now))) return true;
  if (snapshot.agents.some((agent) => retention.visible(agent, snapshot))) return true;
  if (snapshot.actors.some((actor) => actor.status !== "stopped")) return true;
  const run = snapshot.runs[0];
  if (!run) return false;
  if (run.status === "running") return true;
  const finishedAt = run.finishedAt ?? run.updatedAt;
  return finishedAt > (snapshot.widgetDismissedAt ?? 0);
};

/**
 * Share of the terminal height the animated box may claim. pi's main-screen
 * renderer scrolls the pane once the rendered content is taller than the
 * terminal, so a box that fills the viewport keeps that scroll region moving on
 * every animation frame — which reads as flicker inside tmux. Half the pane
 * keeps the transcript and editor visible and bounds the box on short panes.
 */
export const WIDGET_TERMINAL_ROW_SHARE = 0.5;

/** Effective row budget: the configured maximum, bounded by the live pane. */
export const widgetRowLimit = (maxRows: number, terminalRows?: number): number => {
  const configured = Math.max(1, maxRows);
  if (terminalRows === undefined || !Number.isFinite(terminalRows) || terminalRows <= 0) {
    return configured;
  }
  const paneShare = Math.floor(terminalRows * WIDGET_TERMINAL_ROW_SHARE);
  return Math.max(1, Math.min(configured, paneShare));
};

/**
 * Row budget while an activity pane is open. Expanding is an explicit request
 * for more room, so the widget may use its whole terminal share instead of
 * `maxRows`, but never more than that share.
 */
export const widgetExpandedRowLimit = (maxRows: number, terminalRows?: number): number => {
  const limit = widgetRowLimit(maxRows, terminalRows);
  if (terminalRows === undefined || !Number.isFinite(terminalRows) || terminalRows <= 0) {
    return limit + 2 + WIDGET_ACTIVITY_ROWS;
  }
  return Math.max(limit, Math.floor(terminalRows * WIDGET_TERMINAL_ROW_SHARE));
};

export class FabricWidget implements Component, Focusable {
  constructor(
    readonly theme: Theme,
    readonly snapshot: () => FabricDashboardSnapshot,
    readonly maxRows: number,
    // Live terminal height. pi re-renders the widget on resize, so reading the
    // pane per render bounds the box without a resize subscription.
    readonly terminalRows?: () => number | undefined,
    readonly retention = new FabricWidgetRetention(),
    readonly interaction?: FabricWidgetInteraction,
  ) {}

  /** Set by the TUI when the widget gains or loses keyboard focus. */
  focused = false;
  #selectedId: string | undefined;
  #expandedId: string | undefined;
  #activityScroll = 0;
  #activityMaxScroll = 0;
  #paneRows = WIDGET_ACTIVITY_ROWS;
  /** Participant rows of the last render, with their line index in the output. */
  #rows: Array<FabricWidgetRow & { line: number }> = [];
  #renderedFocus = false;
  #renderedSelection: string | undefined;
  #renderedExpansion: string | undefined;

  /** Id of the row whose activity pane is open, if any. */
  get expandedId(): string | undefined {
    return this.#expandedId;
  }

  /** Select the first participant row; used when focus arrives from the keyboard. */
  selectDefault(): void {
    const rows = this.#selectableRows();
    if (!rows.some((row) => row.id === this.#selectedId)) this.#selectedId = this.#expandedId ?? rows[0]?.id;
  }

  #interactionKey(): string {
    return `${this.focused}|${this.#selectedId ?? ""}|${this.#expandedId ?? ""}|${this.#activityScroll}`;
  }

  handleInput(data: string): void {
    const rows = this.#selectableRows();
    const index = Math.max(0, rows.findIndex((row) => row.id === this.#selectedId));
    const select = (next: number): void => {
      const row = rows[Math.max(0, Math.min(rows.length - 1, next))];
      if (!row) return;
      this.#selectedId = row.id;
      if (this.#expandedId && this.#expandedId !== row.id) this.#expand(row.id);
    };
    if (matchesKey(data, "escape") || matchesKey(data, FABRIC_WIDGET_FOCUS_SHORTCUT)) {
      if (this.#expandedId && matchesKey(data, "escape")) this.#expandedId = undefined;
      else this.interaction?.release();
    } else if (matchesKey(data, "up") || data === "k") {
      select(index - 1);
    } else if (matchesKey(data, "down") || data === "j") {
      select(index + 1);
    } else if (matchesKey(data, "enter") || data === " ") {
      if (this.#selectedId) this.#toggle(this.#selectedId);
    } else if (this.#expandedId && (matchesKey(data, "pageUp") || data === "K")) {
      this.#activityScroll = Math.min(this.#activityMaxScroll, this.#activityScroll + Math.max(1, this.#paneRows - 1));
    } else if (this.#expandedId && (matchesKey(data, "pageDown") || data === "J")) {
      this.#activityScroll = Math.max(0, this.#activityScroll - Math.max(1, this.#paneRows - 1));
    } else if (this.#expandedId && (matchesKey(data, "end") || data === "G")) {
      this.#activityScroll = 0;
    } else {
      // Not a widget key: give focus and the key back to the editor, so typing,
      // Ctrl+C, and extension shortcuts still work after a stray click.
      this.interaction?.release(data);
      return;
    }
    this.interaction?.requestRender();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (!this.interaction) return undefined;
    if (event.type === "wheel" && this.#expandedId) {
      const delta = Math.sign(event.wheelDelta ?? 0);
      this.#activityScroll = Math.max(0, Math.min(this.#activityMaxScroll, this.#activityScroll - delta * 3));
      return { handled: true, render: true };
    }
    if (event.type === "press") return { handled: true };
    if (event.type !== "click" || event.button !== "left") return undefined;
    const row = this.#rows.find((candidate) => candidate.line === event.y);
    // Only a participant row takes focus; a click elsewhere leaves the editor focused.
    if (!row) return undefined;
    this.#selectedId = row.id;
    this.#toggle(row.id);
    return { focus: true, render: true };
  }

  #toggle(id: string): void {
    if (this.#expandedId === id) this.#expandedId = undefined;
    else this.#expand(id);
  }

  #expand(id: string): void {
    this.#expandedId = id;
    this.#activityScroll = 0;
  }

  /** Rows a user can select: the participant rows the widget shows, in drawing order. */
  #selectableRows(): FabricWidgetRow[] {
    const { lines, rows } = this.#content(this.snapshot());
    const { listLimit } = this.#layout(lines.length, this.#expandedId !== undefined, this.#rowLimit());
    return rows.filter((row) => row.line < listLimit);
  }

  /** List and pane heights; the pane exists only while a row is expanded. */
  #layout(listLength: number, expanded: boolean, limit: number): { listLimit: number; paneRows: number } {
    if (!expanded) return { listLimit: limit, paneRows: 0 };
    const budget = widgetExpandedRowLimit(this.maxRows, this.terminalRows?.());
    // Two dividers frame the pane. Keep at least two list rows and one pane row.
    const listLimit = Math.max(2, Math.min(listLength, limit, budget - 5));
    const paneRows = Math.max(1, Math.min(WIDGET_ACTIVITY_ROWS, budget - Math.min(listLength, listLimit) - 2));
    return { listLimit, paneRows };
  }

  #rowLimit(): number {
    return widgetRowLimit(this.maxRows, this.terminalRows?.());
  }

  #lastWidth: number | undefined;
  #lastLimit: number | undefined;
  #lastSnapshot: FabricDashboardSnapshot | undefined;
  #lastLines: string[] | undefined;
  #pending:
    | { width: number; limit: number; snapshot: FabricDashboardSnapshot; lines: string[] }
    | undefined;

  render(width: number): string[] {
    if (width <= 0) return [];
    const snapshot = this.snapshot();
    // The pane can shrink between renders, so the row budget is part of the
    // cache key: a box measured against a taller terminal must not be reused.
    const limit = this.#rowLimit();
    const interactionChanged =
      this.#renderedFocus !== this.focused ||
      this.#renderedSelection !== this.#selectedId ||
      this.#renderedExpansion !== this.#interactionKey();
    if (interactionChanged) this.#pending = undefined;
    // An open pane reads a live log: reuse only the lines hasChanged() just
    // built, never the last frame, whose snapshot key says nothing about the log.
    const lines =
      !interactionChanged &&
      this.#pending?.width === width &&
      this.#pending.limit === limit &&
      this.#pending.snapshot === snapshot
        ? this.#pending.lines
        : !interactionChanged && !this.#expandedId &&
            this.#lastWidth === width &&
            this.#lastLimit === limit &&
            this.#lastSnapshot === snapshot &&
            this.#lastLines
          ? this.#lastLines
          : this.#renderLines(snapshot, width, limit);
    this.#pending = undefined;
    this.#renderedFocus = this.focused;
    this.#renderedSelection = this.#selectedId;
    this.#renderedExpansion = this.#interactionKey();
    this.#lastWidth = width;
    this.#lastLimit = limit;
    this.#lastSnapshot = snapshot;
    this.#lastLines = lines;
    return lines;
  }

  hasChanged(): boolean {
    if (this.#lastWidth === undefined || this.#lastLines === undefined) return true;
    const snapshot = this.snapshot();
    const limit = this.#rowLimit();
    const lines = this.#renderLines(snapshot, this.#lastWidth, limit);
    this.#pending = { width: this.#lastWidth, limit, snapshot, lines };
    return (
      lines.length !== this.#lastLines.length ||
      lines.some((line, index) => line !== this.#lastLines?.[index])
    );
  }

  invalidate(): void {
    this.#pending = undefined;
    this.#lastWidth = undefined;
    this.#lastLimit = undefined;
    this.#lastSnapshot = undefined;
    this.#lastLines = undefined;
  }

  #renderLines(snapshot: FabricDashboardSnapshot, width: number, limit: number): string[] {
    const { lines, rows } = this.#content(snapshot);
    if (this.#selectedId && !rows.some((row) => row.id === this.#selectedId)) this.#selectedId = rows[0]?.id;
    const expanded = rows.find((row) => row.id === this.#expandedId);
    if (this.#expandedId && !expanded) this.#expandedId = undefined;
    // Mark the selected row while the widget has focus.
    const marked = lines.map((line, index) => {
      const row = rows.find((candidate) => candidate.line === index);
      if (!row || !this.focused || row.id !== this.#selectedId) return line;
      return `${this.theme.fg("accent", "▸")}${line.replace(/^ /, "")}`;
    });
    const { listLimit, paneRows } = this.#layout(lines.length, expanded !== undefined, limit);
    // Rows cut off by the row limit are neither clickable nor selectable.
    this.#rows = rows.filter((row) => row.line < listLimit);
    if (!expanded) return this.#boundContent(this.#withFocusHint(marked, rows.length > 0), width, limit);
    // Expanded: the participant list stays bounded above an inline activity pane,
    // and both together stay inside the widget's terminal share.
    const list = this.#boundContent(this.#withFocusHint(marked, true), width, listLimit);
    this.#paneRows = paneRows;
    const activity = widgetActivityLines(
      this.theme,
      this.interaction?.activity(expanded),
      width,
      paneRows,
      this.#activityScroll,
      this.interaction?.hideThinking?.() ?? false,
    );
    this.#activityMaxScroll = activity.maxScroll;
    this.#activityScroll = Math.min(this.#activityScroll, activity.maxScroll);
    const position = this.#activityScroll > 0 ? ` · ↑${this.#activityScroll}` : " · live";
    const help = this.focused
      ? "↑↓ switch · PgUp/PgDn scroll · ⏎/click collapse · esc close"
      : `click or ${FABRIC_WIDGET_FOCUS_SHORTCUT} to focus`;
    return [
      ...list,
      widgetDivider(this.theme, width, this.theme.fg("accent", `${safeText(expanded.name)} activity${position}`)),
      ...activity.lines,
      widgetDivider(this.theme, width, this.theme.fg("dim", help)),
    ].map((line) => truncateToWidth(line, width));
  }

  /** Advertise the expand shortcut on the header while participant rows exist. */
  #withFocusHint(lines: string[], hasRows: boolean): string[] {
    if (!this.interaction || lines.length === 0 || !hasRows) return lines;
    const hint = this.focused ? "↑↓ select · ⏎ expand · esc back" : FABRIC_WIDGET_FOCUS_HINT;
    return [`${lines[0]} · ${this.theme.fg("dim", hint)}`, ...lines.slice(1)];
  }

  #content(snapshot: FabricDashboardSnapshot): { lines: string[]; rows: Array<FabricWidgetRow & { line: number }> } {
    const rows: Array<FabricWidgetRow & { line: number }> = [];
    const lines = this.#buildContent(snapshot, rows);
    return { lines, rows };
  }

  #buildContent(snapshot: FabricDashboardSnapshot, rows: Array<FabricWidgetRow & { line: number }> = []): string[] {
    const candidateRun = snapshot.runs[0];
    const candidateFinishedAt = candidateRun?.finishedAt ?? candidateRun?.updatedAt ?? 0;
    const run =
      candidateRun &&
      (candidateRun.status === "running" ||
        candidateFinishedAt > (snapshot.widgetDismissedAt ?? 0))
        ? candidateRun
        : undefined;
    this.retention.sync(snapshot);
    const orderedAgents = orderAgentsByCreation(snapshot.agents);
    const activeAgents = orderedAgents.filter((agent) => isActiveStatus(agent.status));
    const activeAgentIds = new Set(activeAgents.map((agent) => agent.id));
    // Keep settle-time rows stable, then retire each completion independently.
    // Bound only current content: expiry must not leave a high-water blank row.
    const terminalAgents = orderedAgents
      .filter((agent) =>
        !activeAgentIds.has(agent.id) &&
        !isActiveStatus(agent.status) &&
        this.retention.visible(agent, snapshot))
      .sort((left, right) =>
        this.retention.finishedAt(right, snapshot.now) - this.retention.finishedAt(left, snapshot.now));
    const visibleActors = snapshot.actors.filter((actor) => actor.status !== "stopped");
    const activeActorWorkers = visibleActors
      .filter((actor) => actor.worker && isActiveStatus(actor.worker.status))
      .map((actor) => ({ ...actor.worker!, name: actor.name, actorId: actor.id }));
    const terminalActorWorkers = visibleActors
      .filter((actor) => actor.worker && !isActiveStatus(actor.worker.status))
      .map((actor) => ({ ...actor.worker!, name: actor.name, actorId: actor.id }));
    const nestedCalls =
      run?.calls.filter((call) => call.kind !== "agent" && call.kind !== "actor") ?? [];
    const title = run?.name ?? "Fabric session";
    const shells = snapshot.shells ?? [];
    const liveShells = shells.filter(job => job.finishedAt === undefined);
    const recentShells = shells.filter(job => job.finishedAt !== undefined && isRecentWidgetCompletion(job.finishedAt, snapshot.now));
    const headerStatus =
      run?.status ??
      (activeAgents.length > 0 || activeActorWorkers.length > 0 || liveShells.length > 0 ? "running" : "idle");
    const parts: string[] = [];

    const callTotal = nestedCalls.length;
    if (callTotal > 1) {
      const callDone = nestedCalls.filter(
        (call) => call.status === "completed" || call.status === "failed",
      ).length;
      parts.push(`${callDone}/${callTotal} calls`);
    }
    if (run?.currentPhaseId) {
      const phaseIndex = run.phases.findIndex((phase) => phase.id === run.currentPhaseId);
      const phase = run.phases[phaseIndex];
      if (phase) {
        const progress = phaseProgress(run, phase.id);
        parts.push(
          `${phaseIndex + 1}/${run.phases.length} ${safeText(phase.name)}${
            progress.total > 0 ? ` ${progress.completed}/${progress.total}` : ""
          }`,
        );
      }
    }
    if (liveShells.length > 0) parts.push(`${liveShells.length} shell${liveShells.length === 1 ? "" : "s"}`);
    if (activeAgents.length > 0) parts.push(`${activeAgents.length} running`);
    if (visibleActors.length > 0) parts.push(`${visibleActors.length} actor${visibleActors.length === 1 ? "" : "s"}`);
    const tokens = totalTokens(snapshot, run);
    if (tokens > 0) parts.push(`${formatTokens(tokens)} tok`);
    const cost = totalCost(snapshot, run);
    if (cost > 0) parts.push(formatCost(cost));
    const elapsed = run && formatDuration((run.finishedAt ?? snapshot.now) - run.startedAt);
    if (elapsed) parts.push(elapsed);

    const glyph = colorStatus(this.theme, headerStatus, statusGlyph(headerStatus));
    const header = `${glyph} ${this.theme.fg("accent", "Fabric")} ${this.theme.fg(
      "muted",
      safeText(title),
    )}${parts.length > 0 ? this.theme.fg("dim", ` · ${parts.join(" · ")}`) : ""}`;
    const hasActiveConversations = activeAgents.some((agent) => !agent.stale) ||
      activeActorWorkers.length > 0 || visibleActors.some((actor) => isActiveStatus(actor.status));
    const taskHint = liveShells.length || recentShells.length ? this.theme.fg("dim", " · /fabric tasks · ctrl+alt+t") : "";
    const taskHeader = taskHint ? `${glyph} ${this.theme.fg("accent", "Fabric")}${taskHint}${parts.length ? this.theme.fg("dim", ` · ${parts.join(" · ")}`) : ""}` : header;
    const lines = [hasActiveConversations ? `${taskHeader} · ${this.theme.fg("dim", FABRIC_CONVERSATION_HINT)}` : taskHeader];
    for (const job of [...liveShells, ...recentShells].slice(0, 3)) {
      const elapsed = formatDuration((job.finishedAt ?? snapshot.now) - job.startedAt) || "0s";
      const status = job.stopping ? "stopping" : job.status;
      const label = job.monitor && job.finishedAt === undefined && !job.stopping ? `monitor:${job.monitor.delivery}` : status;
      const glyph = colorStatus(this.theme, status, statusGlyph(status));
      lines.push(
        `  ${glyph} ${this.theme.fg("muted", job.id.slice(0, 8))} ${this.theme.fg("muted", label)}` +
        `${this.theme.fg("dim", ` · ${elapsed} · `)}${this.theme.fg("muted", safeText(job.description ?? job.command))}`,
      );
    }
    if (liveShells.length + recentShells.length > 3) lines.push(this.theme.fg("dim", `  +${liveShells.length + recentShells.length - 3} more shell tasks`));

    const pushParticipant = (agent: FabricUiAgent, kind: "agent" | "actor"): void => {
      const id = kind === "actor" ? agent.actorId ?? agent.id : agent.id;
      rows.push({ id, kind, name: agent.name, line: lines.length });
      lines.push(...agentLines(this.theme, agent, snapshot.now));
    };
    for (const agent of activeAgents) pushParticipant(agent, "agent");
    for (const agent of activeActorWorkers) pushParticipant(agent, "actor");
    for (const agent of terminalActorWorkers) pushParticipant(agent, "actor");
    for (const agent of terminalAgents) pushParticipant(agent, "agent");
    return lines;
  }

  #boundContent(content: string[], width: number, limit: number): string[] {
    const bounded = content.slice(0, limit);
    if (content.length > bounded.length && bounded.length > 0) {
      const marker = this.theme.fg("dim", `+${content.length - bounded.length}`);
      const available = Math.max(0, width - visibleWidth(marker) - 1);
      const last = truncateToWidth(bounded[bounded.length - 1] ?? "", available, "");
      bounded[bounded.length - 1] = `${last} ${marker}`;
    }
    return bounded.map((line) => truncateToWidth(line, width));
  }
}
