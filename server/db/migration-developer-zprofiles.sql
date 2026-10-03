-- Public, owner-selected profile information; never expose account credentials.
ALTER TABLE developer_hubs ADD COLUMN IF NOT EXISTS discord_url TEXT NOT NULL DEFAULT '';
ALTER TABLE developer_hubs ADD COLUMN IF NOT EXISTS website_url TEXT NOT NULL DEFAULT '';
ALTER TABLE developer_hubs ADD COLUMN IF NOT EXISTS avatar_theme TEXT NOT NULL DEFAULT 'orbit';
ALTER TABLE developer_listings ADD COLUMN IF NOT EXISTS mobile_support TEXT NOT NULL DEFAULT 'unknown';
