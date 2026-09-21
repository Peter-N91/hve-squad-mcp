const MISE_VALIDATION_PATH = "/ValidateRequest";
const MISE_PORT = "5000";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]"]);

/**
 * Normalize and constrain the MISE validation endpoint. The verifier forwards
 * bearer tokens to this URL, so only the pod-local sidecar may be configured.
 */
export function normalizeMiseValidationEndpoint(value: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error("SQUAD_MCP_MISE_ENDPOINT must be an absolute URL.");
  }
  if (
    endpoint.protocol !== "http:" ||
    !LOOPBACK_HOSTS.has(endpoint.hostname) ||
    endpoint.port !== MISE_PORT ||
    endpoint.pathname !== MISE_VALIDATION_PATH ||
    endpoint.username.length > 0 ||
    endpoint.password.length > 0 ||
    endpoint.search.length > 0 ||
    endpoint.hash.length > 0
  ) {
    throw new Error(
      "SQUAD_MCP_MISE_ENDPOINT must be the loopback MISE sidecar endpoint " +
        "http://127.0.0.1:5000/ValidateRequest (or its IPv6 loopback equivalent).",
    );
  }
  return endpoint.toString();
}
