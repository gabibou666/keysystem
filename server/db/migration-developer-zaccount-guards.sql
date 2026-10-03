-- Normalize known equivalent addresses. Any pre-existing collision fails the
-- transaction for operator review; existing accounts are never silently merged.
UPDATE developer_accounts SET email=CASE
  WHEN split_part(lower(trim(email)), '@', 2) IN ('gmail.com','googlemail.com')
    THEN replace(split_part(split_part(lower(trim(email)), '@', 1), '+', 1), '.', '') || '@gmail.com'
  ELSE lower(trim(email)) END WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS developer_account_email_casefold ON developer_accounts(lower(email));
CREATE TABLE IF NOT EXISTS developer_registration_limits (
  quota_key TEXT PRIMARY KEY,
  window_start TIMESTAMPTZ NOT NULL,
  account_count INT NOT NULL DEFAULT 0 CHECK (account_count>=0)
);
CREATE INDEX IF NOT EXISTS developer_registration_window ON developer_registration_limits(window_start);
