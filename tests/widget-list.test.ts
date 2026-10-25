import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { projectAgentTranscript } from "../src/ui/transcript.js";
import type { FabricDashboardSnapshot, FabricUiAgent } from "../src/ui/types.js";
import { FabricWidget, SHELL_TASKS_ROW, shouldShowFabricWidget, type FabricWidgetInteraction, type FabricWidgetRow } from "../src/ui/widget.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  underline: (text: string) => text,
  inverse: (text: string) => text,
} as unknown as Theme;

const agent = (id: string, name: string, status = "running"): FabricUiAgent => ({
  id,
  name,
  status,
  transport: "process",
  cwd: "/tmp",
  startedAt: Date.now() - 5_000,
  toolCalls: 1,
});

type MutableSnapshot = FabricDashboardSnapshot & { agents: FabricUiAgent[]; actors: unknown[] };

const snapshot = (): MutableSnapshot => {
  const now = Date.now();
  return {
    now,
    main: { ...agent("main", "main"), status: "idle" },
    peers: [],
    runs: [],
    agents: [agent("agent-1", "security-reviewer")],
    actors: [
      {
        id: "actor-1",
        scope: "project",
        name: "advisor",
        status: "running",
        worker: agent("worker-1", "advisor-worker"),
        instructions: "",
        recentMessages: [],
      },
    ],
    componentGraph: { nodes: [], edges: [] },
    globalActors: [],
    state: [],
    events: [],
  } as unknown as MutableSnapshot;
};

const setup = (options: {
  current?: FabricDashboardSnapshot;
  terminalRows?: number;
  maxRows?: number;
  open?: boolean;
  interaction?: Partial<FabricWidgetInteraction>;
} = {}) => {
  const current = options.current ?? snapshot();
  const opened: FabricWidgetRow[] = [];
  const forwarded: string[] = [];
  let released = 0;
  const widget: FabricWidget = new FabricWidget(theme, () => current, options.maxRows ?? 6, () => options.terminalRows ?? 40, undefined, {
    release: (forward) => {
      released++;
      if (forward !== undefined) forwarded.push(forward);
      widget.focused = false;
    },
    requestRender: () => {},
    ...(options.open === false ? {} : { open: (row: FabricWidgetRow) => { opened.push(row); } }),
    ...options.interaction,
  });
  return { widget, opened, forwarded, released: () => released };
};

const manyAgents = (count: number): MutableSnapshot => {
  const current = snapshot();
  current.agents = Array.from({ length: count }, (_, index) => agent(`agent-${index}`, `agent-${index}`));
  current.actors = [];
  return current;
};

const mouse = (widget: FabricWidget, type: "move" | "click", y: number) =>
  widget.handleMouse({ type, button: type === "move" ? "none" : "left", x: 4, y, screenX: 4, screenY: y, width: 100, height: 8, shift: false, alt: false, ctrl: false });

describe("agent transcript projection", () => {
  it("keeps thinking text from streamed worker deltas", () => {
    const entries = projectAgentTranscript([
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "Checking the " } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "new branch state" } },
      { type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { path: "src/a.ts" } },
    ]).entries;
    expect(entries.find((entry) => entry.kind === "thinking")?.text).toBe("Checking the new branch state");
    expect(entries.some((entry) => entry.kind === "tool" && entry.toolName === "read")).toBe(true);
  });

  it("finishes the thinking of a reply that did not stream and keeps it for retained sessions", () => {
    const streamed = projectAgentTranscript([
      { type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "plan" }, { type: "text", text: "done" }] } },
    ]).entries;
    expect(streamed.find((entry) => entry.kind === "thinking")).toMatchObject({ text: "plan", status: "completed" });
    const retained = projectAgentTranscript([
      { type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "first" }, { type: "text", text: "a" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "second" }, { type: "text", text: "b" }] } },
    ]).entries.filter((entry) => entry.kind === "thinking");
    expect(retained.map((entry) => [entry.text, entry.status])).toEqual([["first", "completed"], ["second", "completed"]]);
  });
});

describe("Fabric agent list", () => {
  it("opens the selected participant on Enter, as in Claude Code", () => {
    const current = snapshot();
    current.agents = [{ ...agent("agent-1", "security-reviewer"), model: "anthropic/claude-sonnet-5-5" }];
    const { widget, opened } = setup({ current });
    const unfocused = widget.render(120);
    expect(unfocused[0]).toBe("");
    expect(unfocused[1]).toMatch(/^● Fabric .*↓ to manage$/);
    expect(unfocused[2]).toMatch(/^○ security-reviewer .*claude-sonnet-5-5/);
    widget.focused = true;
    widget.selectFirst();
    const focused = widget.render(120);
    // Focus moves the filled circle from the header to the selected row.
    expect(focused[1]).toMatch(/^○ Fabric .*⏎ open · ↑↓ select · esc back$/);
    expect(focused[2]).toMatch(/^● security-reviewer /);
    widget.handleInput("\x1b[B");
    widget.handleInput("\r");
    expect(opened).toMatchObject([{ id: "actor-1", kind: "actor" }]);
  });

  it("has no inline preview: Space goes back to the editor like any other key", () => {
    const { widget, forwarded, released } = setup();
    widget.focused = true;
    widget.selectFirst();
    widget.handleInput(" ");
    expect(released()).toBe(1);
    expect(forwarded).toEqual([" "]);
  });

  it("heads the list with the session label and keeps it when idle", () => {
    const current = snapshot();
    current.agents = [];
    current.actors = [];
    expect(shouldShowFabricWidget(current, "auto")).toBe(false);
    current.sessionLabel = "PBO-21";
    expect(shouldShowFabricWidget(current, "auto")).toBe(true);
    expect(shouldShowFabricWidget(current, "hidden")).toBe(false);
    const { widget } = setup({ current });
    expect(widget.render(100)).toEqual(["", "● PBO-21"]);
  });

  it("lists nested agents as a tree under their parents", () => {
    const current = snapshot();
    const at = (offset: number) => Date.now() - 60_000 + offset;
    current.actors = [];
    current.agents = [
      { ...agent("planner", "planner"), startedAt: at(0) },
      { ...agent("reviewer", "reviewer"), startedAt: at(1_000) },
      // Started after reviewer, so creation order alone would draw it under reviewer.
      { ...agent("api", "api-audit"), parentId: "planner", nestingDepth: 1, startedAt: at(2_000) },
      { ...agent("ui", "ui-audit", "completed"), parentId: "planner", nestingDepth: 1, startedAt: at(3_000), finishedAt: Date.now() },
      { ...agent("fixture", "fixture", "failed"), parentId: "ui", nestingDepth: 2, startedAt: at(4_000), finishedAt: Date.now(), error: "timed out" },
    ];
    const { widget } = setup({ current, maxRows: 10 });
    const rows = widget.render(160).slice(2).map((line) => line.replace(/^( *○ \S+).*$/, "$1"));
    expect(rows).toEqual(["○ planner", "  ○ api-audit", "  ○ ui-audit", "    ○ fixture", "○ reviewer"]);
  });

  it("shows a running agent's milestone in place of its tool name", () => {
    const current = snapshot();
    current.actors = [];
    current.agents = [{ ...agent("agent-1", "probe"), currentTool: "fabric_exec", milestone: "Trace token refresh" }];
    const { widget } = setup({ current });
    expect(widget.render(160)[2]).toMatch(/^○ probe  Trace token refresh · /);
    current.agents = [{ ...agent("agent-1", "probe"), currentTool: "read" }];
    widget.invalidate();
    expect(widget.render(160)[2]).toMatch(/^○ probe  read · /);
  });

  it("keeps agents in view and folds shell tasks into one row beside them", () => {
    const current = snapshot();
    current.actors = [];
    current.shells = Array.from({ length: 5 }, (_, index) => ({
      id: `shell-${index}-0000`, tool: "bash", command: `sleep ${index}`, startedAt: current.now - 1_000,
      spilledAt: current.now, status: "spilled", eventCount: 0, unread: false, stopping: false,
    })) as NonNullable<FabricDashboardSnapshot["shells"]>;
    const { widget, opened } = setup({ current });
    const lines = widget.render(120);
    expect(lines[1]).toContain("ctrl+alt+t tasks");
    expect(lines[2]).toMatch(/^○ security-reviewer /);
    expect(lines[3]).toMatch(/^○ 5 shell tasks · /);
    expect(lines).toHaveLength(4);
    // The folded row is selectable and opens every shell.
    widget.focused = true;
    widget.selectFirst();
    widget.handleInput("\x1b[B");
    expect(widget.render(120)[3]).toMatch(/^● 5 shell tasks/);
    widget.handleInput("\r");
    expect(opened.at(-1)).toMatchObject({ id: SHELL_TASKS_ROW, kind: "shells" });
    // Without participants, shells list one by one again, each its own row.
    current.agents = [];
    widget.focused = false;
    widget.invalidate();
    const shells = widget.render(120);
    expect(shells[1]).toContain("↓ to manage");
    expect(shells.slice(2, 5).every((line) => /^○ shell-\d/.test(line))).toBe(true);
    expect(shells[5]).toMatch(/^○ \+2 more shell tasks$/);
    expect(mouse(widget, "click", 3)).toEqual({ handled: true, render: true });
    expect(opened.at(-1)).toMatchObject({ id: "shell-1-0000", kind: "shell", name: "sleep 1" });
    expect(mouse(widget, "click", 5)).toEqual({ handled: true, render: true });
    expect(opened.at(-1)).toMatchObject({ id: SHELL_TASKS_ROW, kind: "shells" });
  });

  it("emphasises a selected shell's id like an agent's name", () => {
    const current = snapshot();
    current.agents = [];
    current.actors = [];
    current.shells = [{ id: "3f4985ff-0000", tool: "bash", command: "sleep 90", description: "Probe sleep", startedAt: current.now - 1_000,
      spilledAt: current.now, status: "spilled", eventCount: 0, unread: false, stopping: false }] as NonNullable<FabricDashboardSnapshot["shells"]>;
    const marking = { ...theme, fg: (color: string, text: string) => `<${color}>${text}</>`, bold: (text: string) => `<b>${text}</b>` } as unknown as Theme;
    const widget = new FabricWidget(marking, () => current, 6, () => 40, undefined, { release: () => {}, requestRender: () => {}, open: () => {} });
    expect(widget.render(120)[2]).toContain("<muted>3f4985ff</>");
    widget.focused = true;
    widget.selectFirst();
    const selected = widget.render(120)[2]!;
    expect(selected).toContain("<b>3f4985ff</b>");
    expect(selected).toContain("<muted>spilled</>");
  });

  it("fills the circle under the pointer and opens a row on click", () => {
    const { widget, opened } = setup();
    const lines = widget.render(100);
    const advisor = lines.findIndex((line) => line.includes("advisor"));
    expect(lines[1]).toMatch(/^● /);
    expect(mouse(widget, "move", advisor)).toEqual({ handled: true, render: true });
    const hovered = widget.render(100);
    expect(hovered[1]).toMatch(/^○ /);
    expect(hovered[advisor]).toMatch(/^● advisor/);
    // A move within the same row does not redraw.
    expect(mouse(widget, "move", advisor)).toEqual({ handled: true });
    // Crossing the header on the way back to the editor clears the hover.
    mouse(widget, "move", 1);
    expect(widget.render(100)[advisor]).toMatch(/^○ advisor/);
    mouse(widget, "move", advisor);
    expect(mouse(widget, "click", advisor)).toEqual({ handled: true, render: true });
    expect(opened).toMatchObject([{ id: "actor-1", kind: "actor" }]);
    expect(widget.render(100)[advisor]).toMatch(/^○ advisor/);
  });

  it("a click on a row focuses the list when the host cannot open it", () => {
    const { widget, opened } = setup({ open: false });
    const lines = widget.render(100);
    const advisor = lines.findIndex((line) => line.includes("advisor"));
    expect(mouse(widget, "click", advisor)).toEqual({ focus: true, render: true });
    expect(opened).toEqual([]);
  });

  it("a click outside the participant rows does not take focus", () => {
    const { widget, opened } = setup();
    widget.render(100);
    expect(mouse(widget, "click", 1)).toBeUndefined();
    expect(opened).toEqual([]);
  });

  it("↑ on the top row and Esc return focus to the editor above the list", () => {
    const { widget, released } = setup();
    widget.focused = true;
    widget.selectFirst();
    widget.handleInput("\x1b[B");
    widget.handleInput("\x1b[A");
    expect(released()).toBe(0);
    widget.handleInput("\x1b[A");
    expect(released()).toBe(1);
    widget.focused = true;
    widget.handleInput("\x1b");
    expect(released()).toBe(2);
  });

  it("hands a key it does not use back to the editor with focus", () => {
    const { widget, forwarded, released } = setup();
    widget.focused = true;
    widget.selectDefault();
    widget.handleInput("x");
    expect(released()).toBe(1);
    expect(forwarded).toEqual(["x"]);
    // Ctrl+C lives in Pi's editor, so it must reach it too.
    widget.focused = true;
    widget.handleInput("\x03");
    expect(forwarded).toEqual(["x", "\x03"]);
  });

  it("uses its terminal share while focused and keeps every line inside the width", () => {
    const { widget } = setup({ current: manyAgents(30), terminalRows: 40 });
    const collapsed = widget.render(100);
    expect(collapsed).toHaveLength(6);
    expect(collapsed.at(-1)).toMatch(/\+\d+$/);
    widget.focused = true;
    widget.selectFirst();
    const focused = widget.render(100);
    expect(focused).toHaveLength(20);
    for (const width of [20, 40, 100]) {
      expect(widget.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
    }
  });

  it("selects only the rows the widget shows", () => {
    const { widget, opened } = setup({ current: manyAgents(30), terminalRows: 12 });
    widget.focused = true;
    widget.selectFirst();
    const shown = widget.render(100);
    for (let index = 0; index < 40; index++) widget.handleInput("\x1b[B");
    widget.handleInput("\r");
    const lastShown = shown.map((line) => /agent-(\d+)/.exec(line)?.[1]).filter(Boolean).at(-1);
    expect(opened.at(-1)?.id).toBe(`agent-${lastShown}`);
  });

  it("marks the participant on screen and offers Main as a row in a participant window", () => {
    let viewing: string | undefined = "agent-1";
    const { widget, opened } = setup({ interaction: { viewing: () => viewing, mainId: "main", hints: false } });
    const lines = widget.render(120);
    // No key hints, and the agent on screen keeps the filled circle.
    expect(lines[1]).toBe("○ Fabric · 1 running · 1 actor");
    expect(lines[2]).toMatch(/^● security-reviewer /);
    widget.focused = true;
    widget.selectDefault();
    expect(widget.render(120)[2]).toMatch(/^● security-reviewer /);
    widget.handleInput("\x1b[A");
    widget.handleInput("\r");
    expect(opened).toMatchObject([{ id: "main", kind: "main" }]);
    viewing = undefined;
    widget.focused = false;
    expect(widget.render(120)[1]).toMatch(/^● Fabric/);
  });

  it("keeps a one-row budget to one row: the header, without the spacer", () => {
    const { widget, opened } = setup({ maxRows: 1 });
    const lines = widget.render(100);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^● Fabric /);
    expect(lines[0]).toMatch(/\+2$/);
    // Clicks map to rows without the spacer offset.
    expect(mouse(widget, "click", 0)).toBeUndefined();
    expect(opened).toEqual([]);
  });

  it("lists agents whose parents point at each other instead of hiding them", () => {
    const current = snapshot();
    current.actors = [];
    current.agents = [
      { ...agent("a", "alpha"), parentId: "b" },
      { ...agent("b", "beta"), parentId: "a" },
    ];
    const lines = setup({ current, maxRows: 10 }).widget.render(120).join("\n");
    expect(lines).toContain("alpha");
    expect(lines).toContain("beta");
  });

  it("stays passive without interaction wiring", () => {
    const current = snapshot();
    const widget = new FabricWidget(theme, () => current, 6);
    expect(widget.render(100).join("\n")).not.toContain("↓ to manage");
    expect(widget.handleMouse({ type: "click", button: "left", x: 0, y: 2, screenX: 0, screenY: 2, width: 100, height: 3, shift: false, alt: false, ctrl: false })).toBeUndefined();
  });
});
