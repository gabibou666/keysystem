-- Migration: paiement Robux (Option A gamepass + Option B webhook)
--
-- Anti-reuse: contrainte UNIQUE sur (roblox_user_id, gamepass_id).
-- Un gamepass_id est un SKU: tous les acheteurs du pass "7 days" partagent le meme id.
-- => le couple (acheteur, pass) est unique: chaque utilisateur consomme SON pass une seule fois.

CREATE TABLE IF NOT EXISTS robux_purchases (
  id              SERIAL PRIMARY KEY,
  roblox_user_id  BIGINT NOT NULL,
  roblox_username TEXT,
  gamepass_id     BIGINT NOT NULL,
  offer_sku       TEXT NOT NULL,            -- 'day1' | 'week1' | 'month1' | 'lifetime'
  key_id          INT REFERENCES keys(id),
  status          TEXT NOT NULL DEFAULT 'detected',  -- detected | delivered | failed
  verified_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at    TIMESTAMPTZ,
  UNIQUE (roblox_user_id, gamepass_id)      -- anti-reuse garanti par la contrainte
);
CREATE INDEX IF NOT EXISTS idx_robux_user ON robux_purchases(roblox_user_id);

-- Option B: receipts Developer Products (idempotence webhook)
CREATE TABLE IF NOT EXISTS robux_receipts (
  id           SERIAL PRIMARY KEY,
  receipt_id   TEXT UNIQUE NOT NULL,        -- idempotence: un receipt = une livraison
  roblox_user_id BIGINT NOT NULL,
  roblox_username TEXT,
  product_id   BIGINT,
  offer_sku    TEXT NOT NULL,
  key_id       INT REFERENCES keys(id),
  key_string   TEXT,                        -- renvoyee telle quelle si replay du receipt
  status       TEXT NOT NULL DEFAULT 'delivered',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Audit: reponses brutes des API Roblox (brief securite)
CREATE TABLE IF NOT EXISTS robux_api_logs (
  id         SERIAL PRIMARY KEY,
  endpoint   TEXT NOT NULL,
  user_id    BIGINT,
  status     INT,
  raw        TEXT,                          -- extrait de la reponse (tronque)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_robux_api_logs_created ON robux_api_logs(created_at);
