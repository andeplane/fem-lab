CREATE TABLE account_exports (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL UNIQUE REFERENCES accounts(id),
  state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','ready','expired')),
  object_name text,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  last_error text
);
CREATE TABLE account_deletions (
  account_id uuid PRIMARY KEY REFERENCES accounts(id),
  state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','renewal_canceled','identity_deleted','complete')),
  requested_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  last_error text
);
CREATE INDEX account_deletions_pending ON account_deletions(state,updated_at);
