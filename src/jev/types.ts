export type JevJson = null | boolean | number | string | JevJson[] | { [key: string]: JevJson };
export type JevDescription = string | JevJson[] | { [key: string]: JevJson };
export type JevQuestion =
  | { type: "noul"; instructions: JevDescription; criteria?: { true?: JevDescription; false?: JevDescription } }
  | { type: "choice"; instructions: JevDescription; criteria: Record<string, JevDescription | null> }
  | { type: "score"; instructions: JevDescription; criteria: JevDescription[] };
export interface JevRequest {
  state: string | JevJson[] | { [key: string]: JevJson };
  questions: Record<string, JevQuestion>;
  model?: string;
}
export type JevAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: "score"; score: number; confidence: number; probabilities: Record<string, number>; legend: Record<string, JevJson> };
export interface JevResponse {
  model: string;
  answers: Record<string, JevAnswer>;
  usage: { input_tokens: number; output_tokens: number };
}
export interface JevProgram {
  name: string;
  code: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  requires: string[];
  limits?: { timeoutMs?: number; maxEvaluations?: number; maxToolCalls?: number; maxTokens?: number };
}
export interface JevLaunch { program: JevProgram; input: JevJson }
export type JevRunState = "running" | "completed" | "failed" | "cancelled" | "timed_out";
export interface JevEvent { sequence: number; at: number; value: JevJson }
export interface JevRunInfo {
  id: string;
  name: string;
  state: JevRunState;
  background: boolean;
  startedAt: number;
  endedAt?: number;
  result?: JevJson;
  error?: string;
  evaluations: number;
  toolCalls: number;
  usage: { input_tokens: number; output_tokens: number };
  events: JevEvent[];
  nextSequence: number;
  logs: string[];
}
