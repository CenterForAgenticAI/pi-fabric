import { createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Auth-only provider: available to /login, never advertised as a chat model. */
export const createJevAuthProvider = () => createProvider({
  id: "jev",
  name: "Jev (TypeSafe System One)",
  baseUrl: "https://api.typesafe.ai/v1",
  auth: { apiKey: envApiKeyAuth("TypeSafe API key", ["TYPESAFE_API_KEY"]) },
  models: [],
  api: {},
});
export function registerJevAuth(pi: ExtensionAPI): void {
  // Keep lightweight test/managed adapters without provider registration usable.
  if (typeof pi.registerProvider === "function") pi.registerProvider(createJevAuthProvider());
}
