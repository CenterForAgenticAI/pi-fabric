#!/usr/bin/env node
import { registerHooks } from "node:module";
import { parseDurableWorkerOptions } from "./worker-options.js";

try {
  // This process-only entry is never imported by extension registration.
  const options = parseDurableWorkerOptions(process.argv.slice(2));
  // Managed Pi installs omit host peers. A subprocess cannot use Main's virtual
  // modules, so it owns a pinned SDK under a non-peer name. Resolve all Pi peers
  // through that SDK's dependency tree (also with non-hoisting installers), not
  // an ambient checkout or another extension's SDK. This hook is process-local
  // and must be installed before importing any durable host/engine modules.
  const sdkEntry = import.meta.resolve("pi-fabric-worker-sdk");
  const sdkName = "@earendil-works/pi-coding-agent";
  const peers = ["@earendil-works/pi-agent-core", "@earendil-works/pi-ai", "@earendil-works/pi-tui", "typebox"];
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === sdkName || specifier.startsWith(`${sdkName}/`)) {
        return nextResolve(`pi-fabric-worker-sdk${specifier.slice(sdkName.length)}`, { ...context, parentURL: import.meta.url });
      }
      if (peers.some(name => specifier === name || specifier.startsWith(`${name}/`))) {
        return nextResolve(specifier, { ...context, parentURL: sdkEntry });
      }
      return nextResolve(specifier, context);
    },
  });
  const { runDurableWorker } = await import("./worker-host.js");
  await runDurableWorker(options);
} catch (error) {
  process.stderr.write(`Durable Pi worker failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}
