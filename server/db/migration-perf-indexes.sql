-- Performance: index pour les requetes chaudes du systeme de cles.
-- Sans ces index, chaque /api/key/start scanne TOUTE la table ll_sessions
-- (compteurs anti-farm par IP et par compte Discord) — le scan croit
-- lineairement avec le volume et ralentit la delivrance.

-- Anti-farm: COUNT(*) par IP sur 12h glissantes
CREATE INDEX IF NOT EXISTS idx_ll_sessions_ip_created
  ON ll_sessions (ip, created_at);

-- Anti-farm: COUNT(*) par owner Discord sur 12h glissantes
CREATE INDEX IF NOT EXISTS idx_ll_sessions_owner_created
  ON ll_sessions (owner_discord_id, created_at);

-- Admin /keys: compteur executions par cle (sous-requete/JOIN sur key_id)
CREATE INDEX IF NOT EXISTS idx_executions_key
  ON executions (key_id);

-- Postback: SELECT unique_id (dedup) est deja unique, mais la future purge
-- et le diagnostic par puid profitent d'un index sur puid.
CREATE INDEX IF NOT EXISTS idx_postbacks_puid
  ON postbacks (puid);

-- Beacons watermark: jointures par nonce (deja indexe idx_beacons_nonce, rien a faire)
