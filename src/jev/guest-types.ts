export const JEV_GUEST_DECLARATIONS = `
type FabricJevJson = null | boolean | number | string | FabricJevJson[] | { [key: string]: FabricJevJson };
type FabricJevDescription = string | FabricJevJson[] | { [key: string]: FabricJevJson };
type FabricJevQuestion =
  | { type: "noul"; instructions: FabricJevDescription; criteria?: { true?: FabricJevDescription; false?: FabricJevDescription } }
  | { type: "choice"; instructions: FabricJevDescription; criteria: Record<string, FabricJevDescription | null> }
  | { type: "score"; instructions: FabricJevDescription; criteria: FabricJevDescription[] };
type FabricJevAnswer<Q extends FabricJevQuestion> = Q extends { type: "noul" }
  ? { type: "noul"; noul: number }
  : Q extends { type: "choice"; criteria: infer C }
  ? { type: "choice"; choice: Extract<keyof C, string>; confidence: number; probabilities: Record<Extract<keyof C, string>, number> }
  : { type: "score"; score: number; confidence: number; probabilities: Record<string, number>; legend: Record<string, FabricJevJson> };
interface FabricJevProgram {
  name: string;
  code: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  requires: string[];
  limits?: { timeoutMs?: number; maxEvaluations?: number; maxToolCalls?: number; maxTokens?: number };
}
interface FabricJevRun<T = unknown> {
  id: string; name: string; state: "running" | "completed" | "failed" | "cancelled" | "timed_out";
  background: boolean; startedAt: number; endedAt?: number; result?: T; error?: string;
  evaluations: number; toolCalls: number; usage: { input_tokens: number; output_tokens: number };
  events: Array<{ sequence: number; at: number; value: FabricJevJson }>; nextSequence: number; logs: string[];
}
interface FabricJevApi {
  evaluate<Q extends Record<string, FabricJevQuestion>>(args: {
    state: string | FabricJevJson[] | { [key: string]: FabricJevJson }; questions: Q; model?: string;
  }): Promise<{ model: string; answers: { [K in keyof Q]: FabricJevAnswer<Q[K]> }; usage: { input_tokens: number; output_tokens: number } }>;
  run<T = unknown>(args: { program: FabricJevProgram; input: FabricJevJson }): Promise<FabricJevRun<T>>;
  spawn(args: { program: FabricJevProgram; input: FabricJevJson }): Promise<FabricJevRun>;
  status(args?: { id?: never; after?: never }): Promise<{ credentials: { configured: boolean; source: "pi" | "environment" | "command" | "missing"; verified: boolean }; model: string; runs: Array<{ id: string; name: string; state: string; background: boolean; startedAt: number; evaluations: number; toolCalls: number }> }>;
  status<T = unknown>(args: { id: string; after?: number }): Promise<FabricJevRun<T>>;
  wait<T = unknown>(args: { id: string }): Promise<FabricJevRun<T>>;
  /** Alias for wait. */
  join<T = unknown>(args: { id: string }): Promise<FabricJevRun<T>>;
  stop(args: { id: string }): Promise<FabricJevRun>;
}
declare const jev: FabricJevApi;
`;
