-- Migration: statuts des scripts par jeu (Safe / Undetected, Updating, Detected)
CREATE TABLE IF NOT EXISTS game_statuses (
  place_id     BIGINT PRIMARY KEY,
  status       TEXT NOT NULL DEFAULT 'safe', -- 'safe' (undetected) | 'updating' | 'detected'
  note         TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_game_statuses_status ON game_statuses(status);
