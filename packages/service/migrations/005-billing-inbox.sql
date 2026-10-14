CREATE TABLE billing_accounts (
  account_id uuid PRIMARY KEY REFERENCES accounts(id),
  customer_id text NOT NULL UNIQUE,
  subscription_id text UNIQUE,
  subscription_status text NOT NULL DEFAULT 'none',
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  period_end timestamptz,
  blocked boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL
);
CREATE TABLE billing_inbox (
  event_id text PRIMARY KEY,
  event_type text NOT NULL,
  object_id text NOT NULL,
  customer_id text,
  digest text NOT NULL,
  live boolean NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','done')),
  attempts integer NOT NULL DEFAULT 0,
  retry_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  processed_at timestamptz,
  last_error text
);
CREATE INDEX billing_inbox_retry ON billing_inbox(state,retry_at);
CREATE TABLE billing_leases (
  customer_id text PRIMARY KEY,
  owner uuid NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE TABLE paid_periods (
  invoice_id text PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  subscription_id text NOT NULL,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  plan text NOT NULL CHECK (plan IN ('plus','pro','studio')),
  grant_source text NOT NULL UNIQUE,
  UNIQUE(account_id,subscription_id,period_start)
);
CREATE TRIGGER immutable_paid_periods BEFORE UPDATE OR DELETE ON paid_periods
  FOR EACH ROW EXECUTE FUNCTION reject_financial_mutation();
CREATE TABLE billing_reviews (
  event_id text PRIMARY KEY REFERENCES billing_inbox(event_id),
  account_id uuid NOT NULL REFERENCES accounts(id),
  reason text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','resolved')),
  created_at timestamptz NOT NULL
);
