import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { EntraAuthenticator, userPrincipalOf } from "../../src/auth/entra.js";
import { createJoseVerifier } from "../../src/auth/jose-verifier.js";
import { RedactingLogger } from "../../src/observability/logger.js";
import { withUserStoragePartition } from "../../src/auth/user-storage-partition.js";

test("real signed tokens from both host clients resolve one user; wrong audiences, expired tokens and unsigned data fail", async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { modulusLength: 2048 });
  const jwk = { ...await exportJWK(publicKey), kid: "synthetic-key", alg: "RS256", use: "sig" };
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address.");
  const issuer = "https://issuer.example.test/tenant/v2.0";
  const audience = "api://synthetic-resource";
  const auth = new EntraAuthenticator({
    audiences: [audience], allowedIssuers: [issuer], allowedTenants: ["tenant"],
    allowedClientsByAudience: { [audience]: ["cowork", "studio"] }, requireDelegatedUser: true,
    verifier: createJoseVerifier({ jwksUri: `http://127.0.0.1:${address.port}/keys`, issuer, clockToleranceSec: 0 }),
    logger: new RedactingLogger({ name: "signed-identity-test", sink: () => {} }),
  });
  const sign = (client: string, target = audience, expiry = Math.floor(Date.now() / 1000) + 600) =>
    new SignJWT({ tid: "tenant", oid: "alice", sub: `pairwise-${client}`, azp: client, scp: "Squad.Run" })
      .setProtectedHeader({ alg: "RS256", kid: jwk.kid }).setIssuer(issuer)
      .setAudience(target).setIssuedAt().setExpirationTime(expiry).sign(privateKey);
  try {
    const cowork = await auth.authenticate(`Bearer ${await sign("cowork")}`);
    const studio = await auth.authenticate(`Bearer ${await sign("studio")}`);
    assert.deepEqual(userPrincipalOf(cowork), userPrincipalOf(studio));
    assert.equal(withUserStoragePartition(cowork).tenantId, withUserStoragePartition(studio).tenantId);
    await assert.rejects(auth.authenticate(`Bearer ${await sign("cowork", "api://other")}`), /audience/);
    await assert.rejects(auth.authenticate(`Bearer ${await sign("unapproved-client")}`), /client/);
    await assert.rejects(auth.authenticate(`Bearer ${await sign("cowork", audience, 1)}`), /verification/);
    await assert.rejects(auth.authenticate("Bearer unsigned-claims"), /verification/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
