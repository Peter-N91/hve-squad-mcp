/**
 * Managed-identity token provider for Azure OpenAI (live only).
 *
 * Isolated so `@azure/identity` loads ONLY in the deployed process — the AOAI
 * backend, the embedded engine, and every test stay free of the Azure SDK and
 * run without it. The live HTTP bootstrap (`server-http.ts`) wires this provider
 * into the backend.
 *
 * SEC-10: no secret is embedded or configured here. `DefaultAzureCredential`
 * resolves the Container App's user-assigned (or system-assigned) managed
 * identity at runtime; the returned token is registered with the logger for
 * redaction by the backend. If a Key-Vault-stored API key is preferred over
 * managed identity, fetch it from Key Vault in the bootstrap and pass a provider
 * that returns it instead — never read a key from plain environment or code.
 */
import { DefaultAzureCredential } from "@azure/identity";

/** The Cognitive Services scope Azure OpenAI tokens are minted for. */
export const COGNITIVE_SERVICES_SCOPE = "https://cognitiveservices.azure.com/.default";

/**
 * Build a token provider that returns a fresh Azure OpenAI access token from the
 * deployment's managed identity. The provider throws if no token can be acquired
 * (fail-fast at first call rather than silently degrading).
 */
export function createManagedIdentityTokenProvider(
  scope: string = COGNITIVE_SERVICES_SCOPE,
): () => Promise<string> {
  const credential = new DefaultAzureCredential();
  return async () => {
    const token = await credential.getToken(scope);
    if (!token) {
      throw new Error("Failed to acquire a managed-identity token for Azure OpenAI.");
    }
    return token.token;
  };
}
