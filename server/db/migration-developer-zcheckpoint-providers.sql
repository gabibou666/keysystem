-- Add provider choices without changing existing LootLabs projects or sessions.
ALTER TABLE developer_projects ADD COLUMN IF NOT EXISTS checkpoint_provider TEXT NOT NULL DEFAULT 'lootlabs'
  CHECK (checkpoint_provider IN ('lootlabs','workink','linkvertise','linkunlocker'));
ALTER TABLE developer_projects ADD COLUMN IF NOT EXISTS checkpoint_link_url TEXT;
ALTER TABLE developer_projects ADD COLUMN IF NOT EXISTS checkpoint_token_enc TEXT;
ALTER TABLE developer_projects ADD COLUMN IF NOT EXISTS checkpoint_token_iv TEXT;
ALTER TABLE developer_projects ADD COLUMN IF NOT EXISTS checkpoint_link_id TEXT;
ALTER TABLE developer_checkpoints ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'lootlabs'
  CHECK (provider IN ('lootlabs','workink','linkvertise','linkunlocker'));
ALTER TABLE developer_checkpoints ADD COLUMN IF NOT EXISTS provider_reference TEXT;
ALTER TABLE developer_checkpoints ADD COLUMN IF NOT EXISTS return_proof_hash TEXT;
