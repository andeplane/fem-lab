ALTER TABLE ai_limits ADD COLUMN free_monthly_micros bigint NOT NULL DEFAULT 0 CHECK (free_monthly_micros >= 0);

CREATE TABLE free_eligibilities (
  id uuid PRIMARY KEY,
  person_reference text NOT NULL UNIQUE CHECK (person_reference ~ '^[A-Za-z0-9._-]{1,128}$'),
  account_id uuid NOT NULL UNIQUE REFERENCES accounts(id),
  email_fingerprint text NOT NULL CHECK (email_fingerprint ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('approved','revoked')),
  approved_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE TABLE free_eligibility_identities (
  fingerprint text PRIMARY KEY CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  eligibility_id uuid NOT NULL REFERENCES free_eligibilities(id),
  created_at timestamptz NOT NULL,
  UNIQUE (eligibility_id,fingerprint)
);
ALTER TABLE free_eligibilities ADD FOREIGN KEY (id,email_fingerprint)
  REFERENCES free_eligibility_identities(eligibility_id,fingerprint) DEFERRABLE INITIALLY DEFERRED;
CREATE TRIGGER immutable_free_identity BEFORE UPDATE OR DELETE ON free_eligibility_identities
  FOR EACH ROW EXECUTE FUNCTION reject_financial_mutation();
