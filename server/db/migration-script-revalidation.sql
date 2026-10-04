-- Latest bounded static verification metadata; no source, ciphertext or IP.
CREATE TABLE IF NOT EXISTS developer_script_revalidation (
 project_id UUID NOT NULL REFERENCES developer_projects(id) ON DELETE CASCADE,
 target_kind TEXT NOT NULL CHECK(target_kind IN ('current','free_snapshot')),
 content_version INTEGER NOT NULL,
 content_hash TEXT,
 scanner_version TEXT NOT NULL,
 checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 result TEXT NOT NULL CHECK(result IN ('clear','approved','review','quarantined')),
 findings JSONB NOT NULL DEFAULT '[]',
 PRIMARY KEY(project_id,target_kind)
);
CREATE INDEX IF NOT EXISTS script_revalidation_age ON developer_script_revalidation(checked_at);
