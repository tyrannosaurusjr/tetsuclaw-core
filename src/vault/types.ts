/**
 * Encrypted Document Vault — Type Definitions
 *
 * All interfaces for the vault's crypto, storage, chain, and session layers.
 */

// ── Document types ──────────────────────────────────────────────────────────

export type VaultDocumentType =
  | 'land_registration' // 登記簿
  | 'marriage_license' // 婚姻届受理証明書
  | 'business_doc' // 法人登記, 定款, etc.
  | 'tax_filing' // 確定申告, 納税証明書
  | 'contract' // 契約書
  | 'lease' // 賃貸借契約書
  | 'visa_document' // 在留カード, パスポート
  | 'insurance' // 保険証, 健康保険
  | 'certificate' // 住民票, 印鑑証明, etc.
  | 'other';

// ── Vault metadata (plaintext vault.json) ───────────────────────────────────

export interface VaultMeta {
  version: number;
  salt: string; // base64-encoded 32 bytes
  argon2: {
    memoryCost: number; // KiB (default 65536 = 64MB)
    timeCost: number; // iterations (default 3)
    parallelism: number; // threads (default 1)
  };
  createdAt: string; // ISO 8601
  chainHead: string; // hex SHA-256 of latest chain entry
  documentCount: number;
}

// ── Document record (stored inside encrypted index) ─────────────────────────

export interface VaultDocument {
  id: string; // "doc-{timestamp}-{random}"
  name: string; // user-facing name
  type: VaultDocumentType;
  tags: string[];
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  addedAt: string; // ISO 8601
  sha256: string; // hex hash of plaintext document
  notes: string;
}

// ── Encrypted index (decrypted form) ────────────────────────────────────────

export interface VaultIndex {
  documents: VaultDocument[];
}

// ── Hash chain entry (stored as JSONL, one per line) ────────────────────────

export type ChainOperation = 'add' | 'update' | 'delete';

export interface ChainEntry {
  seq: number;
  op: ChainOperation;
  docId: string;
  docHash: string; // SHA-256 of plaintext document bytes
  metaHash: string; // SHA-256 of JSON-serialized document metadata
  prevHash: string; // entryHash of previous entry (zeros for first)
  timestamp: string; // ISO 8601
  entryHash: string; // SHA-256(seq || op || docId || docHash || metaHash || prevHash || timestamp)
}

// ── Session state (in-memory only, never persisted) ─────────────────────────

export interface VaultSession {
  groupFolder: string;
  masterKey: Buffer; // derived from passphrase, zeroed on lock
  unlockedAt: number; // Date.now()
  lastActivity: number; // reset on every vault operation
  timeout: ReturnType<typeof setTimeout>;
}

// ── IPC message types for vault operations ──────────────────────────────────

export interface VaultIpcUnlock {
  type: 'vault_unlock';
  groupFolder: string;
  chatJid: string;
  timestamp: string;
}

export interface VaultIpcLock {
  type: 'vault_lock';
  groupFolder: string;
  chatJid: string;
  timestamp: string;
}

export interface VaultIpcStore {
  type: 'vault_store';
  groupFolder: string;
  chatJid: string;
  name: string;
  docType: VaultDocumentType;
  tags: string[];
  notes: string;
  tempFilePath: string; // path to downloaded file (in memory buffer or temp)
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  timestamp: string;
}

export interface VaultIpcRetrieve {
  type: 'vault_retrieve';
  groupFolder: string;
  chatJid: string;
  docId: string;
  timestamp: string;
}

export interface VaultIpcList {
  type: 'vault_list';
  groupFolder: string;
  chatJid: string;
  typeFilter?: string;
  tagFilter?: string;
  timestamp: string;
}

export interface VaultIpcVerify {
  type: 'vault_verify';
  groupFolder: string;
  chatJid: string;
  timestamp: string;
}

export type VaultIpcMessage =
  | VaultIpcUnlock
  | VaultIpcLock
  | VaultIpcStore
  | VaultIpcRetrieve
  | VaultIpcList
  | VaultIpcVerify;

// ── Encrypted blob format ───────────────────────────────────────────────────
// Binary layout: IV (12 bytes) || ciphertext || auth tag (16 bytes)
// This is handled by crypto.ts, not a separate type — documented here for reference.
