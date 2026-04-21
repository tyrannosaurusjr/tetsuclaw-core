/**
 * Stripe webhook receiver.
 *
 * Listens for Stripe events over HTTP, verifies the signature, writes the
 * normalized transaction to SQLite (idempotent on stripe_event_id), and
 * mirrors a JSON export to the group's user/ directory so the Money agent
 * can read it without needing database access inside its container.
 *
 * Opt-in: the server only starts if STRIPE_WEBHOOK_SECRET is set.
 */

import fs from 'fs';
import http from 'http';
import path from 'path';

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import Stripe from 'stripe';

import {
  GROUPS_DIR,
  STRIPE_EXPORT_GROUP,
  STRIPE_WEBHOOK_PORT,
  STRIPE_WEBHOOK_SECRET,
} from './config.js';
import {
  getRecentStripeTransactions,
  insertStripeTransaction,
  StripeTransaction,
} from './db.js';
import { logger } from './logger.js';

// Supabase client for dual-writing Stripe transactions.
// Gracefully degrades if env vars are not set.
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_USER_ID = process.env.SUPABASE_USER_ID;

let supabase: SupabaseClient | null = null;
if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
}

/**
 * Upsert a Stripe transaction to Supabase.
 * Uses stripe_event_id as the conflict key for idempotency.
 * Failures are logged but never block the primary SQLite pipeline.
 */
async function upsertToSupabase(tx: StripeTransaction): Promise<void> {
  if (!supabase || !SUPABASE_USER_ID) return;

  const isIncome =
    !tx.event_type.includes('refund') && !tx.event_type.includes('failed');
  const { error } = await supabase.from('transactions').upsert(
    {
      user_id: SUPABASE_USER_ID,
      date: new Date(tx.occurred_at).toISOString().split('T')[0],
      description: tx.description || `Stripe ${tx.event_type}`,
      description_en: tx.description || `Stripe ${tx.event_type}`,
      amount: tx.amount,
      currency: tx.currency.toUpperCase(),
      type: isIncome ? 'Income' : 'Expense',
      category: tx.category || (isIncome ? 'income_business' : null),
      tax_rate: null,
      tax_deductible: !isIncome,
      payment_method: tx.payment_method,
      source: 'Stripe',
      institution: 'Stripe',
      filing_status: 'Pending',
      origin: 'stripe',
      stripe_event_id: tx.stripe_event_id,
      notes: tx.customer_email
        ? `Customer: ${tx.customer_name || ''} <${tx.customer_email}>`
        : null,
    },
    { onConflict: 'stripe_event_id' },
  );

  if (error) {
    logger.warn(
      { error: error.message, stripeEventId: tx.stripe_event_id },
      'Supabase upsert failed (non-blocking)',
    );
  } else {
    logger.info(
      { stripeEventId: tx.stripe_event_id },
      'Stripe transaction mirrored to Supabase',
    );
  }
}

// Stripe zero-decimal currencies — amounts are already whole units (no cents).
// Everything else (USD, EUR, GBP, …) uses the smallest unit (cents) and must
// be divided by 100 to get the major unit.
const ZERO_DECIMAL_CURRENCIES = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW',
  'MGA', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);

function toMajorUnit(amount: number, currency: string): number {
  return ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase())
    ? amount
    : amount / 100;
}

// Events we actually care about. Anything else returns 200 and is dropped.
// invoice.paid fires when a customer actually pays — this is the moment money
// arrives, not when an invoice is issued or a charge is attempted.
// charge.succeeded is kept only for direct (non-invoice) charges.
const HANDLED_EVENTS = new Set<string>([
  'invoice.paid',
  'charge.succeeded', // filtered in normalizeEvent: skipped when invoice != null
  'charge.refunded',
  'charge.failed',
  'payment_intent.payment_failed',
]);

// Raw body needs to be preserved byte-for-byte for signature verification —
// JSON.parse + re-stringify would break it.
function readRawBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Normalize a Stripe event into our transaction row shape. */
export function normalizeEvent(event: Stripe.Event): StripeTransaction | null {
  const obj = event.data.object as
    | Stripe.Charge
    | Stripe.Invoice
    | Stripe.PaymentIntent
    | Record<string, unknown>;
  const received_at = Date.now();
  const occurred_at = (event.created ?? Math.floor(received_at / 1000)) * 1000;

  // charge.succeeded is only recorded when NOT tied to an invoice.
  // Invoice payments are captured via invoice.paid instead — that fires
  // when money actually arrives, not when the charge is attempted.
  if (
    event.type === 'charge.succeeded' &&
    (obj as { invoice?: unknown }).invoice != null
  ) {
    return null;
  }

  // invoice.paid — extract from Invoice object shape.
  if (event.type === 'invoice.paid') {
    const inv = obj as Stripe.Invoice;
    const currency =
      typeof inv.currency === 'string' ? inv.currency : 'unknown';
    const amount = toMajorUnit(
      typeof inv.amount_paid === 'number' ? inv.amount_paid : 0,
      currency,
    );
    const customer_email =
      typeof inv.customer_email === 'string' ? inv.customer_email : null;
    const description =
      inv.description ||
      (inv.number ? `Invoice ${inv.number}` : 'Invoice payment');
    const metadata = inv.metadata;
    const metadata_json =
      metadata && Object.keys(metadata).length > 0
        ? JSON.stringify(metadata)
        : null;
    return {
      stripe_event_id: event.id,
      stripe_object_id: inv.id ?? event.id,
      event_type: event.type,
      amount,
      currency,
      status: 'paid',
      description,
      customer_email,
      customer_name: null,
      payment_method: null,
      metadata_json,
      category: 'income_business',
      occurred_at,
      received_at,
    };
  }

  // Charges and payment intents share most fields.
  const currency =
    typeof (obj as { currency?: unknown }).currency === 'string'
      ? ((obj as { currency: string }).currency as string)
      : 'unknown';
  const amount = toMajorUnit(
    typeof (obj as { amount?: unknown }).amount === 'number'
      ? ((obj as { amount: number }).amount as number)
      : 0,
    currency,
  );
  const status =
    typeof (obj as { status?: unknown }).status === 'string'
      ? ((obj as { status: string }).status as string)
      : event.type;
  const description =
    typeof (obj as { description?: unknown }).description === 'string'
      ? ((obj as { description: string }).description as string)
      : null;

  // Customer details — Stripe nests these differently across event types.
  let customer_email: string | null = null;
  let customer_name: string | null = null;
  const billing = (obj as { billing_details?: Stripe.Charge.BillingDetails })
    .billing_details;
  if (billing) {
    customer_email = billing.email ?? null;
    customer_name = billing.name ?? null;
  }
  const receiptEmail = (obj as { receipt_email?: string | null }).receipt_email;
  if (!customer_email && receiptEmail) customer_email = receiptEmail;

  // Payment method — card, konbini, customer_balance (furikomi), etc.
  let payment_method: string | null = null;
  const pmd = (obj as { payment_method_details?: { type?: string } })
    .payment_method_details;
  if (pmd?.type) payment_method = pmd.type;
  const pmTypes = (obj as { payment_method_types?: string[] })
    .payment_method_types;
  if (!payment_method && Array.isArray(pmTypes) && pmTypes.length > 0) {
    payment_method = pmTypes[0];
  }

  const metadata = (obj as { metadata?: Record<string, string> }).metadata;
  const metadata_json =
    metadata && Object.keys(metadata).length > 0
      ? JSON.stringify(metadata)
      : null;

  const stripe_object_id = (obj as { id?: string }).id ?? event.id;

  return {
    stripe_event_id: event.id,
    stripe_object_id,
    event_type: event.type,
    amount,
    currency,
    status,
    description,
    customer_email,
    customer_name,
    payment_method,
    metadata_json,
    category: null,
    occurred_at,
    received_at,
  };
}

/**
 * Mirror the most recent transactions to the Money agent's readable file.
 * Atomic write via rename so a concurrent reader never sees a partial file.
 */
export function exportTransactionsFile(): void {
  const exportPath = path.join(
    GROUPS_DIR,
    STRIPE_EXPORT_GROUP,
    'user',
    'transactions.json',
  );
  fs.mkdirSync(path.dirname(exportPath), { recursive: true });

  const rows = getRecentStripeTransactions(200);
  const payload = {
    version: 1,
    updated_at: new Date().toISOString(),
    source: 'stripe',
    transactions: rows.map((r) => ({
      event_id: r.stripe_event_id,
      object_id: r.stripe_object_id,
      type: r.event_type,
      amount: r.amount,
      currency: r.currency,
      status: r.status,
      description: r.description,
      customer_email: r.customer_email,
      customer_name: r.customer_name,
      payment_method: r.payment_method,
      category: r.category,
      metadata: r.metadata_json ? JSON.parse(r.metadata_json) : null,
      occurred_at: new Date(r.occurred_at).toISOString(),
    })),
  };

  const tmp = `${exportPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
  fs.renameSync(tmp, exportPath);
}

/**
 * Process a verified Stripe event: insert into DB, refresh export file.
 * Returns whether a new row was written (false = duplicate replay).
 */
export function processEvent(event: Stripe.Event): boolean {
  if (!HANDLED_EVENTS.has(event.type)) {
    logger.debug(
      { eventId: event.id, type: event.type },
      'Stripe event ignored (unhandled type)',
    );
    return false;
  }
  const tx = normalizeEvent(event);
  if (!tx) return false;
  const inserted = insertStripeTransaction(tx);
  if (inserted) {
    exportTransactionsFile();
    // Dual-write to Supabase (fire-and-forget, never blocks the webhook response)
    upsertToSupabase(tx).catch((err) =>
      logger.warn(
        { err: String(err) },
        'Supabase dual-write threw unexpectedly',
      ),
    );
    logger.info(
      {
        eventId: event.id,
        type: event.type,
        amount: tx.amount,
        currency: tx.currency,
      },
      'Stripe transaction recorded',
    );
  } else {
    logger.debug(
      { eventId: event.id },
      'Stripe event already recorded (duplicate webhook)',
    );
  }
  return inserted;
}

/**
 * Start the webhook HTTP server. Returns the server instance (for tests/
 * graceful shutdown) or null if not configured.
 */
export function startStripeWebhookServer(): http.Server | null {
  if (!STRIPE_WEBHOOK_SECRET) {
    logger.info(
      'Stripe webhook receiver skipped — STRIPE_WEBHOOK_SECRET not set',
    );
    return null;
  }

  // Verification uses Stripe's constructEvent helper which does timing-safe
  // HMAC-SHA256 comparison and enforces the 5-minute replay window.
  const stripe = new Stripe('sk_unused_webhook_only', {
    // API version is irrelevant for webhook verification but required by the type.
    apiVersion: '2025-08-27.basil',
  });

  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/webhook/stripe') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }
    const signature = req.headers['stripe-signature'];
    if (typeof signature !== 'string') {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Missing signature');
      return;
    }
    try {
      const rawBody = await readRawBody(req);
      const event = stripe.webhooks.constructEvent(
        rawBody,
        signature,
        STRIPE_WEBHOOK_SECRET,
      );
      processEvent(event);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"received":true}');
    } catch (err) {
      logger.warn(
        { err: String(err) },
        'Stripe webhook rejected (signature or processing error)',
      );
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end(`Webhook Error: ${String(err)}`);
    }
  });

  server.listen(STRIPE_WEBHOOK_PORT, () => {
    logger.info(
      { port: STRIPE_WEBHOOK_PORT, exportGroup: STRIPE_EXPORT_GROUP },
      'Stripe webhook receiver listening',
    );
  });

  return server;
}
