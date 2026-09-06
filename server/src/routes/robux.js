// Routes paiement Robux — Option A (gamepass) + Option B (webhook receipts)
//
// POST /api/robux/verify  { username, offer_sku }
//   a) username -> userId via API officielle
//   b) ownership gamepass via inventory API (service robux.js)
//   c) TRANSACTION: INSERT ... ON CONFLICT DO NOTHING sur (user_id, gamepass_id)
//      -> le meme pass ne livre JAMAIS deux cles
//   d) { success, key } | { pending } | { already_used } | { not_found }
//
// POST /api/robux/webhook  (Option B — appelle par le jeu via HttpService)
//   secret en Authorization, idempotent sur receipt_id (renvoie la meme cle si replay)

const express = require('express');
const rateLimit = require('express-rate-limit');
const crypto = require('../services/crypto');
const robux = require('../services/robux');
const pool = require('../db');

const router = express.Router();

const verifyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5, // brief: 5/min/IP
  standardHeaders: true,
  message: { success: false, status: 'rate_limited', error: 'Too many attempts — wait a minute.' },
});

// ---------- GET /api/robux/offers ----------
// Offres publiques (prix hardcodes, gamepass links si configures)
router.get('/offers', (req, res) => {
  const offers = robux.getOffers().map((o) => ({
    sku: o.sku,
    name: o.name,
    durationHours: o.durationHours,
    priceR$: o.priceR$,
    configured: !!o.gamepassId,
    // Lien direct du gamepass (hub Roblox) — a créer dans Roblox Studio
    buyUrl: o.gamepassId
      ? `https://www.roblox.com/game-pass/${o.gamepassId}/`
      : null,
  }));
  res.json({ success: true, offers });
});

// ---------- POST /api/robux/verify ----------
router.post('/verify', verifyLimiter, async (req, res) => {
  try {
    const username = String(req.body?.username || '').trim();
    const sku = String(req.body?.offer_sku || '').trim();

    const offer = robux.getOfferBySku(sku);
    if (!offer || !offer.gamepassId) {
      return res.status(400).json({ success: false, status: 'invalid_offer', error: 'Invalid offer.' });
    }

    // a) Pseudo -> userId via l'API OFFICIELLE (jamais de regex seule — anti-homoglyphes)
    const user = await robux.resolveUsername(username);
    if (!user.found) {
      if (user.retryable) {
        // 429/5xx Roblox: reponse "pending" — le front continue de poller (UX fluide)
        return res.json({
          success: false,
          status: 'pending',
          error: 'Roblox is busy right now — checking again automatically…',
          retryable: true,
        });
      }
      return res.json({ success: false, status: 'not_found', error: 'Roblox account not found.' });
    }

    // b) Ownership
    const own = await robux.checkGamepassOwnership(user.userId, offer.gamepassId);
    if (!own.owned) {
      // Pas encore possede: peut etre un delai d'indexation — le front continue de poller
      return res.json({
        success: false,
        status: 'pending',
        error: own.retryable
          ? 'Roblox is checking the purchase — try again in a moment.'
          : 'Purchase not detected yet — make sure you bought the right game pass.',
        retryable: true,
      });
    }

    // c) TRANSACTION anti-reuse: le couple (user, pass) ne peut exister qu'une fois.
    //    ON CONFLICT DO NOTHING: si la ligne existe deja => deja consomme.
    const ins = await pool.query(
      `INSERT INTO robux_purchases (roblox_user_id, roblox_username, gamepass_id, offer_sku, status)
       VALUES ($1, $2, $3, $4, 'detected')
       ON CONFLICT (roblox_user_id, gamepass_id) DO NOTHING
       RETURNING id`,
      [user.userId, user.username, offer.gamepassId, offer.sku]
    );

    if (!ins.rows[0]) {
      // Ligne existante => deja consomme: renvoie la meme cle si elle existe, sinon bloque
      const existing = await pool.query(
        `SELECT p.key_id, k.kid, k.signature, k.expires_at
         FROM robux_purchases p JOIN keys k ON k.id = p.key_id
         WHERE p.roblox_user_id = $1 AND p.gamepass_id = $2`,
        [user.userId, offer.gamepassId]
      );
      if (existing.rows[0]) {
        const k = existing.rows[0];
        return res.json({
          success: false,
          status: 'already_used',
          error: 'This game pass has already been used.',
          key: `${k.kid}.${k.signature}`,
          expiresAt: k.expires_at,
        });
      }
      return res.json({
        success: false,
        status: 'already_used',
        error: 'This game pass has already been used.',
      });
    }
    const purchaseId = ins.rows[0].id;

    // d) Livraison: cle liee au roblox_user_id (bound_user_id = l'acheteur,
    //    la cle ne marchera que pour lui dans le loader)
    const gen = crypto.generateKey();
    const keyIns = await pool.query(
      `INSERT INTO keys (kid, signature, bound_user_id, duration_hours, note, source, expires_at)
       VALUES ($1, $2, $3, $4, $5, 'robux', now() + make_interval(hours => $4)) RETURNING id`,
      [gen.kid, gen.signature, user.userId, offer.durationHours, `robux:${offer.sku}`]
    );
    const keyId = keyIns.rows[0].id;

    await pool.query(
      `UPDATE robux_purchases SET key_id = $1, status = 'delivered', delivered_at = now() WHERE id = $2`,
      [keyId, purchaseId]
    );

    const keyRow = await pool.query('SELECT kid, signature, expires_at FROM keys WHERE id = $1', [keyId]);
    const k = keyRow.rows[0];

    res.json({
      success: true,
      status: 'delivered',
      key: `${k.kid}.${k.signature}`,
      expiresAt: k.expires_at,
      robloxUser: user.username,
      offer: offer.sku,
    });
  } catch (e) {
    console.error('[robux/verify]', e);
    res.status(500).json({ success: false, status: 'error', error: 'Server error.' });
  }
});

// ---------- POST /api/robux/webhook (Option B — receipts Developer Products) ----------
// Appelé par le script Luau du jeu (HttpService:PostAsync).
// Securite: secret en Authorization + idempotence sur receipt_id.
const webhookLimiter = rateLimit({ windowMs: 60 * 1000, max: 30 });

router.post('/webhook', webhookLimiter, async (req, res) => {
  try {
    const auth = (req.headers.authorization || '').replace('Bearer ', '');
    if (!process.env.ROBUX_WEBHOOK_SECRET || auth !== process.env.ROBUX_WEBHOOK_SECRET) {
      return res.status(401).json({ success: false, error: 'unauthorized' });
    }

    const { receipt_id, roblox_user_id, username, product_id } = req.body || {};
    if (!receipt_id || !roblox_user_id || !product_id) {
      return res.status(400).json({ success: false, error: 'missing fields' });
    }
    const userId = parseInt(roblox_user_id, 10);
    const offer = robux.getOfferByProductId(product_id);
    if (!offer) {
      return res.status(400).json({ success: false, error: 'unknown product' });
    }

    // Idempotence: receipt deja traite => renvoyer la MEME cle
    const existing = await pool.query('SELECT key_string FROM robux_receipts WHERE receipt_id = $1', [
      String(receipt_id).slice(0, 128),
    ]);
    if (existing.rows[0]) {
      return res.json({ success: true, key: existing.rows[0].key_string, replay: true });
    }

    // Nouveau receipt: livre
    const gen = crypto.generateKey();
    const keyIns = await pool.query(
      `INSERT INTO keys (kid, signature, bound_user_id, duration_hours, note, source, expires_at)
       VALUES ($1, $2, $3, $4, $5, 'robux', now() + make_interval(hours => $4)) RETURNING id, kid, signature, expires_at`,
      [gen.kid, gen.signature, userId, offer.durationHours, `robux:${offer.sku}`]
    );
    const k = keyIns.rows[0];
    const keyString = `${k.kid}.${k.signature}`;

    await pool.query(
      `INSERT INTO robux_receipts (receipt_id, roblox_user_id, roblox_username, product_id, offer_sku, key_id, key_string)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (receipt_id) DO NOTHING`,
      [String(receipt_id).slice(0, 128), userId, String(username || '').slice(0, 32), robux.normalizeProductId(product_id), offer.sku, k.id, keyString]
    );

    res.json({ success: true, key: keyString });
  } catch (e) {
    console.error('[robux/webhook]', e);
    res.status(500).json({ success: false, error: 'server error' });
  }
});

module.exports = router;
