-- 001_enterprise_baseline.sql

CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- Users: lockout & lifecycle
ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_disabled boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login timestamptz;

-- Requests: idempotency
ALTER TABLE requests ADD COLUMN IF NOT EXISTS idempotency_key text;
CREATE UNIQUE INDEX IF NOT EXISTS ux_requests_agent_idempotency
  ON requests(agent_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Performance indexes (safe)
CREATE INDEX IF NOT EXISTS ix_requests_required_role_status_assignee
  ON requests(required_role, status, assigned_to_user_id);
CREATE INDEX IF NOT EXISTS ix_requests_agent_created_at
  ON requests(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_requests_division_status
  ON requests(division_id, status);

-- Refresh tokens
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id bigserial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  user_agent text,
  ip text
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_refresh_tokens_hash ON refresh_tokens(token_hash);
CREATE INDEX IF NOT EXISTS ix_refresh_tokens_user_expires ON refresh_tokens(user_id, expires_at DESC);

-- Auth events
CREATE TABLE IF NOT EXISTS auth_events (
  id bigserial PRIMARY KEY,
  user_id integer REFERENCES users(id) ON DELETE SET NULL,
  event text NOT NULL,
  ip text,
  user_agent text,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_auth_events_user_created_at ON auth_events(user_id, created_at DESC);

-- Request audit events
CREATE TABLE IF NOT EXISTS request_events (
  id bigserial PRIMARY KEY,
  request_id integer NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  actor_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  event text NOT NULL,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_request_events_request_created_at ON request_events(request_id, created_at DESC);
