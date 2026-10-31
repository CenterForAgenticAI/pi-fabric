import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  FabricDecisionQuestionV1,
  FabricDecisionRequestV1,
  FabricDecisionResultV1,
  FabricDecisionsCapabilityRequestV1,
} from "../protocol.js";
import { raiseAndWait } from "./host.js";
import {
  MAX_DECISION_BODY_CHARS,
  MAX_DECISION_DEADLINE_MS,
  MAX_DECISION_OPTIONS,
  MAX_DECISION_TEXT_CHARS,
  MAX_DECISION_TITLE_CHARS,
  MIN_DECISION_TIMEOUT_MS,
  type DecisionRaiseInput,
  type DecisionRecord,
  type DecisionStore,
  MAX_ESCALATION_HOP_MS,
  isParticipantId,
} from "./store.js";

// The `pi.events` decisions channel lets another extension (for example a
// question tool with no screen) hand a question to a person through the
// project's durable decisions. The caller chooses only the question; Fabric
// fixes who holds it ("user"), what expiry does ("cancel"), and the kind
// ("question"), so a caller cannot route it to a program, escalate it, or
// attach a default answer that settles without a person.
//
// One opt-in exception: the host lists trusted sources in
// `decisions.supervisorSources`. A request from such a source may name a
// `supervisor` participant that holds the decision first, with the fixed chain
// [supervisor:<id>, "user"]. `root` is never in that chain, so the asking
// session cannot answer, and the last hop is always the user.

export interface FabricDecisionsTargetStore {
  store: DecisionStore;
  /** Trusted `decisions.supervisorSources`; absent or empty means no source may name a supervisor. */
  supervisorSources?: readonly string[];
}
export type FabricDecisionsTarget = FabricDecisionsTargetStore | { reason: string };
export type ResolveFabricDecisions = (context: ExtensionContext) => Promise<FabricDecisionsTarget>;

// A source names the asking extension. It cannot contain ":", so the stored
// "extension:<source>" participant id never equals a real participant id.
const SOURCE_PATTERN = /^[A-Za-z0-9@][A-Za-z0-9@._/-]{0,63}$/;

const raisedByFromSource = (source: string | undefined): Partial<DecisionRecord["raisedBy"]> => {
  if (source === undefined) return {};
  if (!SOURCE_PATTERN.test(source)) throw new Error("Decision source must match [A-Za-z0-9@][A-Za-z0-9@._/-]{0,63}");
  return { participantId: `extension:${source}` };
};

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

const optionField = (option: unknown, field: "id" | "label"): unknown =>
  typeof option === "object" && option !== null ? (option as Record<string, unknown>)[field] : undefined;

const sourceMaySupervise = (source: string | undefined, allowed: readonly string[] | undefined): boolean =>
  source !== undefined && SOURCE_PATTERN.test(source) && (allowed ?? []).includes(source);

/**
 * The supervisor to hold the decision first, or undefined for the user. Only an
 * allow-listed source can name one; every other request keeps the user holder.
 * Throws when an allow-listed source names a participant that must not hold it.
 */
const supervisorFor = (
  request: Pick<FabricDecisionRequestV1, "source" | "supervisor">,
  target: FabricDecisionsTargetStore,
): string | undefined => {
  const supervisor = request.supervisor;
  if (supervisor === undefined || !sourceMaySupervise(request.source, target.supervisorSources)) return undefined;
  if (!isParticipantId(supervisor)) throw new Error("Decision supervisor must be a Fabric participant id");
  if (supervisor === "user" || supervisor === "root") throw new Error(`Decision supervisor cannot be "${supervisor}"`);
  if (supervisor.startsWith("extension:")) throw new Error('Decision supervisor cannot be an "extension:" participant');
  if (supervisor === target.store.identity.id) throw new Error("Decision supervisor cannot be the asking session");
  return supervisor;
};

/** Copy only the named question fields; the store validates their values. */
const decisionInputFromQuestion = (question: FabricDecisionQuestionV1, supervisor?: string): DecisionRaiseInput => {
  const source = question as unknown as Record<string, unknown>;
  const options = source.options;
  return {
    kind: "question",
    title: source.title,
    ...(source.body !== undefined ? { body: source.body } : {}),
    ...(source.input !== undefined ? { input: source.input } : {}),
    ...(options !== undefined
      ? {
          options: Array.isArray(options)
            ? options.map((option: unknown) => ({ id: optionField(option, "id"), label: optionField(option, "label") }))
            : options,
        }
      : {}),
    ...(source.timeoutMs !== undefined ? { timeoutMs: source.timeoutMs } : {}),
    ...(supervisor !== undefined
      ? {
          holder: `supervisor:${supervisor}`,
          onExpire: "escalate",
          // Never "root": the asking session is a main session and could answer as root.
          escalation: { chain: [`supervisor:${supervisor}`, "user"], hopTimeoutMs: MAX_ESCALATION_HOP_MS, onFinal: "cancel" },
        }
      : { holder: "user", onExpire: "cancel" }),
  };
};

/** Only an answered record carries an answer; nothing else becomes one. */
const decisionResult = (record: DecisionRecord): FabricDecisionResultV1 => {
  if (record.status === "answered" && record.answer) {
    const { optionId, text, answeredBy, via, at } = record.answer;
    return {
      ok: true,
      id: record.id,
      status: "answered",
      answer: {
        ...(optionId !== undefined ? { optionId } : {}),
        ...(text !== undefined ? { text } : {}),
        answeredBy,
        via,
        at,
      },
    };
  }
  if (record.status === "cancelled" || record.status === "expired") {
    return { ok: true, id: record.id, status: record.status };
  }
  return { ok: false, id: record.id, error: `Decision ${record.id} is still ${record.status}` };
};

const once = <T>(respond: (result: T) => void): ((result: T) => void) => {
  let sent = false;
  return (result) => {
    if (sent) return;
    sent = true;
    respond(result);
  };
};

export const answerFabricDecisionsCapability = async (
  request: FabricDecisionsCapabilityRequestV1,
  resolve: ResolveFabricDecisions,
): Promise<void> => {
  const respond = once(request.respond);
  try {
    const target = await resolve(request.context);
    if ("reason" in target) {
      respond({ ok: true, available: false, reason: target.reason });
      return;
    }
    respond({
      ok: true,
      available: true,
      inputs: ["text", "confirm", "select", "editor"],
      maxOptions: MAX_DECISION_OPTIONS,
      maxTitleChars: MAX_DECISION_TITLE_CHARS,
      maxBodyChars: MAX_DECISION_BODY_CHARS,
      maxTextChars: MAX_DECISION_TEXT_CHARS,
      minTimeoutMs: MIN_DECISION_TIMEOUT_MS,
      maxTimeoutMs: MAX_DECISION_DEADLINE_MS,
      supervisor: sourceMaySupervise(request.source, target.supervisorSources),
    });
  } catch (error) {
    respond({ ok: false, error: message(error) });
  }
};

export const answerFabricDecisionRequest = async (
  request: FabricDecisionRequestV1,
  resolve: ResolveFabricDecisions,
  lifetime?: AbortSignal,
): Promise<void> => {
  const respond = once(request.respond);
  // The session's lifetime ends a wait as the caller's own signal does.
  const signal = lifetime && request.signal ? AbortSignal.any([request.signal, lifetime]) : lifetime ?? request.signal;
  let raised: string | undefined;
  try {
    signal?.throwIfAborted();
    const raisedBy = raisedByFromSource(request.source);
    const target = await resolve(request.context);
    if ("reason" in target) {
      respond({ ok: false, error: target.reason });
      return;
    }
    // Resolving the store can await runtime startup; do not raise after an abort.
    signal?.throwIfAborted();
    const record = await raiseAndWait(
      target.store,
      decisionInputFromQuestion(request.question, supervisorFor(request, target)),
      raisedBy,
      signal,
      (id) => {
        raised = id;
        try {
          request.onRaised?.(id);
        } catch {
          // A failing observer must not strand the decision.
        }
      },
    );
    respond(decisionResult(record));
  } catch (error) {
    respond({
      ok: false,
      error: request.signal?.aborted
        ? "Decision request aborted"
        : lifetime?.aborted
          ? "Decision request aborted: the session shut down"
          : message(error),
      ...(raised ? { id: raised } : {}),
    });
  }
};
