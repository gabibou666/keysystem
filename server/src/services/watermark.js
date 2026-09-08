// Watermarking: chaque exécution du script embarque un identifiant unique.
// -> un dump partagé sur un forum/YouTube révèle SON nonce via les beacons
//    (le script servi appelle /api/v1/report avec le nonce décodé au runtime).
// -> l'admin décode n'importe quel watermark pour identifier qui a leaké.
//
// Encodage: payload JSON {n: nonce, u: userId, t: timestamp} -> AES-GCM -> base64
// Le snippet injecté décode au runtime (clé dérivée inline) et beaconne.

const crypto = require('crypto');

const AES_KEY = Buffer.from(
  (process.env.AES_KEY || '').length === 64 ? process.env.AES_KEY : crypto.randomBytes(32).toString('hex'),
  'hex'
);

// Genere un watermark chiffre pour une exécution donnée
function makeWatermark(nonce, userId) {
  const payload = JSON.stringify({ n: nonce, u: userId, t: Date.now() });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', AES_KEY, iv);
  const enc = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

// Décode un watermark (admin: tracer un leak)
function decodeWatermark(b64) {
  try {
    const raw = Buffer.from(String(b64), 'base64');
    const iv = raw.slice(0, 12);
    const tag = raw.slice(12, 28);
    const data = raw.slice(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', AES_KEY, iv);
    decipher.setAuthTag(tag);
    const json = JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8'));
    return { nonce: json.n, userId: json.u, issuedAt: new Date(json.t) };
  } catch {
    return null;
  }
}

// Snippet Luau injecté en tête de build: beaconne le watermark (chiffre, tel quel)
// au serveur à intervalles réguliers. Le serveur décode et relie l'usage au
// propriétaire — un dump partagé beaconne SOUS LE COMPTE du spectateur -> traçable.
function beaconSnippet(watermarkB64, siteUrl) {
  const wm = JSON.stringify(watermarkB64);
  const site = JSON.stringify(siteUrl);
  return `
-- [ks:wm]
local KS_WM = "${wm}"
local KS_SITE = "${site}"
task.spawn(function()
  local http = request or http_request or (syn and syn.request) or (http and http.request) or (fluxus and fluxus.request)
  if not http then return end
  local Players = game:GetService("Players")
  while true do
    task.wait(240 + math.random(0, 120))
    pcall(function()
      local lp = Players.LocalPlayer
      http({
        Url = KS_SITE .. "/api/v1/report",
        Method = "POST",
        Headers = { ["Content-Type"] = "application/json" },
        Body = game:GetService("HttpService"):JSONEncode({
          wm = KS_WM,
          userId = lp and lp.UserId or nil,
          executor = identifyexecutor and identifyexecutor() or "Unknown",
        }),
      })
    end)
  end
end)
-- [end ks:wm]
`;
}

module.exports = { makeWatermark, decodeWatermark, beaconSnippet };
