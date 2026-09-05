-- Migration: cache des utilisateurs Roblox (pseudo + avatar pour le feed d'activite)
CREATE TABLE IF NOT EXISTS user_cache (
  user_id     BIGINT PRIMARY KEY,
  username    TEXT,
  display     TEXT,
  avatar_url  TEXT,
  has_premium BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
