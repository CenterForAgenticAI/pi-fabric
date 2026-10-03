#!/usr/bin/env node
// Only the five-minute initial-turn clock is accelerated. No production flag,
// environment override, recovery clock, overall deadline or kill timer changes.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (callback, delay, ...args) => realSetTimeout(callback, delay === 300_000 ? 250 : delay, ...args);
await import("../../dist/worker.js");
