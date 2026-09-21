-- Migration: demandes de scripts ("Demande ton script")
-- Un utilisateur connecte peut demander un script pour un jeu (PlaceId) qu'il
-- souhaite voir supporte. Publier un script pour ce PlaceId sert automatiquement
-- toutes les demandes en attente (status -> 'fulfilled').
CREATE TABLE IF NOT EXISTS script_requests (
  id             SERIAL PRIMARY KEY,
  place_id       BIGINT NOT NULL,
  discord_id     TEXT NOT NULL,
  roblox_user_id BIGINT,
  note           TEXT,
  status         TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'fulfilled'
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  fulfilled_at   TIMESTAMPTZ,
  notified_at    TIMESTAMPTZ -- popup "ton script est pret" affiche une seule fois
);

-- UNE SEULE demande en attente par (discord_id, place_id): l'index partiel est
-- le garde-fou de la base contre le spam, en plus du controle de l'API (une
-- demande servie n'empeche pas d'en redemander une plus tard).
CREATE UNIQUE INDEX IF NOT EXISTS idx_script_requests_pending
  ON script_requests (discord_id, place_id) WHERE status = 'pending';

-- Classement public des jeux les plus demandes (COUNT par place_id)
CREATE INDEX IF NOT EXISTS idx_script_requests_place
  ON script_requests (place_id);

-- Mes demandes (en attente / servies a notifier): filtre par utilisateur
CREATE INDEX IF NOT EXISTS idx_script_requests_discord
  ON script_requests (discord_id);
