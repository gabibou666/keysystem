-- Migration: clés manuelles (note + source)
ALTER TABLE keys ADD COLUMN IF NOT EXISTS note TEXT;
ALTER TABLE keys ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'ad';
