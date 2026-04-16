/**
 * Encrypted Document Vault — Cryptographic Primitives
 *
 * - Key derivation: Argon2id → master key → per-purpose keys via HKDF
 * - Encryption: AES-256-GCM (authenticated encryption)
 * - Hashing: SHA-256 for chain integrity
 *
 * All keys are Buffer instances so they can be explicitly zeroed on lock.
 */

import crypto from 'crypto';
import argon2 from 'argon2';

// ── Constants ───────────────────────────────────────────────────────────────

const AES_KEY_BYTES = 32; // 256 bits
const IV_BYTES = 12; // GCM standard
const AUTH_TAG_BYTES = 16; // GCM standard
const SALT_BYTES = 32;

const DEFAULT_ARGON2_PARAMS = {
  memoryCost: 65536, // 64 MB
  timeCost: 3,
  parallelism: 1,
};

// ── Salt generation ─────────────────────────────────────────────────────────

export function generateSalt(): Buffer {
  return crypto.randomBytes(SALT_BYTES);
}

// ── Key derivation ──────────────────────────────────────────────────────────

/**
 * Derive a 256-bit master key from a passphrase using Argon2id.
 * Returns a Buffer that MUST be zeroed when no longer needed.
 */
export async function deriveMasterKey(
  passphrase: string,
  salt: Buffer,
  params = DEFAULT_ARGON2_PARAMS,
): Promise<Buffer> {
  const hash = await argon2.hash(passphrase, {
    type: argon2.argon2id,
    salt,
    memoryCost: params.memoryCost,
    timeCost: params.timeCost,
    parallelism: params.parallelism,
    hashLength: AES_KEY_BYTES,
    raw: true, // return raw bytes, not encoded string
  });
  // argon2.hash with raw:true returns a Buffer
  return Buffer.from(hash);
}

/**
 * Derive a purpose-specific key from the master key using HKDF-SHA256.
 * `info` is the purpose string (e.g., "vault-index", "doc-{docId}").
 */
export function deriveKey(
  masterKey: Buffer,
  info: string,
  salt: Buffer,
): Buffer {
  return crypto.hkdfSync(
    'sha256',
    masterKey,
    salt,
    info,
    AES_KEY_BYTES,
  ) as unknown as Buffer;
}

/** Derive the key used to encrypt/decrypt the vault index. */
export function deriveIndexKey(masterKey: Buffer, salt: Buffer): Buffer {
  return deriveKey(masterKey, 'vault-index', salt);
}

/** Derive a per-document encryption key. */
export function deriveDocumentKey(
  masterKey: Buffer,
  docId: string,
  salt: Buffer,
): Buffer {
  return deriveKey(masterKey, `doc-${docId}`, salt);
}

/** Derive the HMAC key used for chain entry signing (future use). */
export function deriveChainHmacKey(masterKey: Buffer, salt: Buffer): Buffer {
  return deriveKey(masterKey, 'chain-hmac', salt);
}

// ── AES-256-GCM encryption ─────────────────────────────────────────────────

/**
 * Encrypt a buffer with AES-256-GCM.
 * Returns: IV (12 bytes) || ciphertext || auth tag (16 bytes)
 */
export function encrypt(plaintext: Buffer, key: Buffer): Buffer {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([iv, ciphertext, authTag]);
}

/**
 * Decrypt a buffer encrypted with AES-256-GCM.
 * Input format: IV (12 bytes) || ciphertext || auth tag (16 bytes)
 * Throws on tampered data or wrong key.
 */
export function decrypt(encrypted: Buffer, key: Buffer): Buffer {
  if (encrypted.length < IV_BYTES + AUTH_TAG_BYTES) {
    throw new Error('Vault: encrypted data too short');
  }

  const iv = encrypted.subarray(0, IV_BYTES);
  const authTag = encrypted.subarray(encrypted.length - AUTH_TAG_BYTES);
  const ciphertext = encrypted.subarray(
    IV_BYTES,
    encrypted.length - AUTH_TAG_BYTES,
  );

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// ── Hashing ─────────────────────────────────────────────────────────────────

/** SHA-256 hash of a buffer, returned as hex string. */
export function sha256(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** SHA-256 hash of a UTF-8 string, returned as hex string. */
export function sha256String(data: string): string {
  return sha256(Buffer.from(data, 'utf-8'));
}

// ── Key zeroing ─────────────────────────────────────────────────────────────

/** Zero a Buffer to remove key material from memory. */
export function zeroBuffer(buf: Buffer): void {
  buf.fill(0);
}

export { DEFAULT_ARGON2_PARAMS };
