-- Migration : Reset HWID + Système de Parrainage
ALTER TABLE keys ADD COLUMN IF NOT EXISTS hwid_last_reset TIMESTAMP WITH TIME ZONE;

CREATE TABLE IF NOT EXISTS referrals (
  id SERIAL PRIMARY KEY,
  referrer_discord_id TEXT NOT NULL,
  referred_discord_id TEXT NOT NULL UNIQUE,
  referred_ip TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  completed_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals (referrer_discord_id);
CREATE INDEX IF NOT EXISTS idx_referrals_referred ON referrals (referred_discord_id);

CREATE TABLE IF NOT EXISTS referral_rewards (
  id SERIAL PRIMARY KEY,
  discord_id TEXT NOT NULL,
  reward_type TEXT NOT NULL DEFAULT 'key_24h_vip',
  key_id INT REFERENCES keys(id) ON DELETE SET NULL,
  claimed_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_referral_rewards_discord ON referral_rewards (discord_id);
