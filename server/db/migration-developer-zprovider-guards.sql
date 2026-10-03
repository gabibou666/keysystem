ALTER TABLE developer_checkpoints ADD COLUMN IF NOT EXISTS ip_hash TEXT;
-- Pending flows without the new binding must restart. Existing keys survive.
UPDATE developer_checkpoints SET expires_at=now() WHERE ip_hash IS NULL AND tasks_done<tasks_required AND expires_at>now();
-- Independent of checkpoint rows: deleting a session cannot erase replay history.
CREATE TABLE IF NOT EXISTS developer_checkpoint_proof_uses (
  proof_hash TEXT PRIMARY KEY,
  used_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS checkpoint_proof_uses_age ON developer_checkpoint_proof_uses(used_at);
-- Preserve replay protection for already-consumed redirect-provider proofs.
INSERT INTO developer_checkpoint_proof_uses(proof_hash)
SELECT r.receipt_id FROM developer_checkpoint_receipts r JOIN developer_checkpoints c ON c.id=r.checkpoint_id
WHERE c.provider IN ('workink','linkvertise','linkunlocker')
ON CONFLICT DO NOTHING;
