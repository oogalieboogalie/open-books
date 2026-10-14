import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Encrypts stored credentials (Google refresh tokens, IMAP passwords) with
 * AES-256-GCM. The key comes from APP_SECRET; without it, a random key is
 * created once in ./data/.app-secret so a local install works with no setup.
 * Changing or losing the key only means reconnecting integrations.
 */

let cachedKey: Buffer | undefined;

function secretFile(): string {
  return process.env.APP_SECRET_FILE || path.join(process.cwd(), "data", ".app-secret");
}

function key(): Buffer {
  if (cachedKey) return cachedKey;
  let secret = process.env.APP_SECRET;
  if (!secret) {
    const file = secretFile();
    try {
      secret = fs.readFileSync(/*turbopackIgnore: true*/ file, "utf8").trim();
    } catch {
      secret = randomBytes(32).toString("base64url");
      fs.mkdirSync(/*turbopackIgnore: true*/ path.dirname(file), { recursive: true });
      fs.writeFileSync(/*turbopackIgnore: true*/ file, secret + "\n", { mode: 0o600 });
    }
  }
  cachedKey = createHash("sha256").update(`open-books:${secret}`).digest();
  return cachedKey;
}

/** For tests: forget the cached key so a changed APP_SECRET takes effect. */
export function resetSecretKey() {
  cachedKey = undefined;
}

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${body.toString("base64url")}`;
}

/** Returns null when the value was encrypted with a different key or is damaged. */
export function decrypt(sealed: string): string | null {
  const [v, iv, tag, body] = sealed.split(".");
  if (v !== "v1" || !iv || !tag || body === undefined) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** Lowercase hex, safe in URLs and email addresses. */
export function randomToken(bytes = 12): string {
  return randomBytes(bytes).toString("hex");
}
