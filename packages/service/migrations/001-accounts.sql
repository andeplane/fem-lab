CREATE TABLE accounts (
  id uuid PRIMARY KEY,
  firebase_uid text NOT NULL UNIQUE CHECK (length(firebase_uid) BETWEEN 1 AND 128),
  email text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deleting', 'deleted')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
