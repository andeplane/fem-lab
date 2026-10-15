CREATE TABLE credit_grants (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  source text NOT NULL UNIQUE,
  plan text NOT NULL CHECK (plan IN ('free', 'plus', 'pro', 'studio')),
  tariff_version text NOT NULL,
  amount bigint NOT NULL CHECK (amount > 0),
  starts_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > starts_at),
  created_at timestamptz NOT NULL,
  UNIQUE (id, account_id)
);
CREATE INDEX credit_grants_account_period ON credit_grants(account_id, expires_at);
CREATE TABLE credit_entries (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL,
  grant_id uuid NOT NULL,
  source text NOT NULL UNIQUE,
  amount bigint NOT NULL CHECK (amount < 0),
  kind text NOT NULL CHECK (kind IN ('usage', 'adjustment')),
  created_at timestamptz NOT NULL,
  FOREIGN KEY (grant_id, account_id) REFERENCES credit_grants(id, account_id)
);
CREATE INDEX credit_entries_grant ON credit_entries(grant_id);
CREATE FUNCTION reject_financial_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'financial records are immutable'; END;
$$;
CREATE TRIGGER immutable_credit_grants BEFORE UPDATE OR DELETE ON credit_grants
  FOR EACH ROW EXECUTE FUNCTION reject_financial_mutation();
CREATE TRIGGER immutable_credit_entries BEFORE UPDATE OR DELETE ON credit_entries
  FOR EACH ROW EXECUTE FUNCTION reject_financial_mutation();
