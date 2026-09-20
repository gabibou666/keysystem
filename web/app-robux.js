const KEY_STORAGE = 'keysystem_key';

// ===== Mobile nav =====
function toggleNav() {
  const links = document.getElementById('navLinks');
  const btn = document.getElementById('navHamburger');
  if (!links || !btn) return;
  const open = links.classList.toggle('open');
  btn.classList.toggle('open', open);
  // Etat expose aux technologies d'assistance (sinon le bouton reste muet)
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  btn.setAttribute('aria-label', open ? 'Close navigation menu' : 'Open navigation menu');
}
document.querySelectorAll('#navLinks a').forEach(a => {
  a.addEventListener('click', () => {
    document.getElementById('navLinks').classList.remove('open');
    document.getElementById('navHamburger').classList.remove('open');
  });
});

// ===== Progress bar =====
function setStep(n) {
  for (let i = 1; i <= 3; i++) {
    const dot = document.getElementById('pd' + i);
    dot.classList.toggle('active', i === n);
    dot.classList.toggle('done', i < n);
    dot.textContent = i < n ? '✓' : i;
  }
  for (let i = 1; i <= 2; i++) {
    document.getElementById('pl' + i).classList.toggle('active', i < n);
  }
}

// ===== Offers =====
let selectedSku = null;

async function loadOffers() {
  try {
    const r = await fetch('/api/robux/offers');
    const d = await r.json();
    const grid = document.getElementById('offersGrid');
    if (!d.offers || !d.offers.length) {
      grid.innerHTML = '<p class="games-empty">No offers available.</p>';
      return;
    }
    grid.innerHTML = d.offers.map(o => `
      <div class="offer-enhanced" data-sku="${o.sku}" onclick="selectOfferCard(this.dataset.sku)">
        ${!o.configured ? '' : '<div class="offer-tag">Available</div>'}
        <div class="offer-price">${o.priceR$} R$</div>
        <div class="offer-name">${o.name}</div>
        <div class="offer-duration">${o.durationHours >= 24 ? Math.round(o.durationHours/24) + ' days' : o.durationHours + 'h'}</div>
        ${o.configured
          ? `<a class="btn small" style="margin-top: 14px;" data-sku="${o.sku}" href="${o.buyUrl}" target="_blank" rel="noopener" onclick="event.stopPropagation(); preselect(this.dataset.sku)">🛒 Buy on Roblox</a>`
          : `<p style="color: var(--muted); font-size: 12px; margin-top: 10px;">Coming soon</p>`}
      </div>
    `).join('');

    const btnsWrap = document.getElementById('offerButtons');
    btnsWrap.innerHTML = '';
    d.offers.filter(o => o.configured).forEach(o => {
      const b = document.createElement('button');
      b.className = 'btn small secondary offer-btn';
      b.dataset.sku = o.sku;
      b.textContent = `${o.name} — ${o.priceR$} R$`;
      b.onclick = () => selectOfferBtn(o.sku);
      btnsWrap.appendChild(b);
    });
    if (!d.offers.some(o => o.configured)) {
      btnsWrap.innerHTML = '<p class="sub">No offers configured yet.</p>';
    }
  } catch {
    document.getElementById('offersGrid').innerHTML = '<p class="games-empty">Failed to load offers.</p>';
  }
}

function selectOfferCard(sku) {
  document.querySelectorAll('.offer-enhanced').forEach(c => c.classList.toggle('selected', c.dataset.sku === sku));
  selectOfferBtn(sku);
}

function selectOfferBtn(sku) {
  selectedSku = sku;
  document.querySelectorAll('.offer-btn').forEach(b => b.classList.toggle('copied', b.dataset.sku === sku));
  document.getElementById('verifyStatus').textContent = '';
  setStep(2);
}

function preselect(sku) {
  selectOfferCard(sku);
  document.getElementById('verifyCard').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ===== Verify + polling =====
let pollTimer = null;
let pollEnd = 0;

async function verifyOnce(username, sku) {
  const r = await fetch('/api/robux/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, offer_sku: sku, key: localStorage.getItem(KEY_STORAGE) || undefined }),
  });
  return r.json();
}

async function startVerify() {
  const username = document.getElementById('username').value.trim();
  const sku = selectedSku;
  const status = document.getElementById('verifyStatus');
  const btn = document.getElementById('verifyBtn');

  if (!username || !sku) {
    status.textContent = !username
      ? '⚠️ Enter your Roblox username.'
      : '⚠️ Pick your offer (buttons above).';
    status.className = 'status err';
    return;
  }

  btn.disabled = true;
  btn.classList.add('disabled');
  status.textContent = '⏳ Checking your purchase on Roblox…';
  status.className = 'status';

  try {
    const d = await verifyOnce(username, sku);

    if (d.success && d.key) {
      deliverKey(d);
      return;
    }
    if (d.status === 'already_used') {
      if (d.key) {
        deliverKey(d, true);
      } else {
        status.textContent = '⛔ This game pass has already been used by another session.';
        status.className = 'status err';
      }
      return;
    }
    if (d.status === 'not_found') {
      status.textContent = '❌ Roblox account not found — check the username.';
      status.className = 'status err';
      return;
    }
    if (d.status === 'blocked') {
      status.textContent = '⛔ This account cannot use Robux payments.';
      status.className = 'status err';
      return;
    }
    if (d.status === 'pending') {
      status.textContent = '⏳ Purchase not detected yet — Roblox can take 1-2 minutes. Checking automatically…';
      status.className = 'status';
      pollEnd = Date.now() + 2 * 60 * 1000;
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = setInterval(async () => {
        if (Date.now() > pollEnd) {
          clearInterval(pollTimer);
          pollTimer = null;
          status.textContent = '⚠️ Still not detected after 2 minutes — verify you bought the right pass, then try again.';
          status.className = 'status err';
          return;
        }
        try {
          const p = await verifyOnce(username, sku);
          if (p.success && p.key) {
            clearInterval(pollTimer);
            pollTimer = null;
            deliverKey(p);
          } else if (p.status === 'already_used' && p.key) {
            clearInterval(pollTimer);
            pollTimer = null;
            deliverKey(p, true);
          }
        } catch {}
      }, 10000);
      return;
    }
    if (d.status === 'rate_limited') {
      status.textContent = '⛔ Too many attempts — wait a minute.';
      status.className = 'status err';
      return;
    }
    status.textContent = '❌ ' + (d.error || 'Unexpected error.');
    status.className = 'status err';
  } catch {
    status.textContent = 'Network error — try again.';
    status.className = 'status err';
  } finally {
    btn.disabled = false;
    btn.classList.remove('disabled');
  }
}

function deliverKey(d, wasUsed) {
  document.getElementById('verifyCard').classList.add('hidden');
  setStep(3);
  const card = document.getElementById('resultCard');
  card.classList.remove('hidden');
  document.getElementById('resultTitle').textContent = wasUsed
    ? '✅ Your key (already delivered)'
    : d.extended
      ? '⏰ Time added to your key!'
      : '🎉 Key delivered!';
  document.getElementById('resultSub').textContent =
    (d.extended ? 'Your existing key was extended' : 'Bound to') +
    (d.robloxUser ? ' — ' + d.robloxUser : ' your Roblox account') +
    '. Paste it into the loader.';
  const el = document.getElementById('newKey');
  el.textContent = d.key;
  localStorage.setItem(KEY_STORAGE, d.key);
  document.getElementById('modalKey').textContent = d.key;
  document.getElementById('modalTitle').textContent = d.extended ? '⏰ Time added!' : '💎 Key delivered!';
  if (d.expiresAt) {
    document.getElementById('modalExpires').textContent = 'Valid until ' + new Date(d.expiresAt).toLocaleString('en-US');
  }
  if (window.launchConfetti) window.launchConfetti();
  document.getElementById('keyModal').classList.add('open');
}

function copyKey() {
  const v = document.getElementById('newKey').textContent;
  if (v) navigator.clipboard.writeText(v);
  if (window.showToast) showToast('🔑 Key copied!');
}
function copyModalKey() {
  const v = document.getElementById('modalKey').textContent;
  if (v) navigator.clipboard.writeText(v);
  if (window.showToast) showToast('🔑 Key copied!');
}
function copyLuauScriptFromKey(rawKey) {
  let key = rawKey || localStorage.getItem(KEY_STORAGE);
  if (!key) return;
  key = key.trim();
  const script = `getgenv().Key = "${key}"\nloadstring(game:HttpGet("${location.origin}/api/v1/loader"))()`;
  navigator.clipboard.writeText(script).then(() => {
    if (window.showToast) showToast('⚡ Luau script with key copied! Paste directly into your executor.');
  }).catch(() => {
    prompt('Copy this script into your executor:', script);
  });
}
function closeModal() { document.getElementById('keyModal').classList.remove('open'); }
document.getElementById('keyModal').addEventListener('click', e => { if (e.target.id === 'keyModal') closeModal(); });

loadOffers();
