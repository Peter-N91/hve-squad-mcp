import assert from "node:assert/strict";
import { test } from "node:test";
import { AuthError, EntraAuthenticator, userPrincipalOf, type JwtClaims } from "../../src/auth/entra.js";
import { RedactingLogger } from "../../src/observability/logger.js";

const audience = "api://test-resource";
const issuer = "https://issuer.example.test/tenant/v2.0";
const logger = new RedactingLogger({ name: "test", sink: () => {} });
function auth(claims: JwtClaims, strict = true) {
  return new EntraAuthenticator({
    audiences: [audience], allowedIssuers: [issuer], allowedTenants: ["tenant"],
    allowedClientsByAudience: { [audience]: ["cowork", "studio", "operator"] },
    requireDelegatedUser: strict,
    verifier: { verify: async () => ({
      iss: issuer, aud: audience, tid: "tenant", oid: "alice", sub: "pairwise",
      azp: "cowork", ...claims,
    }) },
    logger,
  });
}
function reason(code: string) {
  return (error: unknown) => error instanceof AuthError && error.reason === code;
}

test("per-user trust refuses app-only, ID-token-like and oid-less callers", async () => {
  await assert.rejects(auth({ idtyp: "app", roles: ["Squad.Run"] }).authenticate("Bearer synthetic"), reason("delegated_user_required"));
  await assert.rejects(auth({}).authenticate("Bearer synthetic"), reason("delegated_user_required"));
  await assert.rejects(auth({ roles: ["Squad.Operate"], nonce: "id-token-nonce" }).authenticate("Bearer synthetic"),
    reason("delegated_user_required"));
  await assert.rejects(auth({ oid: undefined, scp: "Squad.Run" }).authenticate("Bearer synthetic"), reason("delegated_user_required"));
});

test("delegated scopes and app roles are separate in user mode", async () => {
  const a = auth({ scp: "Squad.Memory", roles: ["Squad.Run"] });
  const caller = await a.authenticate("Bearer synthetic");
  assert.deepEqual(userPrincipalOf(caller), { tenantId: "tenant", objectId: "alice" });
  assert.throws(() => a.authorizeTool(caller, "squad_run"), reason("missing_scope"));
  assert.doesNotThrow(() => a.authorizeTool(caller, "squad_memory_read"));
});

test("operators can approve but cannot borrow a user credential or run as a service principal", async () => {
  const a = auth({ scp: undefined, idtyp: "app", roles: ["Squad.Operate"], azp: "operator" });
  const operator = await a.authenticate("Bearer synthetic");
  assert.equal(userPrincipalOf(operator), undefined);
  assert.doesNotThrow(() => a.authorizeApproval(operator));
  assert.doesNotThrow(() => a.authorizeTool(operator, "squad_approve"));
  assert.throws(() => a.authorizeTool(operator, "squad_run"), reason("delegated_user_required"));
});

test("legacy explicitly configured service-role mode remains supported", async () => {
  const a = auth({ idtyp: "app", roles: ["Squad.Run"] }, false);
  const service = await a.authenticate("Bearer synthetic");
  assert.doesNotThrow(() => a.authorizeTool(service, "squad_run"));
  assert.equal(userPrincipalOf(service), undefined);
});

test("user mode requires explicit trust restrictions rather than accepting any client", () => {
  assert.throws(() => new EntraAuthenticator({
    audiences: [audience], requireDelegatedUser: true, verifier: { verify: async () => ({}) }, logger,
  }), /requires issuer, tenant/);
});
