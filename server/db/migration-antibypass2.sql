-- Migration anti-bypass v2: watermarking + beacons + verification revenu
--
-- executions.wm_nonce: chaque exécution embarque un identifiant unique (watermark);
-- le script servi l'envoie périodiquement -> un dump partagé révèle son nonce.
CREATE TABLE IF NOT EXISTS beacons (
  id         SERIAL PRIMARY KEY,
  wm_nonce   TEXT NOT NULL,
  user_id    BIGINT,
  executor   TEXT,
  ip         TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_beacons_nonce ON beacons(wm_nonce);

ALTER TABLE executions ADD COLUMN IF NOT EXISTS wm_nonce TEXT;

-- Sessions LootLabs: verifie que le puid a genere du REVENU reel (subid des stats LootLabs)
ALTER TABLE ll_sessions ADD COLUMN IF NOT EXISTS revenue_verified BOOLEAN NOT NULL DEFAULT FALSE;

-- Keys: compteur d'alertes partage (auto-revocation a 3)
ALTER TABLE keys ADD COLUMN IF NOT EXISTS share_alerts INT NOT NULL DEFAULT 0;
