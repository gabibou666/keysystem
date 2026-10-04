-- Do not invent acceptance records for pre-existing accounts.
ALTER TABLE developer_accounts ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ;
ALTER TABLE developer_accounts ADD COLUMN IF NOT EXISTS terms_version VARCHAR(20);
ALTER TABLE developer_accounts ADD COLUMN IF NOT EXISTS privacy_version VARCHAR(20);
