/**
 * Production JWT verifier backed by `jose` (live only).
 *
 * Isolated in its own module so that:
 *   * the `jose` dependency is loaded ONLY by the live HTTP bootstrap, and
 *   * the auth authorization logic in `entra.ts` stays unit-testable with a fake
 *     {@link JwtVerifier} (no network, no real signed token).
 *
 * It validates the cryptographic and temporal facts only — RS256 signature
 * against the tenant's published JWKS, issuer, and expiry/not-before. Audience,
 * tenant, and scope authorization remain the authenticator's responsibility
 * (see `entra.ts`), so the trust decisions live in one tested place.
 */
import { createRemoteJWKSet, jwtVerify } from "jose";

import type { JwtClaims, JwtVerifier } from "./entra.js";

export interface JoseVerifierOptions {
  /** The JWKS endpoint, e.g. `https://login.microsoftonline.com/<tenant>/discovery/v2.0/keys`. */
  jwksUri: string;
  /** Expected issuer(s); passed to `jose` for issuer validation. */
  issuer?: string | string[];
  /** Clock tolerance in seconds for `exp`/`nbf` (default 60). */
  clockToleranceSec?: number;
}

/**
 * Build a {@link JwtVerifier} that verifies tokens against a remote JWKS. The
 * JWKS is fetched and cached by `jose` (with its own rotation handling), so the
 * returned verifier is safe to reuse across requests.
 */
export function createJoseVerifier(options: JoseVerifierOptions): JwtVerifier {
  const jwks = createRemoteJWKSet(new URL(options.jwksUri));
  return {
    async verify(token: string): Promise<JwtClaims> {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: options.issuer,
        clockTolerance: options.clockToleranceSec ?? 60,
      });
      return payload as JwtClaims;
    },
  };
}
