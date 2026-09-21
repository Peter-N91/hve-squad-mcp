/**
 * MISE Container v2 verifier.
 *
 * MISE performs the cryptographic and temporal validation in a pod-local
 * sidecar. On its exact HTTP 200 success response, this adapter decodes claims
 * from the same JWT for the application's existing audience, issuer, tenant,
 * and scope authorization. Any MISE, timeout, redirect, or decode failure is
 * fail-closed; response bodies and bearer tokens are never logged.
 */
import { decodeJwt } from "jose";

import type {
  JwtClaims,
  JwtVerificationContext,
  JwtVerifier,
} from "./entra.js";
import { normalizeMiseValidationEndpoint } from "./mise-endpoint.js";

export interface MiseVerifierOptions {
  endpoint: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function requireContext(
  context: JwtVerificationContext | undefined,
): JwtVerificationContext {
  if (
    !context ||
    context.originalUri.trim().length === 0 ||
    context.originalMethod.trim().length === 0 ||
    context.forwardedFor.trim().length === 0
  ) {
    throw new Error("MISE verification requires original request metadata.");
  }
  return context;
}

/** Build a verifier backed by the pod-local MISE Container validation endpoint. */
export function createMiseVerifier(options: MiseVerifierOptions): JwtVerifier {
  const endpoint = normalizeMiseValidationEndpoint(options.endpoint);
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new Error("MISE validation timeout must be an integer from 100 to 60000 milliseconds.");
  }
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async verify(
      token: string,
      verificationContext?: JwtVerificationContext,
    ): Promise<JwtClaims> {
      const context = requireContext(verificationContext);
      const response = await fetchImpl(endpoint, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          Authorization: `Bearer ${token}`,
          "Original-Uri": context.originalUri,
          "Original-Method": context.originalMethod,
          "X-Forwarded-For": context.forwardedFor,
        },
      });
      if (response.status !== 200) {
        throw new Error(`MISE request validation failed with status ${response.status}.`);
      }
      return decodeJwt(token) as JwtClaims;
    },
  };
}
