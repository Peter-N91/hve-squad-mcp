/**
 * Field cipher (WI-06 / MEDIUM-3) — AES-256-GCM encryption at rest for the
 * caller's request/context on the durable run record.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";

import {
  AesGcmFieldCipher,
  NullFieldCipher,
  decryptField,
  encryptField,
} from "../src/engine/field-cipher.js";

const KEY = randomBytes(32);

test("AES-GCM round-trips a field and hides the plaintext", () => {
  const cipher = new AesGcmFieldCipher(KEY);
  const plaintext = "improve caching; SECRET-MARKER-42";
  const sealed = cipher.encrypt(plaintext);
  assert.notEqual(sealed, plaintext);
  assert.ok(!sealed.includes("SECRET-MARKER-42"), "ciphertext does not leak the plaintext");
  assert.ok(sealed.startsWith("gcm1:"), "the envelope is tagged");
  assert.equal(cipher.decrypt(sealed), plaintext);
});

test("each encryption uses a fresh IV (identical plaintext -> different ciphertext)", () => {
  const cipher = new AesGcmFieldCipher(KEY);
  const a = cipher.encrypt("same");
  const b = cipher.encrypt("same");
  assert.notEqual(a, b, "a fresh IV per field yields distinct envelopes");
  assert.equal(cipher.decrypt(a), "same");
  assert.equal(cipher.decrypt(b), "same");
});

test("a tampered envelope fails the auth tag (integrity)", () => {
  const cipher = new AesGcmFieldCipher(KEY);
  const sealed = cipher.encrypt("authentic");
  // Flip a base64 char in the body.
  const tampered = sealed.slice(0, -2) + (sealed.endsWith("A") ? "B" : "A") + sealed.slice(-1);
  assert.throws(() => cipher.decrypt(tampered));
});

test("decrypt passes through non-enveloped (legacy plaintext) values", () => {
  const cipher = new AesGcmFieldCipher(KEY);
  assert.equal(cipher.decrypt("not-an-envelope"), "not-an-envelope");
});

test("a wrong key cannot decrypt", () => {
  const sealed = new AesGcmFieldCipher(KEY).encrypt("secret");
  const other = new AesGcmFieldCipher(randomBytes(32));
  assert.throws(() => other.decrypt(sealed));
});

test("fromBase64Key builds a working cipher; a non-32-byte key is rejected", () => {
  const b64 = KEY.toString("base64");
  const cipher = AesGcmFieldCipher.fromBase64Key(b64);
  assert.equal(cipher.decrypt(cipher.encrypt("x")), "x");
  assert.throws(() => new AesGcmFieldCipher(randomBytes(16)), /32-byte/);
});

test("NullFieldCipher is an identity passthrough", () => {
  const cipher = new NullFieldCipher();
  assert.equal(cipher.encrypts, false);
  assert.equal(cipher.encrypt("x"), "x");
  assert.equal(cipher.decrypt("x"), "x");
});

test("encryptField/decryptField leave undefined untouched", () => {
  const cipher = new AesGcmFieldCipher(KEY);
  assert.equal(encryptField(cipher, undefined), undefined);
  assert.equal(decryptField(cipher, undefined), undefined);
  const sealed = encryptField(cipher, "v");
  assert.equal(decryptField(cipher, sealed), "v");
});
