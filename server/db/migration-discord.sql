-- Migration: joins Discord (gate OAuth pour getkey)
CREATE TABLE IF NOT EXISTS discord_joins (
  id         SERIAL PRIMARY KEY,
  discord_id TEXT UNIQUE NOT NULL,
  username   TEXT,
  avatar     TEXT,
  joined     BOOLEAN NOT NULL DEFAULT FALSE,      -- ajoute au serveur avec succes
  last_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
