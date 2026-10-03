-- Metadata-only moderation journal. Application never records source or credentials.
CREATE TABLE IF NOT EXISTS developer_moderation_roles (
 account_id TEXT PRIMARY KEY REFERENCES developer_accounts(discord_id) ON DELETE CASCADE,
 role TEXT NOT NULL CHECK(role IN ('moderator','admin')),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE developer_scripts ADD COLUMN IF NOT EXISTS safety_status TEXT NOT NULL DEFAULT 'unreviewed';
ALTER TABLE developer_scripts ADD COLUMN IF NOT EXISTS safety_hash TEXT;
ALTER TABLE developer_scripts ADD COLUMN IF NOT EXISTS scanner_version TEXT;
ALTER TABLE developer_listings ADD COLUMN IF NOT EXISTS safety_hash TEXT;
ALTER TABLE developer_listings ADD COLUMN IF NOT EXISTS safety_status TEXT NOT NULL DEFAULT 'unreviewed';
CREATE TABLE IF NOT EXISTS developer_moderation_submissions (
 id UUID PRIMARY KEY, project_id UUID NOT NULL REFERENCES developer_projects(id) ON DELETE CASCADE,
 owner_id TEXT NOT NULL REFERENCES developer_accounts(discord_id),
 base_version INTEGER NOT NULL, base_hash TEXT, version INTEGER NOT NULL,
 content_enc TEXT,content_iv TEXT,build_hash TEXT NOT NULL,
 target_mode TEXT NOT NULL,place_id BIGINT,builder_version TEXT,
 scanner_version TEXT NOT NULL, findings JSONB NOT NULL DEFAULT '[]',
 status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','stale')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),decided_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS moderation_queue ON developer_moderation_submissions(status,created_at);
CREATE TABLE IF NOT EXISTS developer_moderation_reports (
 id UUID PRIMARY KEY, project_id UUID NOT NULL REFERENCES developer_projects(id) ON DELETE CASCADE,
 reporter_id TEXT NOT NULL REFERENCES developer_accounts(discord_id),
 reason TEXT NOT NULL CHECK(reason IN ('malware','privacy','misleading','copyright','other')),
 description TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),resolved_at TIMESTAMPTZ
);
ALTER TABLE developer_moderation_submissions ADD COLUMN IF NOT EXISTS decision_note TEXT NOT NULL DEFAULT '';
ALTER TABLE developer_moderation_reports ADD COLUMN IF NOT EXISTS resolution_note TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS moderation_reports_queue ON developer_moderation_reports(status,created_at);
CREATE TABLE IF NOT EXISTS developer_moderation_audit (
 id UUID PRIMARY KEY,actor_id TEXT,action TEXT NOT NULL,project_id UUID,
 version INTEGER,build_hash TEXT,rule_ids JSONB NOT NULL DEFAULT '[]',
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS moderation_audit_time ON developer_moderation_audit(created_at);
ALTER TABLE developer_moderation_audit ADD COLUMN IF NOT EXISTS status_code INTEGER;
ALTER TABLE developer_moderation_audit ADD COLUMN IF NOT EXISTS action_note TEXT NOT NULL DEFAULT '';
ALTER TABLE developer_moderation_audit ADD COLUMN IF NOT EXISTS subject_id TEXT;
ALTER TABLE developer_moderation_audit ADD COLUMN IF NOT EXISTS role_value TEXT;
