-- Migration: nombre de publicites EXIGEES par session (palier de la regie)
--
-- ad_count : nombre de publicites reelles attendues pour cette session, grave
--            au demarrage de session, cote serveur uniquement:
--              1 = LootLabs "1 pub" (LOOTLABS_DURATION_HOURS)  ou Work.ink
--              2 = LootLabs "2 pubs" (LOOTLABS_DURATION_HOURS_2)
--            Il correspond au champ number_of_tasks envoye a LootLabs
--            (doc officielle: "The max number of ads associated with the link
--            shortener in a given session", 1-5).
--
--            POURQUOI une colonne dediee: la duree de la cle (duration_hours) et
--            le nombre de pubs sont deux choses distinctes. /api/key/status
--            delivre EXACTEMENT duration_hours, et le postback ne valide la
--            session qu'apres ad_count publicites reellement completees
--            (compteur de postbacks). Une requete modifiee par le client ne
--            peut donc ni reduire le nombre de pubs exige, ni gonfler la duree.
--
-- Idempotent: peut etre rejoue sans erreur (ADD COLUMN IF NOT EXISTS + UPDATE
-- conditionnels), comme les autres fichiers db/migration-*.sql.
ALTER TABLE ll_sessions ADD COLUMN IF NOT EXISTS ad_count INT;

-- Backfill des sessions anterieures: le nombre de pubs etait alors le nombre de
-- points de controle enregistres (tasks_required), au minimum 1.
UPDATE ll_sessions
   SET ad_count = GREATEST(COALESCE(tasks_required, 1), 1)
 WHERE ad_count IS NULL;

ALTER TABLE ll_sessions ALTER COLUMN ad_count SET DEFAULT 1;
ALTER TABLE ll_sessions ALTER COLUMN ad_count SET NOT NULL;

-- Audit par palier (qui a demande 1 pub / 2 pubs) et par regie.
CREATE INDEX IF NOT EXISTS idx_ll_sessions_provider_ads ON ll_sessions (provider, ad_count);
