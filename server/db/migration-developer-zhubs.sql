-- Public metadata is explicitly published, independently of private projects.
CREATE TABLE IF NOT EXISTS developer_hubs (
  id UUID PRIMARY KEY,
  owner_id TEXT NOT NULL UNIQUE REFERENCES developer_accounts(discord_id),
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
  description TEXT NOT NULL DEFAULT '',
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Automatically generated author profiles allow direct script publication.
-- Explicitly edited profiles retain their own visibility choice.
ALTER TABLE developer_hubs ADD COLUMN IF NOT EXISTS auto_profile BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS developer_listings (
  project_id UUID PRIMARY KEY REFERENCES developer_projects(id),
  hub_id UUID NOT NULL REFERENCES developer_hubs(id),
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 80),
  description TEXT NOT NULL DEFAULT '',
  game TEXT NOT NULL DEFAULT '',
  access_mode TEXT NOT NULL DEFAULT 'licensed' CHECK(access_mode IN ('licensed','free')),
  published_at TIMESTAMPTZ,
  snapshot_content_enc TEXT,
  snapshot_content_iv TEXT,
  script_version INT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS developer_listings_hub ON developer_listings(hub_id,published_at);
