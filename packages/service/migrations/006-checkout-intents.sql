CREATE TABLE checkout_intents (
  account_id uuid PRIMARY KEY REFERENCES accounts(id),
  id uuid NOT NULL UNIQUE,
  plan text NOT NULL CHECK (plan IN ('plus','pro','studio')),
  session_id text UNIQUE,
  session_url text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE TABLE plan_changes (
  account_id uuid PRIMARY KEY REFERENCES accounts(id),
  plan text NOT NULL CHECK (plan IN ('plus','pro','studio')),
  effective_at timestamptz NOT NULL,
  operation_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('pending','complete')),
  schedule_id text,
  updated_at timestamptz NOT NULL
);
