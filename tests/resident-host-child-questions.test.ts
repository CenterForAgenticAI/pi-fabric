import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentRunRecord } from "../src/agents/types.js";
import { DEFAULT_FABRIC_CONFIG, type FabricAgentConfig } from "../src/config.js";
import { DecisionStore, type DecisionRecord } from "../src/decisions/store.js";
import { MeshStore, type MeshIdentity } from "../src/mesh/store.js";
import { runResidentHostFromConfigPath } from "../src/residency/host.js";
import {
  RESIDENT_HOST_FORMAT,
  residentHostId,
  residentRoot,
  type ResidentAgentMetadata,
  type ResidentCommandResponse,
  type ResidentHostConfig,
} from "../src/residency/protocol.js";
import { registerAgentRunner, type FabricRunnerCapabilities } from "../src/runners.js";
import { FabricControlPlane } from "../src/topology/control-plane.js";
import { rmTempSync } from "./fixtures/temp-cleanup.js";

// A durable run's child dialog, routed by the resident host itself: the host
// runs in this process and receives the same file requests a session's
// ResidencyClient writes. The answering side is a separate mesh handle, as the
// pi-fabric decisions CLI or another root session would be.

// The resident host always resolves a model, so the child must pass model admission first.
const fakePi = path.resolve("tests/fixtures/fake-pi-rpc-question-admitted.mjs");
const human = { answeredBy: "alice", via: "cli" };
const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const QUESTIONS_ONLY: FabricRunnerCapabilities = {
  recursiveFabric: false,
  steer: false,
  followUp: false,
  persistentSessions: false,
  kernels: false,
  handoff: false,
  modelDiscovery: false,
  imageInput: false,
  compaction: false,
  questions: true,
  sleep: false,
  writePolicy: false,
};

const waitFor = async (predicate: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for resident host state");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const readJson = <T>(file: string): T | undefined => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
};

const TERMINAL = new Set(["completed", "failed", "stopped", "timed_out"]);

interface Harness {
  config: ResidentHostConfig;
  decisions: DecisionStore;
  mesh: MeshStore;
}

const harness = async (agents: Partial<FabricAgentConfig>): Promise<Harness> => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-resident-question-"));
  cleanups.push(() => rmTempSync(root));
  const meshRoot = path.join(root, "mesh");
  const rootId = `session:resident-question:${randomUUID()}`;
  const mesh = { ...DEFAULT_FABRIC_CONFIG.mesh, enabled: true, actorPollMs: 20 };
  const config: ResidentHostConfig = {
    format: RESIDENT_HOST_FORMAT,
    rootId,
    sessionId: "resident-question",
    cwd: process.cwd(),
    projectRoot: process.cwd(),
    meshRoot,
    actorRoot: path.join(meshRoot, "actors"),
    sessionActorRoot: path.join(meshRoot, "actors", "resident-question"),
    residencyRoot: residentRoot(meshRoot, rootId),
    fullCodeMode: false,
    agents: { ...DEFAULT_FABRIC_CONFIG.agents, budgetUsd: 0, timeoutMs: 60_000, ...agents },
    mesh,
    retention: DEFAULT_FABRIC_CONFIG.retention,
    workerPath: path.resolve("src/worker.ts"),
    fabricExtensionPath: path.resolve("src/index.ts"),
    piBinary: fakePi,
    claudeBinary: "claude",
    vedaBinary: "veda",
    piModels: {
      available: [{ provider: "provider", id: "visible", name: "Visible" }],
      aliases: {},
      defaultModel: "provider/visible",
    },
  };
  fs.mkdirSync(config.residencyRoot, { recursive: true });
  const configPath = path.join(config.residencyRoot, "config.json");
  fs.writeFileSync(configPath, JSON.stringify(config));
  const controller = new AbortController();
  const running = runResidentHostFromConfigPath(configPath, controller.signal);
  cleanups.push(async () => {
    controller.abort();
    await running;
  });
  await waitFor(() => fs.existsSync(path.join(config.residencyRoot, "owner.json")));
  const store = new MeshStore(meshRoot, mesh.maxEventBytes, mesh.maxReadEvents);
  const answerer: MeshIdentity = { id: `${rootId}:answerer`, name: "answerer", kind: "main", sessionId: "answerer" };
  return { config, mesh: store, decisions: new DecisionStore(store, answerer) };
};

/** Submit a durable spawn exactly as ResidencyClient does, through the request directory. */
const spawnDurable = async (
  config: ResidentHostConfig,
  request: { task: string; runner: string; transport?: "process" },
): Promise<{ id: string; runDirectory: string }> => {
  const requestId = randomUUID();
  const requests = path.join(config.residencyRoot, "requests");
  const pending = path.join(requests, `${requestId}.json.partial`);
  fs.writeFileSync(pending, JSON.stringify({
    format: RESIDENT_HOST_FORMAT,
    operation: "spawn",
    requestId,
    rootId: config.rootId,
    request: {
      task: request.task,
      runner: request.runner,
      ...(request.transport ? { transport: request.transport } : {}),
      residency: "durable",
    },
    createdAt: Date.now(),
  }));
  fs.renameSync(pending, path.join(requests, `${requestId}.json`));
  const responsePath = path.join(config.residencyRoot, "responses", `${requestId}.json`);
  await waitFor(() => readJson<ResidentCommandResponse>(responsePath) !== undefined);
  const response = readJson<ResidentCommandResponse>(responsePath)!;
  expect(response.error).toBeUndefined();
  const id = response.handle!.id;
  const metadata = readJson<ResidentAgentMetadata>(path.join(config.residencyRoot, "agents", `${id}.json`))!;
  return { id, runDirectory: metadata.runDirectory };
};

const runRecord = (runDirectory: string): AgentRunRecord | undefined =>
  readJson<AgentRunRecord>(path.join(runDirectory, "status.json"));

/** The run's open question decision, or a failure naming how the run settled instead. */
const openQuestion = async (state: Harness, runDirectory: string): Promise<DecisionRecord> => {
  let open: DecisionRecord | undefined;
  let settled: AgentRunRecord | undefined;
  await waitFor(async () => {
    [open] = await state.decisions.list({ status: "open" });
    const record = runRecord(runDirectory);
    if (record && TERMINAL.has(record.status)) settled = record;
    return open !== undefined || settled !== undefined;
  });
  expect(open, `no decision opened; the run settled ${settled?.status} with ${settled?.text ?? settled?.error}`)
    .toBeDefined();
  return open!;
};

const settledRecord = async (runDirectory: string): Promise<AgentRunRecord> => {
  await waitFor(() => TERMINAL.has(runRecord(runDirectory)?.status ?? ""));
  return runRecord(runDirectory)!;
};

/** A hosted runner that asks one question and finishes with the answer it received. */
const registerAskOnce = (id: string): { stops: string[] } => {
  const stops: string[] = [];
  cleanups.push(registerAgentRunner({
    kind: "hosted",
    id,
    label: "Ask once",
    capabilities: QUESTIONS_ONLY,
    prepare: (context) => ({ job: context.idempotencyKey }),
    start(_locator, _context, reporter) {
      void reporter
        .question({ method: "select", title: "Pick a colour", options: ["red", "blue"] })
        .then((answer) => reporter.finish({ status: "completed", output: JSON.stringify(answer) }));
    },
    attach() {},
    liveness: () => "running",
    stop: (_locator, reason) => {
      stops.push(reason);
      return { confirmed: true };
    },
  }));
  return { stops };
};

describe("resident host routed child questions", () => {
  it("turns a durable hosted run's question into a root-held decision and returns the answer", { timeout: 30_000 }, async () => {
    registerAskOnce("ask-once");
    const state = await harness({ childQuestions: "route", childQuestionTimeoutMs: 30_000 });
    const run = await spawnDurable(state.config, { task: "ask", runner: "ask-once" });

    const decision = await openQuestion(state, run.runDirectory);
    expect(decision).toMatchObject({
      kind: "question",
      holder: "root",
      input: "select",
      options: [{ id: "o1", label: "red" }, { id: "o2", label: "blue" }],
      raisedBy: { participantId: run.id, runId: run.id, sessionId: state.config.sessionId },
      onExpire: "cancel",
    });
    expect(decision.title).toMatch(/: Pick a colour$/);
    expect(runRecord(run.runDirectory)).toMatchObject({ status: "running", blockedOn: { since: expect.any(Number) } });

    await state.decisions.answer(decision.id, { optionId: "o2" }, human);
    const result = await settledRecord(run.runDirectory);
    expect(result).toMatchObject({ status: "completed", text: JSON.stringify({ value: "blue" }) });
    expect(result.blockedOn).toBeUndefined();
  });

  it("cancels the open decision when the durable run is stopped", { timeout: 30_000 }, async () => {
    const adapter = registerAskOnce("ask-stop");
    const state = await harness({ childQuestions: "route", childQuestionTimeoutMs: 30_000 });
    const run = await spawnDurable(state.config, { task: "ask", runner: "ask-stop" });
    const decision = await openQuestion(state, run.runDirectory);

    const peer: MeshIdentity = { id: `${state.config.rootId}:peer`, name: "peer", kind: "main", sessionId: "peer" };
    const control = new FabricControlPlane(state.mesh, peer, {
      enabled: true,
      hostId: peer.id,
      pollMs: 20,
      acknowledgementTimeoutMs: 5_000,
    });
    control.start(() => ({ accepted: false }));
    cleanups.push(() => control.close());
    const hostId = residentHostId(state.config.rootId);
    await control.request(hostId, run.id, "stop", {}, hostId);

    expect(await settledRecord(run.runDirectory)).toMatchObject({ status: "stopped" });
    expect(adapter.stops).toEqual(["requested"]);
    await waitFor(async () => (await state.decisions.get(decision.id))?.status !== "open");
    expect(await state.decisions.get(decision.id)).toMatchObject({
      status: "cancelled",
      answer: { answeredBy: hostId, via: "abort" },
    });
  });

  it.skipIf(process.platform === "win32")(
    "routes a durable pi-runner worker's dialog through a root-held decision",
    { timeout: 45_000 },
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-resident-question-log-"));
      cleanups.push(() => rmTempSync(root));
      const log = path.join(root, "responses.jsonl");
      process.env.FAKE_PI_QUESTION_LOG = log;
      cleanups.push(() => {
        delete process.env.FAKE_PI_QUESTION_LOG;
      });
      const state = await harness({ childQuestions: "route", childQuestionTimeoutMs: 30_000 });
      const run = await spawnDurable(state.config, { task: "ASK", runner: "pi", transport: "process" });

      const decision = await openQuestion(state, run.runDirectory);
      expect(decision).toMatchObject({
        kind: "question",
        holder: "root",
        options: [{ id: "o1", label: "A" }, { id: "o2", label: "B" }],
        raisedBy: { runId: run.id },
      });
      await state.decisions.answer(decision.id, { optionId: "o2" }, human);

      const settled = await settledRecord(run.runDirectory);
      expect(settled.error).toBeUndefined();
      expect(settled).toMatchObject({ status: "completed" });
      const responses = fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
      expect(responses).toEqual([{ type: "extension_ui_response", id: "ui-1", value: "B" }]);
    },
  );

  it("still cancels a durable child's question when childQuestions is not route", { timeout: 30_000 }, async () => {
    registerAskOnce("ask-cancel");
    const state = await harness({ childQuestions: "cancel" });
    const run = await spawnDurable(state.config, { task: "ask", runner: "ask-cancel" });
    expect(await settledRecord(run.runDirectory)).toMatchObject({
      status: "completed",
      text: JSON.stringify({ cancelled: true }),
    });
    expect(await state.decisions.list()).toEqual([]);
  });
});
