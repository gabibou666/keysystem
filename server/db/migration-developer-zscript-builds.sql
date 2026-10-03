-- Existing encrypted source is preserved, but needs re-upload before delivery.
ALTER TABLE developer_scripts ADD COLUMN IF NOT EXISTS validated BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE developer_scripts ADD COLUMN IF NOT EXISTS obfuscated BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE developer_scripts ADD COLUMN IF NOT EXISTS target_mode TEXT NOT NULL DEFAULT 'universal';
ALTER TABLE developer_scripts ADD COLUMN IF NOT EXISTS place_id BIGINT;
ALTER TABLE developer_scripts ADD COLUMN IF NOT EXISTS builder_version TEXT;
ALTER TABLE developer_scripts ADD COLUMN IF NOT EXISTS build_hash TEXT;
ALTER TABLE developer_listings ADD COLUMN IF NOT EXISTS snapshot_validated BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE developer_listings ADD COLUMN IF NOT EXISTS snapshot_obfuscated BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE developer_listings ADD COLUMN IF NOT EXISTS target_mode TEXT NOT NULL DEFAULT 'universal';
ALTER TABLE developer_listings ADD COLUMN IF NOT EXISTS place_id BIGINT;
