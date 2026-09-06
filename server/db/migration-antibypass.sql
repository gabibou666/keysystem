-- Migration anti-bypass: traçabilité des sessions LootLabs
-- - started_at: pour le délai minimum réaliste (un humain met > 20s, un bot quelques secondes)
-- - owner_discord_id: lie la session à l'utilisateur Discord qui l'a initiée (le status ne délivrera
--   la clé qu'au propriétaire)
-- - completion_token: JWT à usage unique généré au postback, exigé au status
-- - postback_ip: IP source du postback LootLabs (audit)
ALTER TABLE ll_sessions ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE ll_sessions ADD COLUMN IF NOT EXISTS owner_discord_id TEXT;
ALTER TABLE ll_sessions ADD COLUMN IF NOT EXISTS completion_token TEXT;
ALTER TABLE ll_sessions ADD COLUMN IF NOT EXISTS postback_ip TEXT;
-- statut final post-delivrance (token brule)
ALTER TABLE ll_sessions ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;
