#!/usr/bin/env npx tsx
/**
 * save-transaction.ts
 *
 * Saves a parsed receipt or manual transaction to the Supabase transactions
 * table so it appears in the Japan Money Tracker web app.
 *
 * Usage (from inside an agent container):
 *   echo '<JSON>' | npx tsx /app/scripts/save-transaction.ts
 *
 * Input (stdin): a single JSON object with transaction fields in camelCase.
 * Required fields: date, amount (number in smallest unit — ¥ not subdivided)
 *
 * Env vars (forwarded automatically to agent containers):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_USER_ID
 *
 * Exits 0 and prints JSON result on success.
 * Exits 1 and prints error on failure — never silently fails.
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_USER_ID = process.env.SUPABASE_USER_ID;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_USER_ID) {
  console.error(
    'ERROR: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and SUPABASE_USER_ID must all be set.',
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Read JSON from stdin
let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;

let tx: Record<string, unknown>;
try {
  tx = JSON.parse(input.trim());
} catch (e) {
  console.error('ERROR: Failed to parse stdin as JSON:', (e as Error).message);
  process.exit(1);
}

if (!tx.date || tx.amount === undefined) {
  console.error('ERROR: Transaction must have at least "date" and "amount" fields.');
  process.exit(1);
}

// camelCase → snake_case field map (matches TX_FIELD_MAP in japan-money-tracker)
const FIELD_MAP: Record<string, string> = {
  descriptionEn: 'description_en',
  originalAmount: 'original_amount',
  exchangeRate: 'exchange_rate',
  categoryLabel: 'category_label',
  categoryReason: 'category_reason',
  taxRate: 'tax_rate',
  vendorEn: 'vendor_en',
  paymentMethod: 'payment_method',
  taxDeductible: 'tax_deductible',
  deductionReason: 'deduction_reason',
  filingStatus: 'filing_status',
  filingEntity: 'filing_entity',
  sourceFile: 'source_file',
  invoiceNumber: 'invoice_number',
  invoiceType: 'invoice_type',
  sellerRegistration: 'seller_registration',
  remittanceType: 'remittance_type',
  foreignTaxPaid: 'foreign_tax_paid',
  foreignTaxCountry: 'foreign_tax_country',
  receiptItems: 'receipt_items',
};

// Build the Supabase row
const row: Record<string, unknown> = {
  user_id: SUPABASE_USER_ID,
  origin: 'telegram',
  source: 'Receipt Scan',
  filing_status: 'Pending',
  tax_deductible: true,
  currency: 'JPY',
  type: 'Expense',
  tax_rate: '10%',
};

for (const [k, v] of Object.entries(tx)) {
  if (k === 'id' || k === 'user_id' || k === 'origin') continue; // let Supabase assign
  if (v === null || v === undefined || v === '') continue;
  const snakeKey = FIELD_MAP[k] ?? k;
  row[snakeKey] = v;
}

// Ensure amount is a number
const amount = Number(row.amount);
if (!Number.isFinite(amount)) {
  console.error(`ERROR: amount "${row.amount}" is not a valid number.`);
  process.exit(1);
}
row.amount = amount;
if (row.original_amount === undefined) row.original_amount = amount;

const { data, error } = await supabase
  .from('transactions')
  .insert(row)
  .select('id')
  .single();

if (error) {
  console.error('ERROR: Supabase insert failed:', error.message);
  process.exit(1);
}

console.log(JSON.stringify({ success: true, id: data.id }));
