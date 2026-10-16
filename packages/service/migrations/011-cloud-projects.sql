-- Immutable chunk keys belong to one upload and account. No caller supplies a bucket/key.
CREATE TABLE cloud_storage_accounts (
  account_id uuid PRIMARY KEY REFERENCES accounts(id),
  change_version bigint NOT NULL DEFAULT 0 CHECK(change_version >= 0),
  used_bytes bigint NOT NULL DEFAULT 0 CHECK(used_bytes >= 0),
  reserved_bytes bigint NOT NULL DEFAULT 0 CHECK(reserved_bytes >= 0),
  pending_bytes bigint NOT NULL DEFAULT 0 CHECK(pending_bytes >= 0)
);
CREATE TABLE cloud_projects (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  name text NOT NULL CHECK(length(name) <= 200),
  revision bigint NOT NULL DEFAULT 0 CHECK(revision >= 0),
  change_version bigint NOT NULL DEFAULT 0 CHECK(change_version >= 0),
  bytes bigint NOT NULL DEFAULT 0 CHECK(bytes >= 0),
  manifest jsonb,
  current_upload_id uuid,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  UNIQUE(id,account_id)
);
CREATE INDEX cloud_projects_changes ON cloud_projects(account_id,change_version);
CREATE TABLE cloud_project_uploads (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  project_id uuid NOT NULL,
  base_revision bigint NOT NULL CHECK(base_revision >= 0),
  request_key text NOT NULL CHECK(length(request_key) BETWEEN 1 AND 200),
  request_sha256 text NOT NULL CHECK(request_sha256 ~ '^[a-f0-9]{64}$'),
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
  manifest jsonb NOT NULL,
  bytes bigint NOT NULL CHECK(bytes > 0),
  reserved_bytes bigint NOT NULL CHECK(reserved_bytes >= 0),
  state text NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','committed','expired','aborted')),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  receipt jsonb,
  UNIQUE(account_id,request_key),
  UNIQUE(id,account_id),
  FOREIGN KEY(project_id,account_id) REFERENCES cloud_projects(id,account_id)
);
CREATE UNIQUE INDEX cloud_project_one_upload ON cloud_project_uploads(project_id) WHERE state='reserved';
CREATE INDEX cloud_project_upload_expiry ON cloud_project_uploads(state,expires_at);
CREATE TABLE cloud_project_chunks (
  upload_id uuid NOT NULL,
  account_id uuid NOT NULL,
  chunk_index integer NOT NULL CHECK(chunk_index >= 0 AND chunk_index < 8192),
  bytes integer NOT NULL CHECK(bytes > 0 AND bytes <= 8000000),
  sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
  object_name text NOT NULL UNIQUE,
  generation text,
  pending_charged boolean NOT NULL DEFAULT true,
  removed boolean NOT NULL DEFAULT false,
  lease_owner uuid,
  lease_expires_at timestamptz,
  PRIMARY KEY(upload_id,chunk_index),
  FOREIGN KEY(upload_id,account_id) REFERENCES cloud_project_uploads(id,account_id)
);
CREATE TABLE cloud_project_operations (
  account_id uuid NOT NULL REFERENCES accounts(id),
  request_key text NOT NULL,
  request_sha256 text NOT NULL,
  receipt jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY(account_id,request_key)
);
-- Retained until a generation-pinned delete succeeds. Failed cleanup cannot free exposure.
CREATE TABLE cloud_project_cleanup (
  object_name text PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  generation text,
  pending boolean NOT NULL,
  bytes integer NOT NULL CHECK(bytes > 0),
  not_before timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0
);
CREATE TABLE cloud_project_rates (
  account_id uuid PRIMARY KEY REFERENCES accounts(id),
  starts_at timestamptz NOT NULL,
  reads integer NOT NULL DEFAULT 0,
  writes integer NOT NULL DEFAULT 0
);
