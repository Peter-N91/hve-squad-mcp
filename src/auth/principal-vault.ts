import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** Versioned AEAD envelope. Key IDs permit read-old/write-current rotation. */
export class PrincipalVault {
  constructor(readonly activeKeyId: string, private readonly keys: Readonly<Record<string, Buffer>>) {
    if (!/^[a-zA-Z0-9_-]{1,32}$/.test(activeKeyId) || !keys[activeKeyId] ||
        Object.values(keys).some(key => key.length !== 32)) throw new Error("Invalid credential encryption key ring.");
  }

  seal(binding: string, value: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.keys[this.activeKeyId], iv);
    cipher.setAAD(Buffer.from(`github-v1|${this.activeKeyId}|${binding}`));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return ["v1", this.activeKeyId, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
  }

  open<T>(binding: string, envelope: string): T {
    try {
      if (envelope.length > 48_000) throw new Error();
      const [version, keyId, iv, tag, content, extra] = envelope.split(".");
      if (version !== "v1" || extra !== undefined || !this.keys[keyId] || Buffer.from(iv, "base64url").length !== 12 ||
          Buffer.from(tag, "base64url").length !== 16) throw new Error();
      const cipher = createDecipheriv("aes-256-gcm", this.keys[keyId], Buffer.from(iv, "base64url"));
      cipher.setAAD(Buffer.from(`github-v1|${keyId}|${binding}`));
      cipher.setAuthTag(Buffer.from(tag, "base64url"));
      return JSON.parse(Buffer.concat([cipher.update(Buffer.from(content, "base64url")), cipher.final()]).toString("utf8")) as T;
    } catch {
      throw new Error("Credential envelope authentication failed.");
    }
  }
}
