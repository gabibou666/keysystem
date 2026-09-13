-- Migration HWID: liaison de la clé au premier appareil + journalisation par exécution
ALTER TABLE keys ADD COLUMN IF NOT EXISTS bound_hwid TEXT;
ALTER TABLE executions ADD COLUMN IF NOT EXISTS hwid TEXT;
CREATE INDEX IF NOT EXISTS idx_keys_bound_hwid ON keys(bound_hwid);
