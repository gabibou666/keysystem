-- Original owner sources are encrypted separately from executable delivery builds.
ALTER TABLE developer_scripts ADD COLUMN IF NOT EXISTS original_content_enc TEXT;
ALTER TABLE developer_scripts ADD COLUMN IF NOT EXISTS original_content_iv TEXT;
ALTER TABLE developer_scripts ADD COLUMN IF NOT EXISTS filename TEXT NOT NULL DEFAULT 'script.lua';
ALTER TABLE developer_scripts ADD COLUMN IF NOT EXISTS original_size_bytes INTEGER;
ALTER TABLE developer_scripts ADD COLUMN IF NOT EXISTS output_size_bytes INTEGER;
ALTER TABLE developer_scripts ADD COLUMN IF NOT EXISTS obfuscation_level TEXT;
ALTER TABLE developer_scripts ADD COLUMN IF NOT EXISTS build_duration_ms INTEGER;
CREATE TABLE IF NOT EXISTS developer_script_jobs (
 id UUID PRIMARY KEY,
 project_id UUID NOT NULL REFERENCES developer_projects(id) ON DELETE CASCADE,
 owner_id TEXT NOT NULL REFERENCES developer_accounts(discord_id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('upload','publish')),
 status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','processing','review','succeeded','failed','cancelled')),
 progress INTEGER NOT NULL DEFAULT 0 CHECK(progress>=0 AND progress<=100),
 original_content_enc TEXT, original_content_iv TEXT,
 original_size_bytes INTEGER NOT NULL CHECK(original_size_bytes>0 AND original_size_bytes<=8388608),
 filename TEXT NOT NULL DEFAULT 'script.lua',
 obfuscate BOOLEAN NOT NULL DEFAULT false,
 obfuscation_level TEXT NOT NULL DEFAULT 'standard' CHECK(obfuscation_level IN ('standard','strong')),
 target_mode TEXT NOT NULL DEFAULT 'universal', place_id BIGINT,
 expected_version INTEGER NOT NULL DEFAULT 0, expected_hash TEXT, expected_safety TEXT,
 expected_listing_updated_at TIMESTAMPTZ,
 publication JSONB,
 output_size_bytes INTEGER, build_duration_ms INTEGER,
 logs JSONB NOT NULL DEFAULT '[]', result JSONB,
 error_code TEXT, error_message TEXT,
 worker_token UUID, lease_expires_at TIMESTAMPTZ,
 attempts INTEGER NOT NULL DEFAULT 0,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS script_jobs_queue ON developer_script_jobs(status,created_at);
CREATE INDEX IF NOT EXISTS script_jobs_owner ON developer_script_jobs(owner_id,created_at);
CREATE INDEX IF NOT EXISTS script_jobs_project ON developer_script_jobs(project_id,created_at);
-- No owner/project/job FK: deletion must not release a remote process's live
-- worker slot. This row contains only an opaque runtime token and deadline.
CREATE TABLE IF NOT EXISTS developer_script_worker_lease (
 id INTEGER PRIMARY KEY CHECK(id=1), worker_token UUID, expires_at TIMESTAMPTZ
);
INSERT INTO developer_script_worker_lease(id) VALUES(1) ON CONFLICT(id) DO NOTHING;
ALTER TABLE developer_moderation_submissions ADD COLUMN IF NOT EXISTS job_id UUID REFERENCES developer_script_jobs(id) ON DELETE SET NULL;
ALTER TABLE developer_moderation_submissions ADD COLUMN IF NOT EXISTS obfuscated BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE developer_moderation_submissions ADD COLUMN IF NOT EXISTS obfuscation_level TEXT;
