/**
 * Stubbed Entra/JWT verification for the conformance suite.
 *
 * Replaces the live `jose` JWKS verifier (`auth/jose-verifier.ts`) with an
 * in-memory map from an opaque token string to its claims, so the suite runs
 * with no `jose`, no JWKS endpoint, and no real signed token. The authorization
 * logic under test — audience binding (SEC-1), tenant resolution (SEC-3), and
 * per-tool scope (SEC-2) — is the REAL {@link import("../../../src/auth/entra.js").EntraAuthenticator};
 * only the cryptographic verify step is stubbed.
 */
import type { JwtClaims, JwtVerifier } from "../../../src/auth/entra.js";

/** The audience the suite's tokens are bound to (RFC 8707 resource indicator). */
export const TEST_AUDIENCE = "api://hve-squad-mcp-test";
/** The issuer the suite's tokens carry. */
export const TEST_ISSUER = "https://login.microsoftonline.com/test-tenant/v2.0";

export interface FakeIdentity {
  /** The opaque bearer token string the caller presents. */
  token: string;
  /** The Entra tenant id this identity resolves to (SEC-3 isolation key). */
  tenantId: string;
  /** A stable subject id (oid/sub). */
  subject: string;
  /** Granted scopes (e.g. `Squad.Research`). */
  scopes: string[];
  /** Override the bound audience (default {@link TEST_AUDIENCE}). */
  audience?: string;
  /** Override the issuer (default {@link TEST_ISSUER}). */
  issuer?: string;
}

/** Build the JWT claims an identity resolves to. */
function claimsFor(identity: FakeIdentity): JwtClaims {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    iss: identity.issuer ?? TEST_ISSUER,
    aud: identity.audience ?? TEST_AUDIENCE,
    tid: identity.tenantId,
    oid: identity.subject,
    sub: identity.subject,
    scp: identity.scopes.join(" "),
    nbf: nowSec - 60,
    exp: nowSec + 3600,
  };
}

/** An in-memory {@link JwtVerifier}: known tokens resolve to claims; unknown tokens reject. */
export class FakeJwtVerifier implements JwtVerifier {
  private readonly byToken = new Map<string, JwtClaims>();

  /** Register an identity so its token verifies to the derived claims. */
  register(identity: FakeIdentity): FakeIdentity {
    this.byToken.set(identity.token, claimsFor(identity));
    return identity;
  }

  verify(token: string): Promise<JwtClaims> {
    const claims = this.byToken.get(token);
    if (!claims) {
      // Mirrors a signature/issuer/expiry failure in the live verifier.
      return Promise.reject(new Error("stub verify: unknown or invalid token"));
    }
    return Promise.resolve(claims);
  }
}

/** Format an `Authorization` header value for a token. */
export function bearer(token: string): string {
  return `Bearer ${token}`;
}
