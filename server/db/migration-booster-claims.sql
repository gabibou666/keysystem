-- Migration: Booster Claims (7-day free keys for Discord Server Boosters)
CREATE TABLE IF NOT EXISTS booster_claims (
  id SERIAL PRIMARY KEY,
  discord_id TEXT NOT NULL,
  key_id INT REFERENCES keys(id),
  action TEXT NOT NULL DEFAULT 'create',
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_booster_claims_discord ON booster_claims(discord_id);
