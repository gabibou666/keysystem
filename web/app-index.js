const KEY_STORAGE = 'keysystem_key';
const PUID_STORAGE = 'keysystem_pending_puid';

// ===== Mobile nav toggle =====
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
// Close nav on link click
document.querySelectorAll('#navLinks a').forEach(a => {
  a.addEventListener('click', () => {
    document.getElementById('navLinks').classList.remove('open');
    document.getElementById('navHamburger').classList.remove('open');
  });
});

// ===== Reveal on scroll =====
const io = new IntersectionObserver((entries) => {
  entries.forEach((e) => {
    if (e.isIntersecting) {
      e.target.classList.add('in');
      io.unobserve(e.target);
    }
  });
}, { threshold: 0.12 });
document.querySelectorAll('.reveal').forEach((el) => io.observe(el));

// ===== Animated count-up (part de la valeur affichee, pas de 0: le refresh 30s ne fait pas "rewind") =====
function countUp(el, target, duration = 1200) {
  const start = performance.now();
  const from = parseInt(String(el.textContent).replace(/,/g, ''), 10) || 0;
  function frame(now) {
    const p = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = Math.round(from + (target - from) * eased).toLocaleString('en-US');
    if (p < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

// ===== Resume pending getkey session =====
(function resumePending() {
  const puid = localStorage.getItem(PUID_STORAGE);
  if (!puid) return;
  const stop = () => { clearInterval(iv); localStorage.removeItem(PUID_STORAGE); };
  const handle = (d) => {
    if (d.success && d.status === 'completed' && d.key) {
      stop();
      localStorage.setItem(KEY_STORAGE, d.key);
      loadKeyInfo();
      setStatus('🎉 Your key is ready! Copy it above.', 'ok');
      showToast('🎉 Your key is ready!', 'ok');
    } else if (!d.success && ['already_claimed', 'forbidden', 'token_expired', 'token_invalid', 'rejected', 'revoked_key'].includes(d.status)
               || d.error === 'Unknown session') {
      // Session definitivement morte: arreter de poller (l'onglet getkey a
      // probablement deja delivre la cle) au lieu de boucler a vie.
      stop();
    }
  };
  const iv = setInterval(async () => {
    if (document.visibilityState !== 'visible') return; // onglet cache: pas de gaspillage
    try {
      const r = await fetch('/api/key/status?puid=' + encodeURIComponent(puid));
      handle(await r.json());
    } catch {}
  }, 2000);
  // Poll immediat + au retour sur l'onglet (timers arriere-plan brides par le navigateur)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      const still = localStorage.getItem(PUID_STORAGE);
      if (still) fetch('/api/key/status?puid=' + encodeURIComponent(still)).then(r => r.json()).then(handle).catch(() => {});
    }
  });
})();

function setStatus(text, cls) {
  const s = document.getElementById('status');
  s.textContent = text;
  s.className = 'status ' + (cls || '');
}

async function loadStats() {
  try {
    const r = await fetch('/api/stats/public');
    const d = await r.json();
    countUp(document.getElementById('execCount'), d.executions || 0);
    countUp(document.getElementById('userCount'), d.users || 0);
    countUp(document.getElementById('trustExecs'), d.executions || 0);
    countUp(document.getElementById('trustUsers'), d.users || 0);
  } catch {}
}

// ===== Supported games =====
function fmtVisits(v) {
  if (v == null) return '';
  if (v >= 1e9) return (v / 1e9).toFixed(1) + 'B visits';
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M visits';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K visits';
  return v.toLocaleString('en-US') + ' visits';
}

// ===== Executor Filtering =====
function filterExecutors(platform, btn) {
  document.querySelectorAll('.exec-tab-btn').forEach(b => b.classList.toggle('active', b === btn));
  document.querySelectorAll('.exec-card').forEach(card => {
    const plats = (card.dataset.plat || '').split(' ');
    const show = platform === 'all' || plats.includes(platform);
    card.style.display = show ? 'block' : 'none';
  });
}

// ===== Script Configurator (Standard vs Auto-Key) =====
let currentScriptMode = 'std';
function switchScriptMode(mode) {
  currentScriptMode = mode;
  const btnStd = document.getElementById('btnModeStd');
  const btnAuto = document.getElementById('btnModeAuto');
  if (btnStd) btnStd.classList.toggle('active', mode === 'std');
  if (btnAuto) btnAuto.classList.toggle('active', mode === 'auto');
  updateLoaderSnippet();
}

function updateLoaderSnippet() {
  const codeEl = document.getElementById('loaderCode');
  const btn = document.getElementById('loaderCardBtn');
  if (!codeEl) return;
  if (currentScriptMode === 'std') {
    codeEl.textContent = `loadstring(game:HttpGet("${location.origin}/api/v1/loader"))()`;
    if (btn) btn.innerHTML = '📋 Copy Loader Script';
  } else {
    const box = document.getElementById('keybox');
    const savedKey = (localStorage.getItem(KEY_STORAGE) || (box ? box.value : '') || '').trim();
    const keyStr = savedKey || 'YOUR_KEY_HERE';
    codeEl.textContent = `getgenv().Key = "${keyStr}"\nloadstring(game:HttpGet("${location.origin}/api/v1/loader"))()`;
    if (btn) btn.innerHTML = '⚡ Copy Auto-Key Script';
  }
}

// ===== Supported games & Live Search =====
let allGamesCache = [];
let currentSearchQuery = '';
let currentStatusFilter = 'all';

function onGameSearch(query) {
  currentSearchQuery = (query || '').trim().toLowerCase();
  renderGames();
}

function filterGamesStatus(status, btn) {
  currentStatusFilter = status;
  document.querySelectorAll('.games-filter-tabs .filter-btn').forEach(b => b.classList.toggle('active', b === btn));
  renderGames();
}

function renderGames() {
  const grid = document.getElementById('gamesGrid');
  const badge = document.getElementById('gamesCountBadge');
  if (!grid) return;

  const filtered = allGamesCache.filter(g => {
    const nameMatch = (g.name || '').toLowerCase().includes(currentSearchQuery) || String(g.placeId || '').includes(currentSearchQuery);
    const st = g.status || 'safe';
    const statusMatch = currentStatusFilter === 'all' || st === currentStatusFilter;
    return nameMatch && statusMatch;
  });

  if (badge) badge.textContent = `${filtered.length} / ${allGamesCache.length} game${allGamesCache.length > 1 ? 's' : ''}`;

  if (!filtered.length) {
    grid.innerHTML = '<p class="games-empty" style="grid-column: 1/-1;">No games found matching your criteria.</p>';
    return;
  }

  grid.innerHTML = filtered.map((g, i) => {
    const status = g.status || 'safe';
    let statusLabel = 'Undetected';
    let statusClass = 'safe';
    if (status === 'updating') {
      statusLabel = 'Updating';
      statusClass = 'updating';
    } else if (status === 'detected') {
      statusLabel = 'Detected';
      statusClass = 'detected';
    }
    return `
    <div class="game-card" style="animation-delay: ${i * 0.05}s">
      <div class="g-icon">${g.iconUrl ? `<img src="${g.iconUrl}" alt="${g.name} game icon" loading="lazy">` : '🎮'}</div>
      <div class="g-body">
        <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
          <div class="g-name" title="${g.name.replace(/"/g, '&quot;')}">${g.name.replace(/</g, '&lt;')}</div>
          <span class="g-status ${statusClass}"><span class="status-dot"></span>${statusLabel}</span>
        </div>
        <div class="g-meta">
          ${g.playing != null ? `<span><b>●</b> ${g.playing.toLocaleString('en-US')} playing</span>` : ''}
          ${g.visits ? `<span>${fmtVisits(g.visits)}</span>` : ''}
          <span class="g-ver">v${g.version}</span>
          ${g.statusNote ? `<span style="width:100%;font-size:11.5px;color:var(--muted);">${g.statusNote.replace(/</g, '&lt;')}</span>` : ''}
        </div>
      </div>
    </div>
  `}).join('');
}

async function loadGames() {
  const grid = document.getElementById('gamesGrid');
  try {
    const r = await fetch('/api/games/public');
    const d = await r.json();
    allGamesCache = d.games || [];
    renderGames();
  } catch {
    if (grid) grid.innerHTML = '<p class="games-empty">Failed to load games.</p>';
  }
}

// ===== Live activity =====
async function loadActivity() {
  try {
    const r = await fetch('/api/activity/public');
    const d = await r.json();
    activityCache = d; // alimente le bandeau d'activite (chiffres reels)
    const set = (id, v) => {
      const el = document.getElementById(id);
      if (el) el.textContent = (v || 0).toLocaleString('en-US');
    };
    set('onlineNow', d.onlineNow);
    set('onlineNowStat', d.onlineNow);
    set('heroOnline', d.onlineNow);
    set('usersToday', d.usersToday);
    set('execToday', d.executionsToday);
    set('totalUsers', d.totalUsers);
  } catch {}
}

let countdownTimer = null;
let keyDebounceTimer = null;

function onKeyInput(val) {
  clearTimeout(keyDebounceTimer);
  keyDebounceTimer = setTimeout(() => {
    val = (val || '').trim();
    if (val.length >= 10) {
      localStorage.setItem(KEY_STORAGE, val);
      loadKeyInfo(val);
      updateLoaderSnippet();
    }
  }, 400);
}

async function loadKeyInfo(customKey) {
  const key = customKey || localStorage.getItem(KEY_STORAGE);
  if (!key) return;
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  const box = document.getElementById('keybox');
  if (box && box.value !== key) box.value = key;
  const wrap = document.getElementById('countdownWrap');
  try {
    const r = await fetch('/api/key/info?key=' + encodeURIComponent(key));
    const d = await r.json();
    if (!d.success) {
      if (wrap) wrap.classList.add('hidden');
      setStatus(d.error === 'Revoked' ? 'Key revoked — get a new one.' : 'Unknown key — get a new one.', 'err');
      return;
    }
    if (d.expired) {
      if (wrap) wrap.classList.remove('hidden');
      const el = document.getElementById('countdown');
      if (el) { el.textContent = 'expired'; el.classList.add('urgent'); }
      setStatus('Key expired — renew it on the key page.', 'err');
      return;
    }
    if (d.inDiscord === false) {
      if (wrap) wrap.classList.remove('hidden');
      setStatus('⚠️ Inactive: You left our Discord! Rejoin to use your key.', 'err');
      return;
    }
    if (wrap) wrap.classList.remove('hidden');
    const target = new Date(d.expiresAt).getTime();
    countdownTimer = setInterval(() => tickCountdown(target), 1000);
    tickCountdown(target);
    setStatus('Key valid ✓', 'ok');
    if (window.launchConfetti && !customKey) {
      // Confetti feedback when key is active
      setTimeout(window.launchConfetti, 250);
    }
    updateLoaderSnippet();
  } catch {
    setStatus('Could not verify your key right now.', 'err');
  }
}

function tickCountdown(target) {
  const diff = target - Date.now();
  const el = document.getElementById('countdown');
  if (diff <= 0) {
    el.textContent = 'expired';
    el.classList.add('urgent');
    document.getElementById('countdownWrap').classList.remove('hidden');
    return;
  }
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  const s = Math.floor((diff % 60000) / 1000);
  el.textContent = String(h).padStart(2,'0') + ':' + String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0');
  if (diff < 3600000) el.classList.add('urgent');
}

function flashCopied(btn, baseLabel) {
  if (!btn) return;
  const old = baseLabel || btn.innerHTML;
  btn.classList.add('copied');
  btn.innerHTML = 'Copied ✓';
  setTimeout(() => {
    btn.classList.remove('copied');
    btn.innerHTML = old;
  }, 1400);
}

function copyKey() {
  const v = document.getElementById('keybox').value;
  if (v) {
    navigator.clipboard.writeText(v);
    setStatus('Key copied!', 'ok');
    if (window.showToast) showToast('🔑 Key copied to clipboard!');
    flashCopied(document.querySelector('#keyCard .keybox .btn.small'), 'Copy');
  }
}

function copyLuauScriptFromKey(rawKey) {
  let key = (rawKey || localStorage.getItem(KEY_STORAGE) || '').trim();
  if (!key) {
    if (window.showToast) showToast('⚠️ Enter or obtain a key first!', 'err');
    return;
  }
  const script = `getgenv().Key = "${key}"\nloadstring(game:HttpGet("${location.origin}/api/v1/loader"))()`;
  navigator.clipboard.writeText(script).then(() => {
    setStatus('Full script with key copied!', 'ok');
    if (window.showToast) showToast('⚡ Luau script with key copied! Paste directly into your executor.');
  }).catch(() => {
    prompt('Copy this script into your executor:', script);
  });
}

function copyLoader() {
  navigator.clipboard.writeText(document.getElementById('loaderCode').textContent);
  setStatus(currentScriptMode === 'std' ? 'Loader copied!' : 'Auto-Key script copied!', 'ok');
  if (window.showToast) showToast(currentScriptMode === 'std' ? '📋 Loader copied to clipboard!' : '⚡ Auto-Key script copied!');
  flashCopied(document.getElementById('loaderCardBtn'), currentScriptMode === 'std' ? '📋 Copy Loader Script' : '⚡ Copy Auto-Key Script');
}



function copyHeroLoader() {
  const code = `loadstring(game:HttpGet("${location.origin}/api/v1/loader"))()`;
  navigator.clipboard.writeText(code).then(() => {
    const btn = document.getElementById('heroCopyBtn');
    const txt = document.getElementById('heroCopyText');
    if (txt) txt.textContent = 'Copied ✓';
    if (btn) btn.classList.add('copied');
    if (window.showToast) showToast('📋 Loader copied to clipboard!');
    setTimeout(() => {
      if (txt) txt.textContent = 'Copy';
      if (btn) btn.classList.remove('copied');
    }, 1500);
  });
}

// ============================================================================
// Bandeau d'activite: CHIFFRES REELS uniquement (fin de la fausse preuve
// sociale). Tout vient des API publiques du site; sans donnees, rien n'est
// affiche plutot que d'inventer des evenements.
// ============================================================================
let activityCache = null;
let changelogCache = [];

async function loadChangelog() {
  try {
    const r = await fetch('/api/changelog');
    const d = await r.json();
    changelogCache = (d.versions || []).slice(0, 3);
  } catch {}
}

const fmtNum = (v) => Number(v || 0).toLocaleString('en-US');

function tickerEvents() {
  const ev = [];
  const a = activityCache || {};
  if (a.executionsToday) ev.push({ icon: '⚡', text: `${fmtNum(a.executionsToday)} script executions today`, time: 'live' });
  if (a.onlineNow) ev.push({ icon: '👥', text: `${fmtNum(a.onlineNow)} users online right now`, time: 'now' });
  if (a.usersToday) ev.push({ icon: '🔑', text: `${fmtNum(a.usersToday)} users got access today`, time: 'today' });
  if (a.totalUsers) ev.push({ icon: '📈', text: `${fmtNum(a.totalUsers)} accounts served in total`, time: 'total' });
  const top = (allGamesCache || [])[0];
  if (top && top.playing) ev.push({ icon: '🔥', text: `${top.name} — ${fmtNum(top.playing)} playing now`, time: 'live' });
  const count = (allGamesCache || []).length;
  if (count) ev.push({ icon: '🎮', text: `${count} supported game${count > 1 ? 's' : ''} with a live build`, time: 'updated' });
  const latest = changelogCache[0];
  if (latest) ev.push({ icon: '🆕', text: `v${latest.version} published${latest.gameName ? ' for ' + latest.gameName : ''}`, time: 'changelog' });
  return ev;
}

// Initialise le code du terminal hero avec le bon origin
const heroCodeEl = document.getElementById('heroTerminalCode');
if (heroCodeEl) {
  heroCodeEl.innerHTML = `<span class="code-comment">-- AUDIT HUB Universal Script Loader</span>\n<span class="code-keyword">loadstring</span>(game:<span class="code-fn">HttpGet</span>(<span class="code-str">"${location.origin}/api/v1/loader"</span>))()`;
}

updateLoaderSnippet();
loadStats();
loadKeyInfo();
loadGames();
loadActivity();
loadChangelog();
if (window.startSocialTicker) {
  window.startSocialTicker(document.getElementById('socialTickerBar'), tickerEvents);
}
setInterval(loadStats, 30000);
setInterval(loadActivity, 30000);
