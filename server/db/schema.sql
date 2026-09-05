-- KeySystem schema - Neon Postgres
-- 11 tables

CREATE TABLE IF NOT EXISTS keys (
  id            SERIAL PRIMARY KEY,
  kid           TEXT UNIQUE NOT NULL,            -- id de cle (partie publique avant le point)
  signature     TEXT NOT NULL,                  -- signature HMAC (partie apres le point)
  bound_user_id BIGINT,                         -- UserId Roblox lie au premier check
  duration_hours INT NOT NULL DEFAULT 12,       -- duree du renouvellement courant
  expires_at    TIMESTAMPTZ NOT NULL,
  renewed_count INT NOT NULL DEFAULT 0,
  revoked       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ll_sessions (
  id             SERIAL PRIMARY KEY,
  puid           TEXT UNIQUE NOT NULL,           -- token attache au lien LootLabs
  key_id         INT REFERENCES keys(id),       -- cle concernee par le renouvellement
  tasks_required INT NOT NULL,                  -- nombre de checkpoints
  tasks_done     INT NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'pending', -- pending | completed | expired
  ip             TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at   TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS postbacks (
  id         SERIAL PRIMARY KEY,
  unique_id  TEXT UNIQUE NOT NULL,               -- dedup LootLabs
  puid       TEXT NOT NULL,
  ip         TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS activations (
  id          SERIAL PRIMARY KEY,
  key_id      INT NOT NULL REFERENCES keys(id),
  user_id     BIGINT NOT NULL,
  executor    TEXT,
  success     BOOLEAN NOT NULL DEFAULT TRUE,
  reason      TEXT,
  ip          TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_activations_key ON activations(key_id);
CREATE INDEX IF NOT EXISTS idx_activations_user ON activations(user_id);

CREATE TABLE IF NOT EXISTS executions (
  id         SERIAL PRIMARY KEY,
  key_id     INT NOT NULL,
  user_id    BIGINT NOT NULL,
  executor   TEXT,
  build_id   INT,
  version    INT,
  ip         TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_executions_created ON executions(created_at);
CREATE INDEX IF NOT EXISTS idx_executions_user ON executions(user_id);

CREATE TABLE IF NOT EXISTS error_reports (
  id         SERIAL PRIMARY KEY,
  user_id    BIGINT,
  executor   TEXT,
  version    INT,
  error_msg  TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bans (
  id         SERIAL PRIMARY KEY,
  user_id    BIGINT UNIQUE NOT NULL,
  reason     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  id          SERIAL PRIMARY KEY,
  token_hash  TEXT UNIQUE NOT NULL,
  discord_id  TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS script_versions (
  id           SERIAL PRIMARY KEY,
  version      INT NOT NULL,
  note         TEXT NOT NULL DEFAULT '',
  original_enc TEXT NOT NULL,                   -- original chiffre AES-256-GCM (base64)
  original_iv  TEXT NOT NULL,                   -- IV base64
  original_hash TEXT NOT NULL,                  -- sha256 de l'original en clair
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  published    BOOLEAN NOT NULL DEFAULT FALSE,
  published_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS script_builds (
  id           SERIAL PRIMARY KEY,
  version_id   INT NOT NULL REFERENCES script_versions(id),
  version      INT NOT NULL,
  content      TEXT NOT NULL,                   -- build obfusque
  build_type   TEXT NOT NULL DEFAULT 'shims',   -- shims | ai
  active       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_patches (
  id          SERIAL PRIMARY KEY,
  build_id    INT NOT NULL REFERENCES script_builds(id),
  find        TEXT NOT NULL,
  replace     TEXT NOT NULL,
  reason      TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
