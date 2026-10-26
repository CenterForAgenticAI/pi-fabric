import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MeshIdentity, MeshStore } from "../mesh/store.js";
import { renderDecision, terminalOperator, watchDecision, type RenderEvents } from "./render.js";
import { decisionHopLabel, DecisionStore, type DecisionRecord } from "./store.js";

// `/fabric decisions [id]`: list open decisions and answer one through native
// dialogs, or through a renderer that claims `pi-fabric:questions:render:v1`.
// The person at the terminal may answer any holder.

const CANCEL_LABEL = "Cancel this decision";
const ANSWER_LABEL = "Answer this question";

export const humanDecisionIdentity = (): MeshIdentity => {
  const user = terminalOperator();
  return { id: `user:${user}`, name: user, kind: "main" };
};

const summary = (record: DecisionRecord): string => {
  const hop = decisionHopLabel(record);
  const chain = hop ? ` (${hop}: ${record.escalation!.chain.join(" > ")})` : "";
  return `${record.title} · ${record.kind} · ${record.holder}${chain} · ${record.id.slice(-6)}`;
};

const notifySettled = (context: ExtensionContext, record: DecisionRecord): void => {
  if (record.status === "answered") {
    const option = record.options?.find((candidate) => candidate.id === record.answer?.optionId);
    context.ui.notify(option ? `Answered ${record.id}: ${option.label}` : `Answered ${record.id}`, "info");
  } else if (record.status === "cancelled") {
    context.ui.notify(`Cancelled decision ${record.id}`, "info");
  } else {
    context.ui.notify(`Decision ${record.id} is ${record.status}`, "info");
  }
};

export const openFabricDecisions = async (
  mesh: MeshStore,
  context: ExtensionContext,
  requestedId?: string,
  events?: RenderEvents,
): Promise<void> => {
  const store = new DecisionStore(mesh, humanDecisionIdentity());
  const open = await store.list({ status: "open", limit: 200 });
  if (!context.hasUI) {
    context.ui.notify(open.length ? open.map(summary).join("\n") : "No open Fabric decisions", "info");
    return;
  }
  let record = requestedId
    ? open.find((candidate) => candidate.id === requestedId || candidate.id.endsWith(requestedId))
    : undefined;
  if (!record) {
    if (open.length === 0) {
      context.ui.notify(requestedId ? `No open decision matches ${requestedId}` : "No open Fabric decisions", "info");
      return;
    }
    const labels = open.map((candidate, index) => `${index + 1}. ${summary(candidate)}`);
    const picked = await context.ui.select("Fabric decisions", labels);
    if (picked === undefined) return;
    record = open[labels.indexOf(picked)];
    if (!record) return;
  }
  const prompt = [record.title, record.body].filter(Boolean).join("\n\n");
  const by = { answeredBy: terminalOperator(), via: "tui" };
  const watch = watchDecision(store, record.id);
  try {
    const rendered = await renderDecision({
      events,
      surface: "decisions-command",
      context,
      store,
      record,
      watch,
      by,
    });
    if (rendered.kind === "settled") {
      notifySettled(context, rendered.record);
      return;
    }
    if (rendered.kind !== "fallback") return;
    if (record.options) {
      const labels = [...record.options.map((option) => option.label), CANCEL_LABEL];
      const picked = await context.ui.select(prompt, labels);
      if (picked === undefined) return;
      if (picked === CANCEL_LABEL) {
        await store.cancel(record.id, by);
        context.ui.notify(`Cancelled decision ${record.id}`, "info");
        return;
      }
      const option = record.options[labels.indexOf(picked)];
      if (!option) return;
      await store.answer(record.id, { optionId: option.id }, by);
      context.ui.notify(`Answered ${record.id}: ${option.label}`, "info");
      return;
    }
    // A text box cannot tell an empty answer from a cancel, so ask which one first.
    const action = await context.ui.select(prompt, [ANSWER_LABEL, CANCEL_LABEL]);
    if (action === undefined) return;
    if (action === CANCEL_LABEL) {
      await store.cancel(record.id, by);
      context.ui.notify(`Cancelled decision ${record.id}`, "info");
      return;
    }
    const text = record.input === "editor"
      ? await context.ui.editor(prompt)
      : await context.ui.input(prompt);
    if (text === undefined) return;
    await store.answer(record.id, { text }, by);
    context.ui.notify(`Answered ${record.id}`, "info");
  } catch (error) {
    context.ui.notify(error instanceof Error ? error.message : String(error), "error");
  } finally {
    watch.stop();
  }
};
