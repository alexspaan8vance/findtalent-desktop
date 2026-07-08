import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  type CipherGCM,
  type DecipherGCM,
} from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

function parseKey(raw: string): Buffer {
  let key: Buffer;
  try {
    key = Buffer.from(raw, "base64");
  } catch {
    throw new Error("ENCRYPTION_KEY must be base64-encoded");
  }
  if (key.length !== KEY_LEN) {
    throw new Error(
      `ENCRYPTION_KEY must decode to exactly ${KEY_LEN} bytes (got ${key.length}). Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
    );
  }
  return key;
}

/** The current key — used for all NEW encryption. */
function loadKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw || raw.length === 0) {
    throw new Error(
      "ENCRYPTION_KEY env var is missing. Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\""
    );
  }
  return parseKey(raw);
}

/**
 * All keys to TRY when decrypting, in order: the current key first, then any
 * comma-separated keys in ENCRYPTION_KEY_PREVIOUS. This enables zero-downtime
 * rotation: set ENCRYPTION_KEY=<new> and ENCRYPTION_KEY_PREVIOUS=<old>; new
 * data is written with the new key while existing ciphertext still decrypts
 * via the old one (re-encrypt lazily, then drop PREVIOUS). The on-disk format
 * is unchanged — we just try each key until the GCM tag verifies.
 */
function loadDecryptKeys(): Buffer[] {
  const keys: Buffer[] = [loadKey()];
  const prev = process.env.ENCRYPTION_KEY_PREVIOUS;
  if (prev) {
    for (const part of prev.split(",")) {
      const trimmed = part.trim();
      if (trimmed.length === 0) continue;
      try {
        keys.push(parseKey(trimmed));
      } catch {
        // ignore a malformed previous key rather than break decryption
      }
    }
  }
  return keys;
}

/**
 * Validate at startup. Throws if ENCRYPTION_KEY is missing or malformed.
 */
export function assertCryptoReady(): void {
  loadKey();
}

/**
 * Encrypt plaintext with AES-256-GCM.
 * Returns base64( iv(12) || ciphertext || authTag(16) ).
 */
export function encrypt(plaintext: string): string {
  if (typeof plaintext !== "string") {
    throw new TypeError("encrypt() expects a string");
  }
  const key = loadKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv) as CipherGCM;
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]).toString("base64");
}

/**
 * Decrypt a payload produced by encrypt(). Throws on tamper / wrong key / malformed input.
 */
export function decrypt(payload: string): string {
  if (typeof payload !== "string" || payload.length === 0) {
    throw new Error("decrypt() expects a non-empty string");
  }
  const buf = Buffer.from(payload, "base64");
  if (buf.length < IV_LEN + TAG_LEN + 1) {
    throw new Error("ciphertext too short / malformed");
  }
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const ct = buf.subarray(IV_LEN, buf.length - TAG_LEN);
  // Try the current key, then any previous (rotation) keys until the GCM tag
  // verifies. Throws only if NONE of them authenticate the ciphertext.
  let lastErr: unknown;
  for (const key of loadDecryptKeys()) {
    try {
      const decipher = createDecipheriv(ALGO, key, iv) as DecipherGCM;
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("decrypt failed");
}
