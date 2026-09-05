-- Migration: scripts par jeu (PlaceId)
ALTER TABLE script_versions ADD COLUMN IF NOT EXISTS place_id BIGINT;
ALTER TABLE script_builds ADD COLUMN IF NOT EXISTS place_id BIGINT;
CREATE INDEX IF NOT EXISTS idx_script_builds_place ON script_builds(place_id);
