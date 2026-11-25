import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { PrincipalVault } from "../src/auth/principal-vault.js";

test("credential envelopes bind tenant, user, field and key version with authenticated encryption", () => {
  const key = randomBytes(32);
  const vault = new PrincipalVault("v1", { v1: key });
  const encoded = vault.seal("tenant|alice|access", "SYNTHETIC-CREDENTIAL");
  assert.doesNotMatch(encoded, /SYNTHETIC-CREDENTIAL/);
  assert.equal(vault.open("tenant|alice|access", encoded), "SYNTHETIC-CREDENTIAL");
  for (const binding of ["tenant|bob|access", "other|alice|access", "tenant|alice|refresh"]) {
    assert.throws(() => vault.open(binding, encoded), /authentication failed/);
  }
  assert.throws(() => vault.open("tenant|alice|access", encoded.replace(".v1.", ".missing.")), /authentication failed/);
  assert.throws(() => vault.open("tenant|alice|access", "plaintext"), /authentication failed/);
});

test("key rotation reads previous envelopes and always writes the new key ID", () => {
  const previous = randomBytes(32);
  const current = randomBytes(32);
  const old = new PrincipalVault("previous", { previous }).seal("principal", { token: "synthetic" });
  const rotated = new PrincipalVault("current", { previous, current });
  assert.deepEqual(rotated.open("principal", old), { token: "synthetic" });
  const fresh = rotated.seal("principal", { token: "rotated" });
  assert.match(fresh, /^v1\.current\./);
  assert.throws(() => new PrincipalVault("current", { current }).open("principal", old), /authentication failed/);
});
