import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// Point the export mirror at a throwaway temp dir before the module under
// test imports config. Replacing GROUPS_DIR keeps transactions.json writes
// isolated from the real groups/ tree during tests. vi.mock is hoisted, so
// we compute the path in vi.hoisted (sync, no I/O) and create the directory
// in beforeAll.
const { TMP_GROUPS } = vi.hoisted(() => ({
  TMP_GROUPS: `${process.env.TMPDIR || '/tmp'}/tetsuclaw-stripe-test-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
}));
vi.mock('./config.js', async () => {
  const actual =
    await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    GROUPS_DIR: TMP_GROUPS,
    STRIPE_EXPORT_GROUP: 'main',
    STRIPE_WEBHOOK_SECRET: '', // server won't start during unit tests
  };
});

import type Stripe from 'stripe';

import { _initTestDatabase, getRecentStripeTransactions } from './db.js';
import {
  exportTransactionsFile,
  normalizeEvent,
  processEvent,
} from './stripe-webhook.js';

beforeAll(() => {
  fs.mkdirSync(TMP_GROUPS, { recursive: true });
});

beforeEach(() => {
  _initTestDatabase();
});

function chargeSucceededEvent(
  overrides: Partial<{
    id: string;
    chargeId: string;
    amount: number;
    currency: string;
    description: string;
    email: string;
    name: string;
    paymentMethod: string;
    metadata: Record<string, string>;
    created: number;
  }> = {},
): Stripe.Event {
  return {
    id: overrides.id ?? 'evt_test_001',
    object: 'event',
    api_version: '2025-09-30.clover',
    created: overrides.created ?? 1_700_000_000,
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    type: 'charge.succeeded',
    data: {
      object: {
        id: overrides.chargeId ?? 'ch_test_001',
        object: 'charge',
        amount: overrides.amount ?? 5000,
        currency: overrides.currency ?? 'jpy',
        status: 'succeeded',
        description: overrides.description ?? 'Consulting fee',
        billing_details: {
          email: overrides.email ?? 'client@example.com',
          name: overrides.name ?? 'Test Client',
          address: null,
          phone: null,
          tax_id: null,
        },
        payment_method_details: {
          type: overrides.paymentMethod ?? 'card',
        },
        metadata: overrides.metadata ?? { project: 'real-estate-consult' },
      } as unknown,
    } as Stripe.Event.Data,
  } as unknown as Stripe.Event;
}

describe('normalizeEvent', () => {
  it('extracts core fields from a charge.succeeded event', () => {
    const tx = normalizeEvent(chargeSucceededEvent());
    expect(tx).not.toBeNull();
    expect(tx!.stripe_event_id).toBe('evt_test_001');
    expect(tx!.stripe_object_id).toBe('ch_test_001');
    expect(tx!.event_type).toBe('charge.succeeded');
    expect(tx!.amount).toBe(5000);
    expect(tx!.currency).toBe('jpy');
    expect(tx!.status).toBe('succeeded');
    expect(tx!.description).toBe('Consulting fee');
    expect(tx!.customer_email).toBe('client@example.com');
    expect(tx!.customer_name).toBe('Test Client');
    expect(tx!.payment_method).toBe('card');
    expect(tx!.metadata_json).toBe(
      JSON.stringify({ project: 'real-estate-consult' }),
    );
    expect(tx!.category).toBeNull();
    expect(tx!.occurred_at).toBe(1_700_000_000_000);
  });

  it('handles konbini (customer_balance) payment method', () => {
    const tx = normalizeEvent(
      chargeSucceededEvent({ paymentMethod: 'customer_balance' }),
    );
    expect(tx!.payment_method).toBe('customer_balance');
  });

  it('handles missing optional fields gracefully', () => {
    const event = chargeSucceededEvent();
    const charge = event.data.object as unknown as Record<string, unknown>;
    delete charge.billing_details;
    delete charge.payment_method_details;
    delete charge.metadata;
    delete charge.description;
    const tx = normalizeEvent(event);
    expect(tx!.customer_email).toBeNull();
    expect(tx!.customer_name).toBeNull();
    expect(tx!.payment_method).toBeNull();
    expect(tx!.metadata_json).toBeNull();
    expect(tx!.description).toBeNull();
  });
});

describe('processEvent', () => {
  it('inserts a handled event', () => {
    const inserted = processEvent(chargeSucceededEvent());
    expect(inserted).toBe(true);
    const rows = getRecentStripeTransactions();
    expect(rows).toHaveLength(1);
    expect(rows[0].stripe_event_id).toBe('evt_test_001');
  });

  it('ignores unhandled event types without error', () => {
    const event = chargeSucceededEvent();
    (event as { type: string }).type = 'customer.created';
    const inserted = processEvent(event);
    expect(inserted).toBe(false);
    expect(getRecentStripeTransactions()).toHaveLength(0);
  });

  it('is idempotent on repeated event_id (Stripe retry safety)', () => {
    const event = chargeSucceededEvent();
    expect(processEvent(event)).toBe(true);
    expect(processEvent(event)).toBe(false);
    expect(processEvent(event)).toBe(false);
    expect(getRecentStripeTransactions()).toHaveLength(1);
  });

  it('stores distinct events separately and orders newest first', () => {
    processEvent(chargeSucceededEvent({ id: 'evt_1', created: 1000 }));
    processEvent(chargeSucceededEvent({ id: 'evt_2', created: 2000 }));
    processEvent(chargeSucceededEvent({ id: 'evt_3', created: 1500 }));
    const rows = getRecentStripeTransactions();
    expect(rows.map((r) => r.stripe_event_id)).toEqual([
      'evt_2',
      'evt_3',
      'evt_1',
    ]);
  });
});

describe('exportTransactionsFile', () => {
  it('writes a readable JSON mirror the Money agent can parse', () => {
    processEvent(
      chargeSucceededEvent({ id: 'evt_a', amount: 7500, created: 1000 }),
    );
    processEvent(
      chargeSucceededEvent({
        id: 'evt_b',
        chargeId: 'ch_b',
        amount: 12000,
        description: 'Retainer',
        created: 2000,
      }),
    );
    exportTransactionsFile();
    const exportPath = path.join(
      TMP_GROUPS,
      'main',
      'user',
      'transactions.json',
    );
    const contents = JSON.parse(fs.readFileSync(exportPath, 'utf-8'));
    expect(contents.version).toBe(1);
    expect(contents.source).toBe('stripe');
    expect(contents.transactions).toHaveLength(2);
    expect(contents.transactions[0].event_id).toBe('evt_b');
    expect(contents.transactions[0].amount).toBe(12000);
    expect(contents.transactions[0].description).toBe('Retainer');
    expect(contents.transactions[0].metadata).toEqual({
      project: 'real-estate-consult',
    });
    expect(contents.transactions[0].occurred_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('processEvent triggers export automatically on successful insert', () => {
    processEvent(chargeSucceededEvent({ id: 'evt_auto' }));
    const exportPath = path.join(
      TMP_GROUPS,
      'main',
      'user',
      'transactions.json',
    );
    expect(fs.existsSync(exportPath)).toBe(true);
    const contents = JSON.parse(fs.readFileSync(exportPath, 'utf-8'));
    expect(contents.transactions[0].event_id).toBe('evt_auto');
  });
});
