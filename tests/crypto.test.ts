import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";

const KEY = randomBytes(32).toString("base64");

async function freshImport() {
  // Re-import so module-level reads of process.env are picked up.
  return await import("../src/lib/crypto?t=" + Date.now());
}

describe("crypto AES-256-GCM", () => {
  const originalKey = process.env.ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = KEY;
  });

  afterEach(() => {
    process.env.ENCRYPTION_KEY = originalKey;
  });

  it("roundtrips plaintext", async () => {
    const { encrypt, decrypt } = await freshImport();
    const pt = "hello world — 8vance secret 🔐";
    const ct = encrypt(pt);
    expect(ct).not.toBe(pt);
    expect(decrypt(ct)).toBe(pt);
  });

  it("produces fresh IV each call (different ciphertexts for same plaintext)", async () => {
    const { encrypt } = await freshImport();
    const a = encrypt("same");
    const b = encrypt("same");
    expect(a).not.toBe(b);
  });

  it("decrypts old ciphertext via ENCRYPTION_KEY_PREVIOUS after rotation", async () => {
    // Encrypt under the OLD key.
    process.env.ENCRYPTION_KEY = KEY;
    delete process.env.ENCRYPTION_KEY_PREVIOUS;
    const oldMod = await freshImport();
    const ct = oldMod.encrypt("rotate me");

    // Rotate: new current key, old key moved to PREVIOUS.
    const newKey = randomBytes(32).toString("base64");
    process.env.ENCRYPTION_KEY = newKey;
    process.env.ENCRYPTION_KEY_PREVIOUS = KEY;
    const newMod = await freshImport();
    // Old ciphertext still decrypts (via previous key)...
    expect(newMod.decrypt(ct)).toBe("rotate me");
    // ...and new writes use the new key (old key alone can't read them).
    const ct2 = newMod.encrypt("new secret");
    process.env.ENCRYPTION_KEY = KEY;
    delete process.env.ENCRYPTION_KEY_PREVIOUS;
    const oldOnly = await freshImport();
    expect(() => oldOnly.decrypt(ct2)).toThrow();

    delete process.env.ENCRYPTION_KEY_PREVIOUS;
  });

  it("detects tampering (modified ciphertext byte)", async () => {
    const { encrypt, decrypt } = await freshImport();
    const ct = encrypt("integrity-please");
    const buf = Buffer.from(ct, "base64");
    // Flip a bit somewhere in the middle (ciphertext region).
    buf[20] = buf[20] ^ 0x01;
    const tampered = buf.toString("base64");
    expect(() => decrypt(tampered)).toThrow();
  });

  it("fails with wrong key", async () => {
    const { encrypt } = await freshImport();
    const ct = encrypt("secret");
    process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
    const mod2 = await freshImport();
    expect(() => mod2.decrypt(ct)).toThrow();
  });

  it("throws on missing key", async () => {
    delete process.env.ENCRYPTION_KEY;
    const { encrypt, assertCryptoReady } = await freshImport();
    expect(() => assertCryptoReady()).toThrow(/ENCRYPTION_KEY/);
    expect(() => encrypt("x")).toThrow(/ENCRYPTION_KEY/);
  });

  it("throws on wrong-size key", async () => {
    process.env.ENCRYPTION_KEY = Buffer.from("tooshort").toString("base64");
    const { assertCryptoReady } = await freshImport();
    expect(() => assertCryptoReady()).toThrow(/32 bytes/);
  });
});
