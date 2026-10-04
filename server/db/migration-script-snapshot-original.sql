-- Keep the private original that belongs to the public executable snapshot.
-- Legacy snapshots are not backfilled from an unrelated current release.
ALTER TABLE developer_listings ADD COLUMN IF NOT EXISTS snapshot_original_content_enc TEXT;
ALTER TABLE developer_listings ADD COLUMN IF NOT EXISTS snapshot_original_content_iv TEXT;
-- Retain a legacy source only when it still belongs to this exact snapshot.
-- This does not change any security status or create an automatic scan proof.
UPDATE developer_listings
SET snapshot_original_content_enc=s.original_content_enc,
    snapshot_original_content_iv=s.original_content_iv
FROM developer_scripts AS s
WHERE s.project_id=developer_listings.project_id AND s.version=developer_listings.script_version
  AND s.build_hash=developer_listings.safety_hash
  AND s.original_content_enc IS NOT NULL AND s.original_content_iv IS NOT NULL
  AND developer_listings.snapshot_original_content_enc IS NULL AND developer_listings.snapshot_original_content_iv IS NULL;
