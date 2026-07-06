/**
 * Field-level encryption at rest (WI-06 / MEDIUM-3).
 *
 * The async run record persists the caller's `request`/`context` so a later
 * status poll (or a worker) can drive the pipeline after approval. In the durable
 * store that data is at rest — on the local disk (dev) or in Azure Table Storage
 * (prod). Azure encrypts storage at rest with platform keys already, but the
 * council flagged the caller's own prompt text as sensitive enough to warrant
 * APPLICATION-level envelope encryption so it is opaque even to an operator with
 * raw table access (defense in depth; MEDIUM-3, latent-HIGH once the durable
 * store lands).
 *
 * This module is dependency-free: it uses Node's built-in `crypto` (AES-256-GCM),
 * so it compiles and tests without any Azure SDK. The 32-byte data key is
 * operator-provided (sourced from Key Vault as base64), never embedded in code or
 * derived from caller input.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** Encrypts/decrypts a single string field before it is persisted. */
export interface FieldCipher {
  /** Whether this cipher actually encrypts (false for the identity cipher). */
  readonly encrypts: boolean;
  /** Encrypt a plaintext field; the result is safe to store as-is. */
  encrypt(plaintext: string): string;
  /** Decrypt a value produced by {@link encrypt}; passes through unrecognized input. */
  decrypt(ciphertext: string): string;
}

/**
 * Identity cipher — stores fields verbatim. The default for the ephemeral store
 * and local-file dev, where no key is configured. Production wires
 * {@link AesGcmFieldCipher}.
 */
export class NullFieldCipher implements FieldCipher {
  readonly encrypts = false;
  encrypt(plaintext: string): string {
    return plaintext;
  }
  decrypt(ciphertext: string): string {
    return ciphertext;
  }
}

/** Prefix marking an AES-GCM envelope so decrypt can distinguish it from plaintext. */
const ENVELOPE_PREFIX = "gcm1:";

/**
 * AES-256-GCM field cipher. The envelope is `gcm1:<base64(iv|tag|ciphertext)>`;
 * a fresh 12-byte IV is generated per field, and the 16-byte auth tag makes
 * tampering detectable. `decrypt` returns non-enveloped input unchanged so a
 * migration from plaintext records does not break reads.
 */
export class AesGcmFieldCipher implements FieldCipher {
  readonly encrypts = true;
  private readonly key: Buffer;

  /** @param key a 32-byte (256-bit) data key (operator-provided, from Key Vault). */
  constructor(key: Buffer) {
    if (key.length !== 32) {
      throw new Error("AesGcmFieldCipher requires a 32-byte key.");
    }
    this.key = key;
  }

  /** Build a cipher from a base64-encoded 32-byte key (the operator-config form). */
  static fromBase64Key(base64Key: string): AesGcmFieldCipher {
    const key = Buffer.from(base64Key, "base64");
    return new AesGcmFieldCipher(key);
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ENVELOPE_PREFIX + Buffer.concat([iv, tag, ciphertext]).toString("base64");
  }

  decrypt(value: string): string {
    if (!value.startsWith(ENVELOPE_PREFIX)) {
      // Not an envelope (legacy plaintext / already-clear) — pass through.
      return value;
    }
    const raw = Buffer.from(value.slice(ENVELOPE_PREFIX.length), "base64");
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const ciphertext = raw.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  }
}

/** Encrypt an optional field (leaves `undefined` untouched). */
export function encryptField(cipher: FieldCipher, value: string | undefined): string | undefined {
  return value === undefined ? undefined : cipher.encrypt(value);
}

/** Decrypt an optional field (leaves `undefined` untouched). */
export function decryptField(cipher: FieldCipher, value: string | undefined): string | undefined {
  return value === undefined ? undefined : cipher.decrypt(value);
}
