ALTER TABLE developer_accounts ADD COLUMN IF NOT EXISTS banned_at TIMESTAMPTZ;
ALTER TABLE developer_accounts ADD COLUMN IF NOT EXISTS ban_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE developer_accounts ADD COLUMN IF NOT EXISTS suspended_until TIMESTAMPTZ;
ALTER TABLE developer_accounts ADD COLUMN IF NOT EXISTS suspension_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE developer_accounts ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
ALTER TABLE developer_accounts ADD COLUMN IF NOT EXISTS last_login_provider TEXT;
ALTER TABLE developer_accounts ADD COLUMN IF NOT EXISTS last_login_subject TEXT;
ALTER TABLE developer_identities ADD COLUMN IF NOT EXISTS oauth_verified_at TIMESTAMPTZ;
ALTER TABLE developer_identities ADD COLUMN IF NOT EXISTS provider_username TEXT;
ALTER TABLE developer_projects ADD COLUMN IF NOT EXISTS disabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE developer_projects ADD COLUMN IF NOT EXISTS hidden BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE developer_projects ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE developer_projects ADD COLUMN IF NOT EXISTS disabled_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE developer_scripts ADD COLUMN IF NOT EXISTS disabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE developer_scripts ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE developer_licenses ADD COLUMN IF NOT EXISTS admin_revoked BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE developer_licenses ADD COLUMN IF NOT EXISTS admin_revoked_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE developer_licenses ADD COLUMN IF NOT EXISTS admin_revoked_at TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS developer_staff_roles (
  account_id TEXT PRIMARY KEY REFERENCES developer_accounts(discord_id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('USER','MODERATOR','ADMIN','CO_OWNER')),
  updated_by TEXT REFERENCES developer_accounts(discord_id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Existing explicit assignments remain available. OWNER is always computed
-- from a newly verified Discord OAuth identity, never migrated from an ID.
INSERT INTO developer_staff_roles(account_id,role)
 SELECT account_id,upper(role) FROM developer_moderation_roles
 ON CONFLICT(account_id) DO NOTHING;
CREATE TABLE IF NOT EXISTS developer_staff_invitations (
  id UUID PRIMARY KEY,
  target_type TEXT NOT NULL CHECK(target_type IN ('email','discord','username','account')),
  target_value TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('MODERATOR','ADMIN','CO_OWNER')),
  token_hash TEXT UNIQUE,
  target_account_id TEXT REFERENCES developer_accounts(discord_id) ON DELETE SET NULL,
  created_by TEXT REFERENCES developer_accounts(discord_id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  accepted_by TEXT REFERENCES developer_accounts(discord_id) ON DELETE SET NULL,
  cancelled_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS staff_invitations_target ON developer_staff_invitations(target_type,target_value);
CREATE TABLE IF NOT EXISTS developer_admin_sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES developer_accounts(discord_id) ON DELETE CASCADE,
  developer_session_hash TEXT NOT NULL REFERENCES developer_sessions(token_hash) ON DELETE CASCADE,
  csrf_hash TEXT NOT NULL,
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admin_sessions_account ON developer_admin_sessions(account_id);
CREATE TABLE IF NOT EXISTS developer_admin_audit (
  id UUID PRIMARY KEY,
  actor_id TEXT,
  actor_role TEXT NOT NULL DEFAULT 'USER',
  action TEXT NOT NULL,
  target_type TEXT NOT NULL DEFAULT '',
  target_id TEXT,
  reason TEXT NOT NULL DEFAULT '',
  before_data JSONB NOT NULL DEFAULT '{}',
  after_data JSONB NOT NULL DEFAULT '{}',
  ip TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admin_audit_time ON developer_admin_audit(created_at);
CREATE TABLE IF NOT EXISTS developer_site_settings (
  id INTEGER PRIMARY KEY CHECK(id=1),
  maintenance_enabled BOOLEAN NOT NULL DEFAULT false,
  maintenance_message TEXT NOT NULL DEFAULT '',
  registration_open BOOLEAN NOT NULL DEFAULT true,
  announcement_enabled BOOLEAN NOT NULL DEFAULT false,
  announcement_message TEXT NOT NULL DEFAULT '',
  announcement_level TEXT NOT NULL DEFAULT 'info' CHECK(announcement_level IN ('info','warning','success')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT REFERENCES developer_accounts(discord_id) ON DELETE SET NULL
);
INSERT INTO developer_site_settings(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS developer_account_warnings (
  id UUID PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES developer_accounts(discord_id) ON DELETE CASCADE,
  created_by TEXT REFERENCES developer_accounts(discord_id) ON DELETE SET NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE developer_moderation_reports ADD COLUMN IF NOT EXISTS assigned_to TEXT REFERENCES developer_accounts(discord_id) ON DELETE SET NULL;
ALTER TABLE developer_moderation_reports ADD COLUMN IF NOT EXISTS staff_note TEXT NOT NULL DEFAULT '';
ALTER TABLE developer_moderation_reports ADD COLUMN IF NOT EXISTS resolution_reason TEXT NOT NULL DEFAULT '';

-- BEGIN POSTGRES ADMIN AUDIT GUARD
-- PostgreSQL enforces append-only history even if an application bug issues a
-- destructive query. pg-mem fixtures cannot execute procedural triggers.
CREATE OR REPLACE FUNCTION audit_hub_admin_audit_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Admin audit history is append-only';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS admin_audit_append_only ON developer_admin_audit;
CREATE TRIGGER admin_audit_append_only BEFORE UPDATE OR DELETE ON developer_admin_audit
 FOR EACH ROW EXECUTE FUNCTION audit_hub_admin_audit_append_only();
-- END POSTGRES ADMIN AUDIT GUARD
