/**
 * Encrypted Document Vault — Storage Layer
 *
 * Manages the vault directory structure, encrypted index, and document blobs.
 * All crypto operations use keys from the session manager — this module never
 * derives or stores keys itself.
 */

import fs from 'fs';
import path from 'path';
import {
  encrypt,
  decrypt,
  sha256,
  sha256String,
  generateSalt,
  deriveIndexKey,
  deriveDocumentKey,
  DEFAULT_ARGON2_PARAMS,
} from './crypto.js';
import { appendChainEntry, getChainHead, verifyChain, GENESIS_HASH } from './chain.js';
import type {
  VaultMeta,
  VaultIndex,
  VaultDocument,
  VaultDocumentType,
} from './types.js';

const VAULT_DIR_NAME = 'vault';
const VAULT_META_FILE = 'vault.json';
const INDEX_FILE = 'index.enc';
const BLOBS_DIR = 'blobs';

// ── Vault path helpers ──────────────────────────────────────────────────────

export function getVaultDir(groupDir: string): string {
  return path.join(groupDir, VAULT_DIR_NAME);
}

function metaPath(vaultDir: string): string {
  return path.join(vaultDir, VAULT_META_FILE);
}

function indexPath(vaultDir: string): string {
  return path.join(vaultDir, INDEX_FILE);
}

function blobsDir(vaultDir: string): string {
  return path.join(vaultDir, BLOBS_DIR);
}

function blobPath(vaultDir: string, docId: string): string {
  return path.join(blobsDir(vaultDir), `${docId}.enc`);
}

// ── Vault lifecycle ─────────────────────────────────────────────────────────

/** Check if a vault exists for the given group directory. */
export function vaultExists(groupDir: string): boolean {
  return fs.existsSync(metaPath(getVaultDir(groupDir)));
}

/**
 * Create a new vault. Called once when the user first sets up their vault.
 * Returns the salt (needed for key derivation on future unlocks).
 */
export function createVault(groupDir: string): VaultMeta {
  const vaultDir = getVaultDir(groupDir);
  fs.mkdirSync(blobsDir(vaultDir), { recursive: true });

  const salt = generateSalt();
  const meta: VaultMeta = {
    version: 1,
    salt: salt.toString('base64'),
    argon2: { ...DEFAULT_ARGON2_PARAMS },
    createdAt: new Date().toISOString(),
    chainHead: GENESIS_HASH,
    documentCount: 0,
  };

  // Write vault metadata (plaintext — contains no secrets)
  fs.writeFileSync(metaPath(vaultDir), JSON.stringify(meta, null, 2));

  return meta;
}

/** Read vault metadata. Throws if vault doesn't exist. */
export function readVaultMeta(groupDir: string): VaultMeta {
  const vaultDir = getVaultDir(groupDir);
  const file = metaPath(vaultDir);
  if (!fs.existsSync(file)) {
    throw new Error('Vault: no vault found. Create one first.');
  }
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as VaultMeta;
}

/** Update vault metadata (e.g., after storing a document). */
function writeVaultMeta(groupDir: string, meta: VaultMeta): void {
  const vaultDir = getVaultDir(groupDir);
  const file = metaPath(vaultDir);
  const tmpFile = `${file}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(meta, null, 2));
  fs.renameSync(tmpFile, file);
}

// ── Encrypted index ─────────────────────────────────────────────────────────

/** Read and decrypt the document index. Returns empty index if none exists. */
export function readIndex(
  groupDir: string,
  masterKey: Buffer,
): VaultIndex {
  const vaultDir = getVaultDir(groupDir);
  const file = indexPath(vaultDir);
  const meta = readVaultMeta(groupDir);
  const salt = Buffer.from(meta.salt, 'base64');

  if (!fs.existsSync(file)) {
    return { documents: [] };
  }

  const encryptedData = fs.readFileSync(file);
  const key = deriveIndexKey(masterKey, salt);
  const plaintext = decrypt(encryptedData, key);
  return JSON.parse(plaintext.toString('utf-8')) as VaultIndex;
}

/** Encrypt and write the document index. */
function writeIndex(
  groupDir: string,
  masterKey: Buffer,
  index: VaultIndex,
): void {
  const vaultDir = getVaultDir(groupDir);
  const file = indexPath(vaultDir);
  const meta = readVaultMeta(groupDir);
  const salt = Buffer.from(meta.salt, 'base64');

  const plaintext = Buffer.from(JSON.stringify(index), 'utf-8');
  const key = deriveIndexKey(masterKey, salt);
  const encrypted = encrypt(plaintext, key);

  const tmpFile = `${file}.tmp`;
  fs.writeFileSync(tmpFile, encrypted);
  fs.renameSync(tmpFile, file);
}

// ── Document operations ─────────────────────────────────────────────────────

function generateDocId(): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).slice(2, 8);
  return `doc-${timestamp}-${random}`;
}

/**
 * Store a document in the vault.
 * The plaintext buffer is encrypted with a per-document key and written to disk.
 * The index is updated and a chain entry is appended.
 * Returns the new document record.
 */
export function storeDocument(
  groupDir: string,
  masterKey: Buffer,
  plaintext: Buffer,
  opts: {
    name: string;
    type: VaultDocumentType;
    tags?: string[];
    notes?: string;
    originalFilename: string;
    mimeType: string;
  },
): VaultDocument {
  const vaultDir = getVaultDir(groupDir);
  const meta = readVaultMeta(groupDir);
  const salt = Buffer.from(meta.salt, 'base64');
  const docId = generateDocId();

  // Encrypt the document with a per-document key
  const docKey = deriveDocumentKey(masterKey, docId, salt);
  const encryptedBlob = encrypt(plaintext, docKey);

  // Write encrypted blob
  fs.mkdirSync(blobsDir(vaultDir), { recursive: true });
  const blob = blobPath(vaultDir, docId);
  const tmpBlob = `${blob}.tmp`;
  fs.writeFileSync(tmpBlob, encryptedBlob);
  fs.renameSync(tmpBlob, blob);

  // Build document record
  const doc: VaultDocument = {
    id: docId,
    name: opts.name,
    type: opts.type,
    tags: opts.tags || [],
    originalFilename: opts.originalFilename,
    mimeType: opts.mimeType,
    sizeBytes: plaintext.length,
    addedAt: new Date().toISOString(),
    sha256: sha256(plaintext),
    notes: opts.notes || '',
  };

  // Update encrypted index
  const index = readIndex(groupDir, masterKey);
  index.documents.push(doc);
  writeIndex(groupDir, masterKey, index);

  // Append chain entry
  const metaHash = sha256String(JSON.stringify(doc));
  const chainEntry = appendChainEntry(
    vaultDir,
    'add',
    docId,
    doc.sha256,
    metaHash,
  );

  // Update vault metadata
  meta.chainHead = chainEntry.entryHash;
  meta.documentCount = index.documents.length;
  writeVaultMeta(groupDir, meta);

  return doc;
}

/**
 * Retrieve and decrypt a document from the vault.
 * Returns the plaintext buffer and document metadata.
 */
export function retrieveDocument(
  groupDir: string,
  masterKey: Buffer,
  docId: string,
): { document: VaultDocument; plaintext: Buffer } {
  const vaultDir = getVaultDir(groupDir);
  const meta = readVaultMeta(groupDir);
  const salt = Buffer.from(meta.salt, 'base64');

  // Find document in index
  const index = readIndex(groupDir, masterKey);
  const doc = index.documents.find((d) => d.id === docId);
  if (!doc) {
    throw new Error(`Vault: document ${docId} not found`);
  }

  // Read and decrypt blob
  const blob = blobPath(vaultDir, docId);
  if (!fs.existsSync(blob)) {
    throw new Error(`Vault: blob file missing for ${docId}`);
  }

  const encryptedData = fs.readFileSync(blob);
  const docKey = deriveDocumentKey(masterKey, docId, salt);
  const plaintext = decrypt(encryptedData, docKey);

  // Verify plaintext hash matches stored hash
  const hash = sha256(plaintext);
  if (hash !== doc.sha256) {
    throw new Error(
      `Vault: integrity check failed for ${docId} — hash mismatch`,
    );
  }

  return { document: doc, plaintext };
}

/**
 * Delete a document from the vault.
 * Removes the encrypted blob, updates the index, appends a chain entry.
 */
export function deleteDocument(
  groupDir: string,
  masterKey: Buffer,
  docId: string,
): void {
  const vaultDir = getVaultDir(groupDir);
  const meta = readVaultMeta(groupDir);

  // Find and remove from index
  const index = readIndex(groupDir, masterKey);
  const docIndex = index.documents.findIndex((d) => d.id === docId);
  if (docIndex === -1) {
    throw new Error(`Vault: document ${docId} not found`);
  }

  const doc = index.documents[docIndex];
  index.documents.splice(docIndex, 1);
  writeIndex(groupDir, masterKey, index);

  // Delete blob file
  const blob = blobPath(vaultDir, docId);
  if (fs.existsSync(blob)) {
    fs.unlinkSync(blob);
  }

  // Append chain entry (delete operation)
  const metaHash = sha256String(JSON.stringify(doc));
  const chainEntry = appendChainEntry(
    vaultDir,
    'delete',
    docId,
    doc.sha256,
    metaHash,
  );

  // Update vault metadata
  meta.chainHead = chainEntry.entryHash;
  meta.documentCount = index.documents.length;
  writeVaultMeta(groupDir, meta);
}

/**
 * List documents in the vault, with optional filtering.
 */
export function listDocuments(
  groupDir: string,
  masterKey: Buffer,
  filters?: { type?: string; tag?: string },
): VaultDocument[] {
  const index = readIndex(groupDir, masterKey);
  let docs = index.documents;

  if (filters?.type) {
    docs = docs.filter((d) => d.type === filters.type);
  }
  if (filters?.tag) {
    const tag = filters.tag;
    docs = docs.filter((d) => d.tags.includes(tag));
  }

  return docs;
}

/**
 * Verify the vault's integrity: chain linkage + chain head match.
 */
export function verifyVault(
  groupDir: string,
): { valid: true } | { valid: false; error: string; entryIndex: number } {
  const vaultDir = getVaultDir(groupDir);
  const meta = readVaultMeta(groupDir);
  return verifyChain(vaultDir, meta.chainHead);
}
