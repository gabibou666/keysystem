-- Keep existing account IDs and project ownership intact. discord_id is the legacy
-- physical account ID column; new accounts use opaque UUIDs regardless of provider.
ALTER TABLE developer_accounts ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE developer_accounts ADD COLUMN IF NOT EXISTS password_hash TEXT;
ALTER TABLE developer_accounts ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS developer_account_email ON developer_accounts(email);
CREATE TABLE IF NOT EXISTS developer_identities (
  provider TEXT NOT NULL, subject TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES developer_accounts(discord_id) ON DELETE CASCADE,
  PRIMARY KEY(provider,subject)
);
CREATE TABLE IF NOT EXISTS developer_sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES developer_accounts(discord_id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS developer_sessions_account ON developer_sessions(account_id);
CREATE TABLE IF NOT EXISTS developer_email_tokens (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES developer_accounts(discord_id) ON DELETE CASCADE,
  purpose TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL
);
