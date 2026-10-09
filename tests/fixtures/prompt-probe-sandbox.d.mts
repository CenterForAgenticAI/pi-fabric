import type { SpawnSyncReturns } from "node:child_process";
/** Fixture-only, fail-closed Linux x86-64 public-RPC sandbox. */
export function isolatedSpawn(root: string, command: string, args: string[], stdio?: "pipe" | "inherit"): SpawnSyncReturns<string>;
