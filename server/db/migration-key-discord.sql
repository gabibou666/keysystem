-- Migration: lien Discord propriétaire sur les clés
-- Chaque clé connaît: son compte Roblox (bound_user_id, existant) ET
-- le compte Discord qui l'a créée (owner_discord_id, depuis la session LootLabs).
ALTER TABLE keys ADD COLUMN IF NOT EXISTS owner_discord_id TEXT;

-- Backfill: les clés existantes héritent du owner de leur session d'origine
UPDATE keys k
SET owner_discord_id = s.owner_discord_id
FROM ll_sessions s
WHERE s.key_id = k.id
  AND s.owner_discord_id IS NOT NULL
  AND k.owner_discord_id IS NULL;
