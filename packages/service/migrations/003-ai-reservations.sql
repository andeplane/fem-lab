CREATE TABLE ai_limits (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  enabled boolean NOT NULL DEFAULT true,
  daily_micros bigint NOT NULL DEFAULT 100000000 CHECK (daily_micros >= 0),
  monthly_micros bigint NOT NULL DEFAULT 1000000000 CHECK (monthly_micros >= 0),
  free_daily_micros bigint NOT NULL DEFAULT 20000000 CHECK (free_daily_micros >= 0),
  uncertain_micros bigint NOT NULL DEFAULT 10000000 CHECK (uncertain_micros >= 0),
  concurrent integer NOT NULL DEFAULT 16 CHECK (concurrent > 0)
);
INSERT INTO ai_limits(id) VALUES(true);
CREATE TABLE ai_requests (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  body_digest text NOT NULL CHECK (length(body_digest) = 64),
  turn_id text NOT NULL,
  round integer NOT NULL CHECK (round BETWEEN 0 AND 11),
  model text NOT NULL,
  plan text NOT NULL,
  tariff_version text NOT NULL,
  state text NOT NULL CHECK (state IN ('preflight','reserved','dispatched','pending_reconciliation','settled','released','company_loss')),
  max_output integer NOT NULL CHECK (max_output > 0),
  input_tokens integer,
  held_subcredits bigint NOT NULL DEFAULT 0 CHECK (held_subcredits >= 0),
  held_supplier_micros bigint NOT NULL DEFAULT 0 CHECK (held_supplier_micros >= 0),
  provider_id text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deadline timestamptz NOT NULL,
  UNIQUE(account_id, idempotency_key),
  UNIQUE(id, account_id)
);
CREATE INDEX ai_requests_recovery ON ai_requests(state, deadline);
CREATE INDEX ai_requests_account_time ON ai_requests(account_id, created_at);
CREATE TABLE credit_holds (
  request_id uuid NOT NULL,
  account_id uuid NOT NULL,
  grant_id uuid NOT NULL,
  amount bigint NOT NULL CHECK (amount > 0),
  PRIMARY KEY(request_id, grant_id),
  FOREIGN KEY (request_id, account_id) REFERENCES ai_requests(id, account_id),
  FOREIGN KEY (grant_id, account_id) REFERENCES credit_grants(id, account_id)
);
CREATE INDEX credit_holds_grant ON credit_holds(grant_id);
CREATE TABLE usage_receipts (
  request_id uuid PRIMARY KEY,
  account_id uuid NOT NULL,
  model text NOT NULL,
  tariff_version text NOT NULL,
  usage jsonb,
  charged_subcredits bigint NOT NULL CHECK (charged_subcredits >= 0),
  supplier_micros bigint NOT NULL CHECK (supplier_micros >= 0),
  company_loss_micros bigint NOT NULL CHECK (company_loss_micros >= 0),
  free_pool boolean NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('confirmed','undispatched','unknown')),
  created_at timestamptz NOT NULL,
  FOREIGN KEY (request_id, account_id) REFERENCES ai_requests(id, account_id)
);
CREATE TRIGGER immutable_usage_receipts BEFORE UPDATE OR DELETE ON usage_receipts
  FOR EACH ROW EXECUTE FUNCTION reject_financial_mutation();
