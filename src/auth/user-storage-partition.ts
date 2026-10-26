import { createHash } from "node:crypto";
import { userPrincipalOf, type AuthContext, type UserPrincipal } from "./entra.js";

export function userStoragePartition(principal: UserPrincipal): string {
  return "user-" + createHash("sha256")
    .update(JSON.stringify([principal.tenantId, principal.objectId])).digest("hex");
}

/**
 * Internal storage partition, never a token issuer or an authorization tenant.
 * Every engine/store surface receives this partition in per-user mode, including
 * legacy memory resources, project identity indexes, binary artifacts and workers.
 */
export function withUserStoragePartition(auth: AuthContext): AuthContext {
  const principal = userPrincipalOf(auth);
  if (!principal) return auth;
  const partition = userStoragePartition(principal);
  return { ...auth, authorityTenantId: principal.tenantId, tenantId: partition };
}
