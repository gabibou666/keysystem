-- Migration: Multi-boost tracking (1 boost = 1 key of 7 days, 2nd boost required for +7 days)
ALTER TABLE booster_claims ADD COLUMN IF NOT EXISTS premium_since TEXT;

CREATE TABLE IF NOT EXISTS booster_credits (
  id SERIAL PRIMARY KEY,
  discord_id TEXT UNIQUE NOT NULL,
  extra_boosts INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_booster_credits_discord ON booster_credits(discord_id);
