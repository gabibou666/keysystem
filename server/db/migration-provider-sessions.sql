-- Migration: regie publicitaire choisie par session (LootLabs / Work.ink)
--
-- provider       : regie utilisee pour cette session ('lootlabs' | 'workink').
--                  Tracee en base pour l'audit et pour verifier qu'un postback
--                  ne delivre une cle que via la regie qui a servi la session.
-- duration_hours : duree de la cle GRAVEE au demarrage de la session
--                  (LOOTLABS_DURATION_HOURS = 12 par defaut,
--                   WORKINK_DURATION_HOURS = 24 par defaut).
--                  /api/key/status lit CETTE colonne: deux regies peuvent
--                  demander une seule annonce et delivrer des durees
--                  differentes (1 checkpoint ne veut plus dire 12 h).
ALTER TABLE ll_sessions ADD COLUMN IF NOT EXISTS provider TEXT;
ALTER TABLE ll_sessions ADD COLUMN IF NOT EXISTS duration_hours INT;

-- Backfill des sessions anterieures: LootLabs + duree deduite des checkpoints
UPDATE ll_sessions SET provider = 'lootlabs' WHERE provider IS NULL;
UPDATE ll_sessions
   SET duration_hours = CASE WHEN tasks_required >= 2 THEN 24 ELSE 12 END
 WHERE duration_hours IS NULL;

ALTER TABLE ll_sessions ALTER COLUMN provider SET DEFAULT 'lootlabs';
ALTER TABLE ll_sessions ALTER COLUMN provider SET NOT NULL;
ALTER TABLE ll_sessions ALTER COLUMN duration_hours SET DEFAULT 12;
ALTER TABLE ll_sessions ALTER COLUMN duration_hours SET NOT NULL;

-- Suivi/statistiques par regie (et audit anti-bypass)
CREATE INDEX IF NOT EXISTS idx_ll_sessions_provider ON ll_sessions (provider);
