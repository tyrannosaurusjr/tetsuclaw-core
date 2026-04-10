import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  addProposal,
  getProposals,
  getThreadId,
  listTopics,
  loadTopics,
  migrateV1toV2,
  pruneExpiredProposals,
  saveTopics,
  upsertTopic,
} from './topics-registry.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'topics-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// v1 → v2 migration
// ---------------------------------------------------------------------------

describe('migrateV1toV2', () => {
  it('converts flat v1 entries to v2 topic entries', () => {
    const v1 = { restaurants: 94, islands: 75, money: null };
    const v2 = migrateV1toV2(v1);

    expect(v2.version).toBe(2);
    expect(Object.keys(v2.topics)).toHaveLength(3);
    expect(v2.topics.restaurants.thread_id).toBe(94);
    expect(v2.topics.restaurants.source).toBe('migrated');
    expect(v2.topics.money.thread_id).toBeNull();
  });
});

describe('loadTopics', () => {
  it('returns empty v2 when file does not exist', () => {
    const result = loadTopics(tmpDir);
    expect(result).toEqual({ version: 2, topics: {} });
  });

  it('loads v2 file as-is', () => {
    const v2 = { version: 2, topics: { foo: { thread_id: 1, subjects: [], agents: [], description: '', created_at: '2026-01-01T00:00:00Z', source: 'manual' as const } } };
    fs.writeFileSync(path.join(tmpDir, 'topics.json'), JSON.stringify(v2));
    const result = loadTopics(tmpDir);
    expect(result.topics.foo.thread_id).toBe(1);
  });

  it('auto-migrates v1 to v2 and persists', () => {
    const v1 = { restaurants: 94, money: null };
    fs.writeFileSync(path.join(tmpDir, 'topics.json'), JSON.stringify(v1));

    const result = loadTopics(tmpDir);
    expect(result.version).toBe(2);
    expect(result.topics.restaurants.thread_id).toBe(94);
    expect(result.topics.restaurants.source).toBe('migrated');

    // File on disk should now be v2
    const onDisk = JSON.parse(fs.readFileSync(path.join(tmpDir, 'topics.json'), 'utf-8'));
    expect(onDisk.version).toBe(2);
  });

  it('migration is idempotent', () => {
    const v1 = { restaurants: 94 };
    fs.writeFileSync(path.join(tmpDir, 'topics.json'), JSON.stringify(v1));

    const first = loadTopics(tmpDir);
    const second = loadTopics(tmpDir);
    expect(first).toEqual(second);
  });

  it('quarantines corrupt JSON', () => {
    fs.writeFileSync(path.join(tmpDir, 'topics.json'), '{not valid json!!');
    const result = loadTopics(tmpDir);
    expect(result).toEqual({ version: 2, topics: {} });

    // Original file should be gone, quarantine file should exist
    expect(fs.existsSync(path.join(tmpDir, 'topics.json'))).toBe(false);
    const files = fs.readdirSync(tmpDir);
    expect(files.some((f) => f.startsWith('topics.json.corrupt-'))).toBe(true);
  });

  it('quarantines unrecognized shape', () => {
    fs.writeFileSync(path.join(tmpDir, 'topics.json'), JSON.stringify([1, 2, 3]));
    const result = loadTopics(tmpDir);
    expect(result).toEqual({ version: 2, topics: {} });
    expect(fs.existsSync(path.join(tmpDir, 'topics.json'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Topic operations
// ---------------------------------------------------------------------------

describe('upsertTopic', () => {
  it('inserts a new topic', () => {
    let reg = loadTopics(tmpDir);
    reg = upsertTopic(reg, 'restaurants', {
      thread_id: 94,
      subjects: ['food', 'dining'],
      agents: ['intel', 'people'],
      description: 'Restaurant research',
      source: 'agent',
    });
    expect(reg.topics.restaurants.thread_id).toBe(94);
    expect(reg.topics.restaurants.subjects).toEqual(['food', 'dining']);
  });

  it('updates existing topic preserving unspecified fields', () => {
    let reg = loadTopics(tmpDir);
    reg = upsertTopic(reg, 'restaurants', {
      thread_id: 94,
      subjects: ['food'],
      agents: ['intel'],
      description: 'Food stuff',
      source: 'agent',
    });
    // Update only thread_id
    reg = upsertTopic(reg, 'restaurants', { thread_id: 100 });
    expect(reg.topics.restaurants.thread_id).toBe(100);
    expect(reg.topics.restaurants.subjects).toEqual(['food']);
    expect(reg.topics.restaurants.source).toBe('agent');
  });
});

describe('getThreadId', () => {
  it('returns thread_id or null', () => {
    const reg = migrateV1toV2({ restaurants: 94, money: null });
    expect(getThreadId(reg, 'restaurants')).toBe(94);
    expect(getThreadId(reg, 'money')).toBeNull();
    expect(getThreadId(reg, 'nonexistent')).toBeNull();
  });
});

describe('listTopics', () => {
  it('returns all topics', () => {
    const reg = migrateV1toV2({ a: 1, b: 2 });
    const topics = listTopics(reg);
    expect(Object.keys(topics)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

describe('proposals', () => {
  const baseProposal = {
    name: 'restaurants',
    subjects: ['food', 'dining'],
    agents: ['intel', 'people'],
    description: 'Restaurant research',
    rationale: 'User asked about food',
  };

  it('adds and retrieves a proposal', () => {
    const reg = loadTopics(tmpDir);
    const result = addProposal(tmpDir, reg, baseProposal);
    expect(result).toEqual({ ok: true });

    const proposals = getProposals(tmpDir);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].name).toBe('restaurants');
  });

  it('rejects proposal for existing topic', () => {
    let reg = loadTopics(tmpDir);
    reg = upsertTopic(reg, 'restaurants', { thread_id: 94, source: 'agent' });
    const result = addProposal(tmpDir, reg, baseProposal);
    expect(result).toEqual({ ok: false, error: 'already_exists' });
  });

  it('rate-limits same subject tuple within 24h', () => {
    const reg = loadTopics(tmpDir);
    const now = new Date('2026-04-10T12:00:00Z');

    addProposal(tmpDir, reg, baseProposal, now);

    // Same subjects, different name — should be rate-limited
    // (within 30min TTL so proposal still exists, within 24h rate window)
    const result = addProposal(
      tmpDir,
      reg,
      { ...baseProposal, name: 'eateries', subjects: ['dining', 'food'] },
      new Date('2026-04-10T12:15:00Z'),
    );
    expect(result).toEqual({ ok: false, error: 'rate_limited' });

    // After 24h — should succeed
    const laterResult = addProposal(
      tmpDir,
      reg,
      { ...baseProposal, name: 'eateries', subjects: ['dining', 'food'] },
      new Date('2026-04-11T12:15:00Z'),
    );
    expect(laterResult).toEqual({ ok: true });
  });

  it('prunes expired proposals (30min TTL)', () => {
    const file = {
      proposals: [
        { ...baseProposal, created_at: '2026-04-10T11:00:00Z' },
        { ...baseProposal, name: 'bars', created_at: '2026-04-10T11:45:00Z' },
      ],
    };
    // At 11:31, the first proposal (11:00) is expired, the second (11:45) is not
    const pruned = pruneExpiredProposals(file, new Date('2026-04-10T11:31:00Z'));
    expect(pruned.proposals).toHaveLength(1);
    expect(pruned.proposals[0].name).toBe('bars');
  });
});

// ---------------------------------------------------------------------------
// Atomic write safety
// ---------------------------------------------------------------------------

describe('saveTopics', () => {
  it('writes valid JSON atomically', () => {
    const reg = migrateV1toV2({ test: 42 });
    saveTopics(tmpDir, reg);

    const raw = fs.readFileSync(path.join(tmpDir, 'topics.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(2);
    expect(parsed.topics.test.thread_id).toBe(42);
  });

  it('does not leave tmp files on success', () => {
    const reg = migrateV1toV2({ test: 1 });
    saveTopics(tmpDir, reg);

    const files = fs.readdirSync(tmpDir);
    expect(files.filter((f) => f.includes('.tmp-'))).toHaveLength(0);
  });
});
