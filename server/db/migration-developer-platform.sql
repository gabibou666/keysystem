-- Separate tenant-owned resources; historical AUDIT HUB data stays in its tables.
CREATE TABLE IF NOT EXISTS developer_accounts (
  discord_id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS developer_projects (
  id UUID PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES developer_accounts(discord_id),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  description TEXT NOT NULL DEFAULT '',
  api_token_hash TEXT NOT NULL,
  duration_hours INT NOT NULL DEFAULT 24 CHECK (duration_hours BETWEEN 1 AND 8760),
  hwid_binding BOOLEAN NOT NULL DEFAULT true,
  lootlabs_token_enc TEXT,
  lootlabs_token_iv TEXT,
  checkpoint_secret_hash TEXT,
  checkpoint_count INT NOT NULL DEFAULT 1 CHECK (checkpoint_count BETWEEN 1 AND 5),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS developer_projects_owner ON developer_projects(owner_id);
CREATE TABLE IF NOT EXISTS developer_scripts (
  project_id UUID PRIMARY KEY REFERENCES developer_projects(id),
  content_enc TEXT NOT NULL,
  content_iv TEXT NOT NULL,
  version INT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS developer_licenses (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES developer_projects(id),
  key_hash TEXT UNIQUE NOT NULL,
  key_prefix TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  expires_at TIMESTAMPTZ NOT NULL,
  hwid_hash TEXT,
  revoked BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS developer_licenses_project ON developer_licenses(project_id, created_at DESC);
CREATE TABLE IF NOT EXISTS developer_events (
  id BIGSERIAL PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES developer_projects(id),
  license_id UUID REFERENCES developer_licenses(id),
  success BOOLEAN NOT NULL,
  reason TEXT NOT NULL,
  executor TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS developer_events_project ON developer_events(project_id, created_at DESC);
CREATE TABLE IF NOT EXISTS developer_checkpoints (
  id TEXT PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES developer_projects(id),
  browser_hash TEXT NOT NULL,
  tasks_required INT NOT NULL,
  tasks_done INT NOT NULL DEFAULT 0,
  duration_hours INT NOT NULL,
  key_enc TEXT,
  key_iv TEXT,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '30 minutes',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS developer_checkpoint_receipts (
  project_id UUID NOT NULL REFERENCES developer_projects(id),
  receipt_id TEXT NOT NULL,
  checkpoint_id TEXT NOT NULL REFERENCES developer_checkpoints(id) ON DELETE CASCADE,
  PRIMARY KEY (project_id, receipt_id)
);
