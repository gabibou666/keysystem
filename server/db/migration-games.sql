-- Migration: cache des infos de jeux (nom, icone, stats depuis les APIs Roblox)
CREATE TABLE IF NOT EXISTS game_info (
  place_id    BIGINT PRIMARY KEY,
  name        TEXT NOT NULL,
  icon_url    TEXT,
  playing     INT,
  visits      BIGINT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
