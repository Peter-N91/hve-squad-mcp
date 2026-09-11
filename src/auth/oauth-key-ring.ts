/**
 * Rotatable cryptographic key ring for the server-owned OAuth authority.
 *
 * One operator-provided 32-byte master key derives independent subkeys for JWT
 * signing, HMAC envelopes, and persisted-grant encryption. The first configured
 * key signs new material; all configured keys verify/decrypt during rotation.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { decodeProtectedHeader, jwtVerify, SignJWT } from "jose";

import type {
  JwtClaims,
  JwtVerificationContext,
  JwtVerifier,
} from "./entra.js";

interface DerivedKey {
  kid: string;
  jwt: Uint8Array;
  envelope: Buffer;
  storage: Buffer;
}

interface TimedEnvelope {
  exp: number;
}

const textEncoder = new TextEncoder();
const HKDF_SALT = textEncoder.encode("hve-squad-simple-oauth-v1");

function derive(master: Buffer, info: string): Buffer {
  return Buffer.from(hkdfSync("sha256", master, HKDF_SALT, textEncoder.encode(info), 32));
}

function safeEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

function parseJsonObject(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("OAuth envelope payload must be an object.");
  }
  return parsed as Record<string, unknown>;
}

export interface LocalAccessTokenInput {
  tenantId: string;
  subject: string;
  scopes: string[];
  clientId: string;
  ttlSeconds: number;
}

export class OAuthKeyRing implements JwtVerifier {
  private readonly keys: DerivedKey[];
  private readonly byKid: Map<string, DerivedKey>;

  constructor(
    base64Keys: readonly string[],
    private readonly issuer: string,
    private readonly audience: string,
    private readonly now: () => number = Date.now,
  ) {
    if (base64Keys.length === 0) {
      throw new Error("Simple OAuth requires at least one signing key.");
    }
    this.keys = base64Keys.map((encoded) => {
      const master = Buffer.from(encoded, "base64");
      if (master.length !== 32) {
        throw new Error("Each simple OAuth signing key must decode to exactly 32 bytes.");
      }
      const kid = createHash("sha256").update(master).digest("hex").slice(0, 16);
      return {
        kid,
        jwt: derive(master, "jwt-signing"),
        envelope: derive(master, "envelope-signing"),
        storage: derive(master, "grant-storage"),
      };
    });
    this.byKid = new Map(this.keys.map((key) => [key.kid, key]));
  }

  get activeKid(): string {
    return this.keys[0].kid;
  }

  signEnvelope(payload: Record<string, unknown>): string {
    const key = this.keys[0];
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const signature = createHmac("sha256", key.envelope).update(encoded, "ascii").digest("base64url");
    return `${key.kid}.${encoded}.${signature}`;
  }

  verifyEnvelope<T extends TimedEnvelope>(value: string): T {
    const [kid, encoded, signature, ...rest] = value.split(".");
    if (!kid || !encoded || !signature || rest.length > 0) {
      throw new Error("Malformed OAuth envelope.");
    }
    const key = this.byKid.get(kid);
    if (!key) {
      throw new Error("Unknown OAuth envelope key.");
    }
    const expected = createHmac("sha256", key.envelope).update(encoded, "ascii").digest();
    const presented = Buffer.from(signature, "base64url");
    if (!safeEqual(expected, presented)) {
      throw new Error("Invalid OAuth envelope signature.");
    }
    const payload = parseJsonObject(Buffer.from(encoded, "base64url").toString("utf8")) as T;
    if (typeof payload.exp !== "number" || payload.exp <= this.now()) {
      throw new Error("OAuth envelope expired.");
    }
    return payload;
  }

  seal(payload: Record<string, unknown>): string {
    const key = this.keys[0];
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key.storage, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(payload), "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return `${key.kid}.${Buffer.concat([iv, tag, ciphertext]).toString("base64url")}`;
  }

  open<T extends Record<string, unknown>>(value: string): T {
    const [kid, encoded, ...rest] = value.split(".");
    if (!kid || !encoded || rest.length > 0) {
      throw new Error("Malformed OAuth grant payload.");
    }
    const key = this.byKid.get(kid);
    if (!key) {
      throw new Error("Unknown OAuth grant key.");
    }
    const raw = Buffer.from(encoded, "base64url");
    if (raw.length < 29) {
      throw new Error("Malformed OAuth grant ciphertext.");
    }
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const ciphertext = raw.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", key.storage, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
      "utf8",
    );
    return parseJsonObject(plaintext) as T;
  }

  async issueAccessToken(input: LocalAccessTokenInput): Promise<string> {
    const key = this.keys[0];
    const nowSeconds = Math.floor(this.now() / 1000);
    return new SignJWT({
      tid: input.tenantId,
      oid: input.subject,
      scp: input.scopes.join(" "),
      azp: input.clientId,
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT", kid: key.kid })
      .setIssuer(this.issuer)
      .setAudience(this.audience)
      .setSubject(input.subject)
      .setIssuedAt(nowSeconds)
      .setNotBefore(nowSeconds - 5)
      .setExpirationTime(nowSeconds + input.ttlSeconds)
      .setJti(randomBytes(16).toString("base64url"))
      .sign(key.jwt);
  }

  async verify(token: string): Promise<JwtClaims> {
    const header = decodeProtectedHeader(token);
    if (header.alg !== "HS256" || typeof header.kid !== "string") {
      throw new Error("Token is not a local simple OAuth token.");
    }
    const key = this.byKid.get(header.kid);
    if (!key) {
      throw new Error("Unknown local token signing key.");
    }
    const { payload } = await jwtVerify(token, key.jwt, {
      algorithms: ["HS256"],
      issuer: this.issuer,
      audience: this.audience,
      clockTolerance: 60,
    });
    return payload as JwtClaims;
  }
}

/** Route local HS256 tokens to the local verifier and all others to Entra. */
export function createOAuthAwareVerifier(
  entraVerifier: JwtVerifier,
  localVerifier: JwtVerifier,
): JwtVerifier {
  return {
    async verify(
      token: string,
      context?: JwtVerificationContext,
    ): Promise<JwtClaims> {
      let algorithm: string | undefined;
      try {
        algorithm = decodeProtectedHeader(token).alg;
      } catch {
        return entraVerifier.verify(token, context);
      }
      return algorithm === "HS256"
        ? localVerifier.verify(token)
        : entraVerifier.verify(token, context);
    },
  };
}
