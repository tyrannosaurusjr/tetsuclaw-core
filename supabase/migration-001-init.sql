-- Japan Money Tracker + Tetsuclaw: Supabase schema
-- Run this in the Supabase SQL Editor after creating the project.

-- ============================================================
-- TABLES
-- ============================================================

-- Transactions (replaces localStorage tax_transactions)
CREATE TABLE transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),

  -- Core fields
  date DATE,
  description TEXT,
  description_en TEXT,
  amount NUMERIC NOT NULL DEFAULT 0,
  original_amount NUMERIC,
  currency TEXT NOT NULL DEFAULT 'JPY',
  exchange_rate NUMERIC,
  type TEXT NOT NULL DEFAULT 'Expense',
  category TEXT,
  category_label TEXT,
  category_reason TEXT,
  tax_rate TEXT DEFAULT '10%',
  vendor TEXT,
  vendor_en TEXT,
  payment_method TEXT,
  tax_deductible BOOLEAN DEFAULT TRUE,
  deduction_reason TEXT,
  filing_status TEXT DEFAULT 'Pending',
  filing_entity TEXT,
  source TEXT,
  source_file TEXT,
  institution TEXT,
  project TEXT,
  notes TEXT,
  invoice_number TEXT,
  invoice_type TEXT,
  seller_registration TEXT,
  remittance_type TEXT,
  foreign_tax_paid NUMERIC,
  foreign_tax_country TEXT,
  duplicate_of TEXT,
  estimated_rate BOOLEAN DEFAULT FALSE,

  -- Nested receipt line items
  receipt_items JSONB DEFAULT '[]'::jsonb,

  -- Provenance: where did this transaction originate?
  origin TEXT DEFAULT 'web' CHECK (origin IN ('web', 'telegram', 'stripe', 'import')),

  -- Stripe idempotency key (unique constraint prevents duplicate webhook events)
  stripe_event_id TEXT UNIQUE,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_tx_user_date ON transactions(user_id, date DESC);
CREATE INDEX idx_tx_stripe ON transactions(stripe_event_id) WHERE stripe_event_id IS NOT NULL;

-- Profiles (replaces localStorage tax_profile)
CREATE TABLE profiles (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id),
  years_in_japan INTEGER DEFAULT 0,
  residency_status TEXT DEFAULT 'non_permanent',
  has_us_filing_obligations BOOLEAN DEFAULT TRUE,
  nationality TEXT DEFAULT 'US',
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Vendor rules (replaces localStorage tax_vendor_rules)
CREATE TABLE vendor_rules (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id),
  name TEXT NOT NULL,
  keywords JSONB NOT NULL DEFAULT '[]',
  match_type TEXT NOT NULL DEFAULT 'any',
  actions JSONB NOT NULL DEFAULT '{}',
  enabled BOOLEAN DEFAULT TRUE,
  builtin BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Key-value store for misc app state (replaces localStorage
-- tax_redaction_terms, tax_institution_tags, tax_ai_insights, tax_drive_config)
CREATE TABLE app_state (
  user_id UUID NOT NULL REFERENCES auth.users(id),
  key TEXT NOT NULL,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

-- ============================================================
-- AUTO-UPDATE updated_at
-- ============================================================

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tr_transactions_updated_at
  BEFORE UPDATE ON transactions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER tr_profiles_updated_at
  BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER tr_app_state_updated_at
  BEFORE UPDATE ON app_state
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- ROW-LEVEL SECURITY
-- ============================================================

ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_state ENABLE ROW LEVEL SECURITY;

-- Authenticated users can only access their own data.
-- Service role key (used by Tetsuclaw/Stripe pipeline) bypasses RLS.

CREATE POLICY "Users manage own transactions"
  ON transactions FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users manage own profile"
  ON profiles FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users manage own vendor_rules"
  ON vendor_rules FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users manage own app_state"
  ON app_state FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ============================================================
-- STORAGE BUCKET (receipt images)
-- ============================================================

INSERT INTO storage.buckets (id, name, public)
VALUES ('receipt-images', 'receipt-images', false);

CREATE POLICY "Users manage own receipt images"
  ON storage.objects FOR ALL
  USING (bucket_id = 'receipt-images' AND (storage.foldername(name))[1] = auth.uid()::text)
  WITH CHECK (bucket_id = 'receipt-images' AND (storage.foldername(name))[1] = auth.uid()::text);

-- ============================================================
-- ENABLE REALTIME (for live Telegram -> web app updates)
-- ============================================================

ALTER PUBLICATION supabase_realtime ADD TABLE transactions;
