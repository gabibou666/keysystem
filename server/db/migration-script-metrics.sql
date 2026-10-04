CREATE TABLE IF NOT EXISTS developer_script_metrics (
  project_id UUID PRIMARY KEY REFERENCES developer_projects(id) ON DELETE CASCADE,
  views BIGINT NOT NULL DEFAULT 0 CHECK (views >= 0),
  executions BIGINT NOT NULL DEFAULT 0 CHECK (executions >= 0)
);
CREATE TABLE IF NOT EXISTS developer_script_metric_receipts (
  project_id UUID NOT NULL REFERENCES developer_projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('views','executions')),
  receipt_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (project_id,kind,receipt_hash)
);
CREATE INDEX IF NOT EXISTS developer_script_metric_receipts_expiry ON developer_script_metric_receipts(expires_at);
