const API = '/api/admin';

async function api(path, opts = {}) {
  const r = await fetch(API + path, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...opts,
  });
  if (r.status === 401) { showLogin(); throw new Error('unauthorized'); }
  return r.json();
}

function showLogin() {
  document.getElementById('login').classList.remove('hidden');
  document.getElementById('main').classList.add('hidden');
  document.getElementById('logoutBtn').classList.add('hidden');
}
function showMain() {
  document.getElementById('login').classList.add('hidden');
  document.getElementById('main').classList.remove('hidden');
  document.getElementById('logoutBtn').classList.remove('hidden');
}

async function logout() {
  await fetch(API + '/auth/logout', { method: 'POST', credentials: 'same-origin' });
  showLogin();
}

function showTab(name) {
  document.querySelectorAll('.admin-main > section').forEach(s => s.classList.add('hidden'));
  document.getElementById('tab-' + name).classList.remove('hidden');
  document.querySelectorAll('.admin-nav .tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  if (name === 'dashboard') loadDashboard();
  if (name === 'revenue') loadRevenue();
  if (name === 'keys') loadKeys();
  if (name === 'users') loadUsers();
  if (name === 'bans') { loadBans(); loadAntiDdos(); }
  if (name === 'script') { loadVersions(); loadGameStatuses(); }
  if (name === 'patches') loadPatches();
  if (name === 'bot') loadBot();
}

// Echappement HTML COMPLET.
// L'ancienne version ne remplacait que "<": un pseudo Discord contenant une
// apostrophe (ex: x');fetch('/api/admin/...')//) sortait de l'attribut
// onclick="resetUserAdLimit('...', '...')" et s'executait DANS LA SESSION ADMIN
// (XSS stocke: il suffisait que l'admin ouvre l'onglet Users).
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function closeModal(id) { document.getElementById(id).classList.remove('open'); }
function openModal(id) { document.getElementById(id).classList.add('open'); }

// Close modals on backdrop click
document.querySelectorAll('.modal-overlay').forEach(el => {
  el.addEventListener('click', e => { if (e.target === el) closeModal(el.id); });
});

function fmtNum(n) { return n.toLocaleString('en-US'); }

function barRow(label, value, max, cls = 'violet') {
  const pct = max > 0 ? (value / max * 100).toFixed(1) : 0;
  return `<div class="chart-row">
    <span class="label">${esc(label)}</span>
    <div class="bar"><div class="bar-fill ${cls}" style="width:${pct}%"></div></div>
    <span class="value">${fmtNum(value)}</span>
  </div>`;
}

// ==================== DASHBOARD ====================
let dashLoaded = false;
async function loadDashboard() {
  try {
    const d = await api('/stats');
    document.getElementById('dashStats').innerHTML = `
      <div class="admin-stat fade-up">
        <div class="stat-icon">⚡</div>
        <div class="num">${fmtNum(d.executions)}</div>
        <div class="lbl">Total executions</div>
      </div>
      <div class="admin-stat fade-up fade-up-d1">
        <div class="stat-icon">👥</div>
        <div class="num">${fmtNum(d.uniqueUsers)}</div>
        <div class="lbl">Unique users</div>
      </div>
      <div class="admin-stat fade-up fade-up-d2">
        <div class="stat-icon">🔑</div>
        <div class="num">${fmtNum(d.keysPerDay?.reduce((a, x) => a + x.c, 0) || 0)}</div>
        <div class="lbl">Keys created (30d)</div>
        <div class="sub-stat"><span class="ss"><b>${d.manualKeysTotal}</b> manual</span></div>
      </div>
      <div class="admin-stat fade-up fade-up-d3">
        <div class="stat-icon">⚠️</div>
        <div class="num">${d.errors7d}</div>
        <div class="lbl">Errors (7d)</div>
      </div>`;

    const max = Math.max(1, ...d.perDay.map(x => x.c));
    document.getElementById('perday').innerHTML = d.perDay.length
      ? d.perDay.map(x => barRow(x.d, x.c, max, 'violet')).join('')
      : '<div class="empty-state"><div class="icon">📊</div>No data yet</div>';

    const kmax = Math.max(1, ...(d.keysPerDay || []).map(x => x.c));
    document.getElementById('keysperday').innerHTML = (d.keysPerDay || []).length
      ? d.keysPerDay.map(x => barRow(x.d, x.c, kmax, 'pink')).join('')
      : '<div class="empty-state"><div class="icon">🔑</div>No keys created yet</div>';

    document.getElementById('byexec').innerHTML = d.byExecutor.length
      ? d.byExecutor.map(x => barRow(x.executor || 'unknown', x.c, d.byExecutor[0].c, 'violet')).join('')
      : '<div class="empty-state"><div class="icon">🧩</div>No executions yet</div>';

    dashLoaded = true;
  } catch {}
}

// ==================== REVENUE ====================
async function loadRevenue() {
  try {
    const d = await api('/robux-stats');
    const t = d.totals;

    document.getElementById('revStats').innerHTML = `
      <div class="admin-stat revenue fade-up">
        <div class="stat-icon">💰</div>
        <div class="num">${fmtNum(t.revenueR$)} R$</div>
        <div class="lbl">Total revenue</div>
        <div class="sub-stat"><span class="ss"><b>${fmtNum(t.purchases)}</b> total sales</span></div>
      </div>
      <div class="admin-stat fade-up fade-up-d1">
        <div class="stat-icon">📦</div>
        <div class="num">${fmtNum(t.purchases)}</div>
        <div class="lbl">Total purchases</div>
      </div>
      <div class="admin-stat fade-up fade-up-d2">
        <div class="stat-icon">📈</div>
        <div class="num">${d.perDay.length ? d.perDay.slice(-7).reduce((a, x) => a + x.revenue, 0) : 0} R$</div>
        <div class="lbl">Last 7 days</div>
      </div>`;

    // Revenue per day chart
    const maxRev = Math.max(1, ...d.perDay.map(x => x.revenue));
    document.getElementById('revPerDay').innerHTML = d.perDay.length
      ? d.perDay.map(x => barRow(x.d, x.revenue + ' R$', maxRev, 'gold')).join('')
      : '<div class="empty-state"><div class="icon">💰</div>No revenue data yet</div>';

    // Offer breakdown cards
    document.getElementById('offerBreakdown').innerHTML = d.perOffer.length
      ? d.perOffer.map(o => {
          const nameMap = { day1: '1 Day', week1: '7 Days', month1: '30 Days', lifetime: 'Lifetime' };
          return `<div class="offer-card">
            <div class="offer-name">${nameMap[o.sku] || o.sku}</div>
            <div class="offer-rev">${fmtNum(o.revenue)} R$</div>
            <div class="offer-count">${o.count} sale${o.count !== 1 ? 's' : ''}</div>
            <div class="offer-price">${o.priceR$} R$ each</div>
          </div>`;
        }).join('')
      : '<div class="empty-state"><div class="icon">📦</div>No offers sold yet</div>';

    // Recent sales table
    const tbody = document.querySelector('#salesTable tbody');
    tbody.innerHTML = d.recentSales.length
      ? d.recentSales.map(s => `<tr>
          <td><b>${esc(s.username || '–')}</b><br><span class="mono" style="font-size:11px;color:var(--admin-muted-2)">${s.userId}</span></td>
          <td><span class="badge violet">${s.offer}</span></td>
          <td><b style="color:#fbbf24">${s.priceR$} R$</b></td>
          <td><span class="badge ${s.method === 'webhook' ? 'ok' : 'muted'}">${s.method}</span></td>
          <td><span class="badge ${s.status === 'delivered' ? 'ok' : 'err'}">${s.status}</span></td>
          <td class="mono">${new Date(s.date).toLocaleString('en-US')}</td>
        </tr>`).join('')
      : '<tr><td colspan="6" style="text-align:center;color:var(--admin-muted-2)">No sales yet</td></tr>';
  } catch {}
}

// ==================== KEYS ====================
async function loadKeys() {
  try {
    const d = await api('/keys');
    document.querySelector('#keysTable tbody').innerHTML = d.keys.map(k => {
      const expired = new Date(k.expires_at) < new Date();
      const st = k.revoked ? '<span class="badge err">revoked</span>'
        : expired ? '<span class="badge muted">expired</span>'
        : '<span class="badge ok">valid</span>';
      const src = k.source === 'manual'
        ? '<span class="badge violet">manual</span>'
        : '<span class="badge muted">ad</span>';
      return `<tr>
        <td class="mono" style="cursor:pointer;color:var(--admin-glow)" onclick="showKeyDetail(${k.id})"><b>${k.kid.slice(0,12)}…</b></td>
        <td>${k.bound_user_id ?? '–'}</td>
        <td class="mono">${new Date(k.expires_at).toLocaleString('en-US')}</td>
        <td>${src}</td>
        <td style="font-size:12px">${esc(k.note) || '–'}</td>
        <td>${k.execs}</td>
        <td>${st}</td>
        <td>${k.revoked
          ? `<button class="admin-btn small ghost" onclick="unrevokeKey(${k.id})">Restore</button>`
          : `<button class="admin-btn small red" onclick="revokeKey(${k.id})">Revoke</button>`}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="8" style="text-align:center;color:var(--admin-muted-2)">No keys</td></tr>';
  } catch {}
}
async function revokeKey(id) { await api(`/keys/${id}/revoke`, { method: 'POST' }); loadKeys(); }
async function unrevokeKey(id) { await api(`/keys/${id}/unrevoke`, { method: 'POST' }); loadKeys(); }

async function createKeys() {
  const msg = document.getElementById('createMsg');
  const durationHours = parseInt(document.getElementById('ckDuration').value, 10);
  const count = parseInt(document.getElementById('ckCount').value, 10) || 1;
  const boundRaw = document.getElementById('ckBound').value.trim();
  const note = document.getElementById('ckNote').value.trim();
  const boundUserId = boundRaw ? parseInt(boundRaw, 10) : null;

  if (!Number.isFinite(durationHours) || durationHours < 1) { msg.textContent = '❌ Invalid duration (min 1 hour)'; msg.className = 'msg err'; return; }
  if (boundUserId !== null && !Number.isFinite(boundUserId)) { msg.textContent = '❌ Invalid UserId'; msg.className = 'msg err'; return; }

  msg.textContent = '⏳ Generating…'; msg.className = 'msg';
  try {
    const d = await api('/keys/create', { method: 'POST', body: JSON.stringify({ durationHours, count, boundUserId, note }) });
    if (!d.success) { msg.textContent = '❌ ' + d.error; msg.className = 'msg err'; return; }
    msg.textContent = '';
    document.getElementById('createdCount').textContent = d.count;
    document.getElementById('createdDuration').textContent = d.durationHours + 'h';
    document.getElementById('createdKeys').value = d.created.map(c => c.key).join('\n');
    openModal('createdModal');
    loadKeys();
  } catch (e) {
    msg.textContent = '❌ Network error'; msg.className = 'msg err';
  }
}

function copyCreatedKeys() {
  const v = document.getElementById('createdKeys').value;
  if (v) navigator.clipboard.writeText(v);
}

async function showKeyDetail(id) {
  try {
    const d = await api(`/keys/${id}/detail`);
    if (!d.success) return;
    const k = d.key;
    const expired = new Date(k.expiresAt) < new Date();
    const execRows = (d.executions || []).map(e => `
      <tr>
        <td class="mono">${new Date(e.at).toLocaleString('en-US')}</td>
        <td>${esc(e.executor) || '–'}</td>
        <td class="mono">v${e.version}</td>
        <td class="mono">${esc(e.ip) || '–'}</td>
      </tr>`).join('') || '<tr><td colspan="4" style="color:var(--admin-muted-2)">No executions</td></tr>';

    document.getElementById('detailBody').innerHTML = `
      <textarea readonly rows="2" style="width:100%;font-family:Consolas,monospace;font-size:12px;background:#13101c;border:1px solid #231c33;border-radius:8px;color:#d8b4fe;padding:10px;user-select:all;">${k.keyString}</textarea>
      <button class="admin-btn small" style="margin-top:8px;" data-key="${esc(k.keyString)}" onclick="navigator.clipboard.writeText(this.dataset.key)">📋 Copy key</button>
      <table style="margin-top:16px;width:100%">
        <tr><td style="color:var(--admin-muted-2);padding:6px 0">Status</td><td>${k.revoked ? '<span class="badge err">revoked</span>' : expired ? '<span class="badge muted">expired</span>' : '<span class="badge ok">valid</span>'}</td></tr>
        <tr><td style="color:var(--admin-muted-2);padding:6px 0">Source</td><td>${k.source === 'manual' ? 'manual (no ads)' : 'ad (LootLabs)'}</td></tr>
        <tr><td style="color:var(--admin-muted-2);padding:6px 0">Bound to</td><td>${k.boundUserId ?? 'not bound yet'}</td></tr>
        <tr><td style="color:var(--admin-muted-2);padding:6px 0">Created</td><td>${new Date(k.createdAt).toLocaleString('en-US')}</td></tr>
        <tr><td style="color:var(--admin-muted-2);padding:6px 0">Expires</td><td>${new Date(k.expiresAt).toLocaleString('en-US')} (${k.durationHours}h)</td></tr>
        <tr><td style="color:var(--admin-muted-2);padding:6px 0">Renewals</td><td>${k.renewedCount}</td></tr>
        <tr><td style="color:var(--admin-muted-2);padding:6px 0">Note</td><td>${esc(k.note) || '–'}</td></tr>
        <tr><td style="color:var(--admin-muted-2);padding:6px 0">Executions</td><td>${k.totalExecs}</td></tr>
      </table>
      <h4 style="margin:18px 0 8px">Execution history</h4>
      <div style="overflow-x:auto">
        <table class="admin-table"><thead><tr><th>Date</th><th>Executor</th><th>Version</th><th>IP</th></tr></thead><tbody>${execRows}</tbody></table>
      </div>`;
    openModal('detailModal');
  } catch {}
}

// ==================== USERS & AD LIMIT ====================
let userSearchTimer = null;
function debounceUserSearch() {
  clearTimeout(userSearchTimer);
  userSearchTimer = setTimeout(loadUsers, 300);
}

async function loadUsers() {
  const q = document.getElementById('userSearchInput')?.value.trim() || '';
  const tbody = document.getElementById('usersTableBody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:30px; color:var(--admin-muted);">Loading users...</td></tr>';

  try {
    const data = await api('/users' + (q ? '?q=' + encodeURIComponent(q) : ''));
    if (!data.success) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; color:var(--admin-err);">${esc(data.error || 'Error')}</td></tr>`;
      return;
    }

    const users = data.users || [];
    let blockedCount = 0;
    let activeKeysCount = 0;

    users.forEach(u => {
      if ((u.ads_last_12h || 0) >= 2) blockedCount++;
      if (u.active_key_kid) activeKeysCount++;
    });

    const statTotal = document.getElementById('statTotalDiscordUsers');
    const statBlocked = document.getElementById('statBlockedUsers');
    const statActive = document.getElementById('statActiveKeyUsers');
    if (statTotal) statTotal.textContent = users.length;
    if (statBlocked) statBlocked.textContent = blockedCount;
    if (statActive) statActive.textContent = activeKeysCount;

    if (users.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:30px; color:var(--admin-muted);">No users found.</td></tr>';
      return;
    }

    tbody.innerHTML = users.map(u => {
      const avatarUrl = u.avatar 
        ? (u.avatar.startsWith('a_') 
            ? `https://cdn.discordapp.com/avatars/${u.discord_id}/${u.avatar}.gif?size=64`
            : `https://cdn.discordapp.com/avatars/${u.discord_id}/${u.avatar}.png?size=64`)
        : 'https://cdn.discordapp.com/embed/avatars/0.png';

      const ads = u.ads_last_12h || 0;
      let adsBadge = '';
      if (ads >= 2) {
        adsBadge = `<span class="badge red" style="background:#be185d26; color:#f472b6; border:1px solid #be185d55;">${ads} / 2 (Limit 🔴)</span>`;
      } else if (ads === 1) {
        adsBadge = `<span class="badge yellow" style="background:#eab30826; color:#facc15; border:1px solid #eab30855;">1 / 2 (In progress)</span>`;
      } else {
        adsBadge = `<span class="badge green" style="background:#10b98126; color:#34d399; border:1px solid #10b98155;">0 / 2 (Available)</span>`;
      }

      const activeKey = u.active_key_kid 
        ? `<span style="color:#c084fc; font-family:monospace; font-size:12px;">🔑 ${esc(u.active_key_kid.slice(0, 10))}...</span>`
        : `<span style="color:var(--admin-muted); font-size:12px;">None</span>`;

      return `<tr>
        <td>
          <div style="display:flex; align-items:center; gap:10px;">
            <img src="${avatarUrl}" alt="User Avatar" style="width:32px; height:32px; border-radius:50%; object-fit:cover; border:1px solid var(--admin-border);" onerror="this.src='https://cdn.discordapp.com/embed/avatars/0.png'" />
            <b>${esc(u.username || 'Unknown')}</b>
          </div>
        </td>
        <td><code style="font-size:12px; color:var(--admin-muted);">${esc(u.discord_id)}</code></td>
        <td>${adsBadge}</td>
        <td><b>${u.total_sessions || 0}</b></td>
        <td><span style="font-size:12px; font-family:monospace; color:var(--admin-muted);">${esc(u.last_ip || '-')}</span></td>
        <td>${activeKey}</td>
        <td>
          <button class="admin-btn small ${ads >= 2 ? 'green' : 'ghost'}" data-user-name="${esc(u.username || '')}" onclick="resetUserAdLimit('${esc(u.discord_id)}', this.dataset.userName)">
            🔄 Reset limit (0/2)
          </button>
        </td>
      </tr>`;
    }).join('');
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; color:var(--admin-err);">Loading error: ${esc(e.message)}</td></tr>`;
  }
}

async function resetUserAdLimit(discordId, username) {
  if (!confirm(`Reset the 2-ad limit for ${username || discordId}?\nThis user will be able to start key sessions again immediately.`)) {
    return;
  }
  try {
    const data = await api(`/users/${encodeURIComponent(discordId)}/reset-limit`, { method: 'POST' });
    if (data.success) {
      alert(`✅ ${data.message}`);
      loadUsers();
    } else {
      alert(`❌ Error: ${data.error || 'Reset failed'}`);
    }
  } catch (e) {
    alert(`❌ Error: ${e.message}`);
  }
}

// ==================== BANS ====================
async function loadBans() {
  try {
    const d = await api('/bans');
    document.querySelector('#bansTable tbody').innerHTML = d.bans.map(b =>
      `<tr><td class="mono">${b.user_id}</td><td>${esc(b.reason) || '–'}</td><td class="mono">${new Date(b.created_at).toLocaleString('en-US')}</td>
       <td><button class="admin-btn small green" onclick="unban(${b.user_id})">Unban</button></td></tr>`
    ).join('') || '<tr><td colspan="4" style="text-align:center;color:var(--admin-muted-2)">No bans</td></tr>';
  } catch {}
}
async function banUser() {
  const userId = parseInt(document.getElementById('banUserId').value);
  if (!Number.isFinite(userId)) return;
  await api('/bans', { method: 'POST', body: JSON.stringify({ userId, reason: document.getElementById('banReason').value }) });
  document.getElementById('banUserId').value = '';
  document.getElementById('banReason').value = '';
  loadBans();
}
async function unban(userId) { await api(`/bans/${userId}`, { method: 'DELETE' }); loadBans(); }

// ==================== ANTI-DDOS ====================
async function loadAntiDdos() {
  const tbody = document.getElementById('ddosTableBody');
  if (!tbody) return;
  try {
    const d = await api('/antiddos');
    if (!d.success || !d.stats) return;
    const s = d.stats;
    const statBlocked = document.getElementById('statDdosBlocked');
    const statJailed = document.getElementById('statDdosJailed');
    const statTracked = document.getElementById('statDdosTracked');
    if (statBlocked) statBlocked.textContent = s.totalBlockedAttacks || 0;
    if (statJailed) statJailed.textContent = s.currentJailedCount || 0;
    if (statTracked) statTracked.textContent = s.currentlyTrackedIPs || 0;

    const list = s.jailedList || [];
    if (!list.length) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:20px; color:var(--admin-muted-2);">No IP banned right now. The network is healthy.</td></tr>';
      return;
    }

    tbody.innerHTML = list.map(item => {
      const min = Math.floor(item.remainingSec / 60);
      const sec = item.remainingSec % 60;
      const timeLeft = `${min}m ${sec < 10 ? '0' : ''}${sec}s`;

      return `<tr>
        <td class="mono"><b>${esc(item.ip)}</b></td>
        <td><span class="badge err">⏳ ${timeLeft}</span></td>
        <td><b>${item.peakCount} reqs / 10s</b></td>
        <td><span class="mono" style="font-size:12px; color:var(--admin-glow);">${esc(item.targetPath)}</span></td>
        <td>
          <button class="admin-btn small green" data-ip="${esc(item.ip)}" onclick="unbanDdosIp(this.dataset.ip)">
            🔓 Unban IP
          </button>
        </td>
      </tr>`;
    }).join('');
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--admin-err);">Error: ${esc(e.message)}</td></tr>`;
  }
}

async function unbanDdosIp(ip) {
  if (!confirm(`Unban the IP address ${ip} immediately?`)) return;
  try {
    const res = await api('/antiddos/unban', {
      method: 'POST',
      body: JSON.stringify({ ip })
    });
    if (res.success) {
      loadAntiDdos();
    } else {
      alert(`❌ Error: ${res.error || 'Failed'}`);
    }
  } catch (e) {
    alert(`❌ Error: ${e.message}`);
  }
}

// ==================== GAME SCRIPT STATUSES ====================
async function loadGameStatuses() {
  const tbody = document.getElementById('gamesStatusBody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:24px; color:var(--admin-muted-2);">Loading games...</td></tr>';
  try {
    const d = await api('/script/games');
    if (!d.success || !d.games || !d.games.length) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:24px; color:var(--admin-muted-2);">No game configured yet. You can add one above.</td></tr>';
      return;
    }
    tbody.innerHTML = d.games.map(g => {
      const st = g.status || 'safe';
      let badgeHtml = '<span class="badge ok">🟢 Safe / Undetected</span>';
      if (st === 'updating') badgeHtml = '<span class="badge" style="background:#f59e0b1f;color:#fbbf24;border:1px solid #f59e0b44;">🟡 Updating</span>';
      if (st === 'detected') badgeHtml = '<span class="badge err">🔴 Detected / Down</span>';

      return `<tr>
        <td>
          <div style="display:flex; align-items:center; gap:10px;">
            ${g.iconUrl ? `<img src="${g.iconUrl}" alt="${esc(g.name)} server icon" style="width:28px;height:28px;border-radius:6px;object-fit:cover;">` : '🎮'}
            <b>${esc(g.name)}</b>
          </div>
        </td>
        <td class="mono">${g.placeId}</td>
        <td>${g.version ? `<b>v${g.version}</b>` : '<span style="color:var(--admin-muted-2);">–</span>'}</td>
        <td id="curr-status-${g.placeId}">${badgeHtml}</td>
        <td>
          <select id="sel-status-${g.placeId}" class="admin-input" style="padding:4px 8px; font-size:12.5px;">
            <option value="safe" ${st === 'safe' ? 'selected' : ''}>🟢 Safe / Undetected</option>
            <option value="updating" ${st === 'updating' ? 'selected' : ''}>🟡 Updating</option>
            <option value="detected" ${st === 'detected' ? 'selected' : ''}>🔴 Detected</option>
          </select>
        </td>
        <td>
          <input id="note-status-${g.placeId}" class="admin-input" value="${esc(g.statusNote || '')}" placeholder="Note (ex: Update v2)" style="width:160px; padding:4px 8px; font-size:12px;">
        </td>
        <td>
          <button class="admin-btn small green" onclick="saveGameStatus(${g.placeId})">💾 Save</button>
        </td>
      </tr>`;
    }).join('');
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; color:var(--admin-err);">Error: ${esc(e.message)}</td></tr>`;
  }
}

async function saveGameStatus(placeId) {
  const sel = document.getElementById('sel-status-' + placeId);
  const noteInput = document.getElementById('note-status-' + placeId);
  if (!sel) return;
  const status = sel.value;
  const note = noteInput ? noteInput.value.trim() : '';

  try {
    const res = await api('/script/game-status', {
      method: 'POST',
      body: JSON.stringify({ placeId, status, note })
    });
    if (res.success) {
      loadGameStatuses();
    } else {
      alert(`❌ Error: ${res.error || 'Failed'}`);
    }
  } catch (e) {
    alert(`❌ Error: ${e.message}`);
  }
}

async function addNewGameStatus() {
  const pInput = document.getElementById('newStatusPlaceId');
  const sel = document.getElementById('newStatusSelect');
  const noteInput = document.getElementById('newStatusNote');
  const placeId = parseInt(pInput?.value, 10);
  if (!Number.isFinite(placeId) || placeId <= 0) {
    alert('Please enter a valid Roblox PlaceId.');
    return;
  }
  const status = sel ? sel.value : 'safe';
  const note = noteInput ? noteInput.value.trim() : '';

  try {
    const res = await api('/script/game-status', {
      method: 'POST',
      body: JSON.stringify({ placeId, status, note })
    });
    if (res.success) {
      if (pInput) pInput.value = '';
      if (noteInput) noteInput.value = '';
      loadGameStatuses();
    } else {
      alert(`❌ Error: ${res.error || 'Failed'}`);
    }
  } catch (e) {
    alert(`❌ Error: ${e.message}`);
  }
}

// ==================== SCRIPT ====================
async function loadVersions() {
  try {
    const d = await api('/script/versions');
    document.querySelector('#versionsTable tbody').innerHTML = d.versions.map(v =>
      `<tr>
        <td><b>v${v.version}</b></td>
        <td>${v.place_id ? '<span class="mono" style="color:var(--admin-glow)">🎮 ' + v.place_id + '</span><br>' : ''}<span style="font-size:12px;color:var(--admin-muted-2)">${esc(v.note)}</span></td>
        <td class="mono">${new Date(v.created_at).toLocaleString('en-US')}</td>
        <td>${v.builds}</td>
        <td>${v.published ? '<span class="badge ok">published</span>' : '<span class="badge muted">draft</span>'}</td>
        <td style="white-space:nowrap">
          <button class="admin-btn small ghost" onclick="loadOriginal(${v.version})">Edit</button>
          <button class="admin-btn small green" onclick="publishVersion(${v.version})">Publish</button>
        </td>
      </tr>`
    ).join('') || '<tr><td colspan="6" style="text-align:center;color:var(--admin-muted-2)">No versions</td></tr>';
  } catch {}
}
async function loadOriginal(version) {
  const d = await api(`/script/original/${version}`);
  if (d.success) {
    document.getElementById('scriptSource').value = d.source;
    const vData = await api('/script/versions');
    const ver = (vData.versions || []).find(x => x.version === version);
    document.getElementById('scriptPlaceId').value = ver && ver.place_id ? ver.place_id : '';
    document.getElementById('scriptMsg').textContent = `Version v${version} loaded — edit and save to create v${version + 1}.`;
    document.getElementById('scriptMsg').className = 'msg ok';
  } else {
    document.getElementById('scriptMsg').textContent = d.error;
    document.getElementById('scriptMsg').className = 'msg err';
  }
}
async function saveScript() {
  const source = document.getElementById('scriptSource').value;
  const note = document.getElementById('scriptNote').value;
  const placeIdRaw = document.getElementById('scriptPlaceId').value.trim();
  const placeId = placeIdRaw ? parseInt(placeIdRaw) : null;
  const msg = document.getElementById('scriptMsg');
  if (placeId !== null && !Number.isFinite(placeId)) {
    msg.textContent = '❌ Invalid PlaceId'; msg.className = 'msg err'; return;
  }
  msg.textContent = '⏳ Pipeline running…'; msg.className = 'msg';
  try {
    const d = await api('/script/save', { method: 'POST', body: JSON.stringify({ source, note, placeId }) });
    if (d.success) {
      msg.innerHTML = `✅ Draft v${d.version} — ${d.buildType === 'ai' ? d.patches + ' AI patch(es)' : 'shims only'}.`;
      msg.className = 'msg ok';
      document.getElementById('scriptNote').value = '';
      loadVersions();
    } else {
      msg.textContent = '❌ ' + d.error; msg.className = 'msg err';
    }
  } catch (e) {
    msg.textContent = '❌ Network error'; msg.className = 'msg err';
  }
}
async function publishVersion(version) {
  const d = await api('/script/publish', { method: 'POST', body: JSON.stringify({ version }) });
  if (d.success) {
    document.getElementById('scriptMsg').textContent = `✅ v${version} published!`;
    document.getElementById('scriptMsg').className = 'msg ok';
  } else {
    document.getElementById('scriptMsg').textContent = '❌ ' + d.error;
    document.getElementById('scriptMsg').className = 'msg err';
  }
  loadVersions();
}

// ============ FABRIQUE DE PROMPT + ENREGISTREMENT DU CODE COLLE ============
// Ce panneau n'appelle AUCUN modele: la construction du prompt est locale
// (route /generate-script), et c'est l'admin qui porte le texte a l'IA de son
// choix. Le code colle en retour est valide par luaparse cote serveur
// (/script-from-text) et n'est enregistre en brouillon que s'il compile.
// La page n'utilise AUCUN attribut onclick (CSP stricte + risque d'injection):
// les ecouteurs sont attaches ici. app-admin.js est charge en defer, le DOM est
// donc deja pret.
function afficherMsg(el, texte, nature) {
  el.textContent = texte;
  el.className = nature ? 'msg ' + nature : 'msg';
}

// Copie dans le presse-papiers: navigator.clipboard d'abord (il exige un
// contexte securise), puis repli sur la selection du textarea + execCommand
// quand l'API est absente ou refusee (http local, permission refusee).
async function copierTexte(texte, textarea) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(texte);
      return true;
    }
  } catch (_) {
    // on tente le repli ci-dessous
  }
  try {
    textarea.focus();
    textarea.select();
    const ok = document.execCommand && document.execCommand('copy');
    if (textarea.setSelectionRange) textarea.setSelectionRange(0, 0);
    return !!ok;
  } catch (_) {
    return false;
  }
}

let _copieTimer = null;

async function construirePrompt() {
  const brief = document.getElementById('genBrief').value.trim();
  const placeIdBrut = document.getElementById('genPlaceId').value.trim();
  const bouton = document.getElementById('genButton');
  const msg = document.getElementById('genMsg');
  const confirmation = document.getElementById('genCopied');
  const sortie = document.getElementById('genPrompt');
  const rangeeCopie = document.getElementById('genCopyRow');

  // Nouvel essai: on efface le resultat precedent pour ne jamais melanger deux
  // prompts a l'ecran.
  sortie.value = '';
  sortie.classList.add('hidden');
  rangeeCopie.classList.add('hidden');
  confirmation.classList.add('hidden');

  if (brief.length < 10) {
    afficherMsg(msg, 'Describe the script in at least 10 characters.', 'err');
    return;
  }
  if (placeIdBrut && !/^[0-9]+$/.test(placeIdBrut)) {
    afficherMsg(msg, "The game ID must be numeric (or left empty).", 'err');
    return;
  }

  afficherMsg(msg, 'Building the prompt...', '');
  bouton.disabled = true;

  try {
    const d = await api('/generate-script', {
      method: 'POST',
      body: JSON.stringify({
        brief,
        placeId: placeIdBrut ? parseInt(placeIdBrut, 10) : null,
      }),
    });

    if (d.ok && typeof d.prompt === 'string') {
      sortie.value = d.prompt;
      sortie.classList.remove('hidden');
      rangeeCopie.classList.remove('hidden');
      afficherMsg(
        msg,
        `Prompt ready (${d.tailleOctets} bytes). Copy it and give it to the AI of your choice: this site contacts no model.`,
        'ok'
      );
    } else {
      afficherMsg(msg, d.error || 'Could not build the prompt.', 'err');
    }
  } catch (e) {
    afficherMsg(msg, 'Network error while building the prompt: ' + e.message, 'err');
  } finally {
    bouton.disabled = false;
  }
}

async function copierPrompt() {
  const sortie = document.getElementById('genPrompt');
  const confirmation = document.getElementById('genCopied');
  if (!sortie.value) return;

  const ok = await copierTexte(sortie.value, sortie);
  confirmation.className = ok ? 'gen-copied' : 'gen-copied err';
  confirmation.textContent = ok
    ? 'Prompt copied to the clipboard.'
    : 'Copy failed: select the text then press Ctrl+C.';
  clearTimeout(_copieTimer);
  _copieTimer = setTimeout(() => confirmation.classList.add('hidden'), 3000);
}

async function enregistrerCodeColle() {
  const code = document.getElementById('genCode').value;
  const brief = document.getElementById('genBrief').value.trim();
  const placeIdBrut = document.getElementById('genPlaceId').value.trim();
  const bouton = document.getElementById('genSaveButton');
  const msg = document.getElementById('genSaveMsg');
  const rapport = document.getElementById('genSaveReport');
  const erreurEl = document.getElementById('genSaveError');

  rapport.classList.add('hidden');
  erreurEl.classList.add('hidden');

  if (!code.trim()) {
    afficherMsg(msg, 'Paste the AI response before validating.', 'err');
    return;
  }
  if (placeIdBrut && !/^[0-9]+$/.test(placeIdBrut)) {
    afficherMsg(msg, "The game ID must be numeric (or left empty).", 'err');
    return;
  }

  afficherMsg(msg, 'Validating the syntax, then saving as draft...', '');
  bouton.disabled = true;

  try {
    const d = await api('/script-from-text', {
      method: 'POST',
      body: JSON.stringify({
        code,
        brief,
        placeId: placeIdBrut ? parseInt(placeIdBrut, 10) : null,
      }),
    });

    if (d.ok) {
      afficherMsg(
        msg,
        `Valid code: draft v${d.version} saved (NOT published)${d.nettoye ? ', markdown fences stripped' : ''}.`,
        'ok'
      );
      rapport.textContent = `Validation: ${d.tailleOctets} bytes. Content: ${d.resume}`;
      rapport.classList.remove('hidden');
      loadVersions();
    } else {
      // Aucun enregistrement: le message du parseur est affiche TEL QUEL
      // (textContent: jamais interprete comme HTML).
      afficherMsg(msg, 'Code rejected: nothing was written to the database.', 'err');
      erreurEl.textContent = d.error || 'Unknown error';
      erreurEl.classList.remove('hidden');
    }
  } catch (e) {
    afficherMsg(msg, 'Network error during validation: ' + e.message, 'err');
  } finally {
    bouton.disabled = false;
  }
}

// Attache une seule fois, quand le panneau est present dans la page.
(() => {
  const boutonPrompt = document.getElementById('genButton');
  const boutonCopie = document.getElementById('genCopy');
  const boutonEnregistrer = document.getElementById('genSaveButton');
  if (boutonPrompt) boutonPrompt.addEventListener('click', construirePrompt);
  if (boutonCopie) boutonCopie.addEventListener('click', copierPrompt);
  if (boutonEnregistrer) boutonEnregistrer.addEventListener('click', enregistrerCodeColle);
})();

// ==================== PATCHES ====================
async function loadPatches() {
  try {
    const d = await api('/patches/pending');
    const el = document.getElementById('patchesList');
    if (!d.patches || !d.patches.length) {
      el.innerHTML = '<div class="empty-state"><div class="icon">✨</div>No pending patches</div>';
      return;
    }
    el.innerHTML = d.patches.map(p =>
      `<div style="background:#17141f;border:1px solid var(--admin-border-accent);border-radius:12px;padding:18px;margin-bottom:12px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <span><b style="color:var(--admin-glow)">v${p.version}</b> — <span style="color:var(--admin-muted-2)">${esc(p.reason)}</span></span>
        </div>
        <div style="background:#0d0b12;border:1px solid var(--admin-border);border-radius:8px;padding:12px;font-family:Consolas,monospace;font-size:12px;margin-bottom:12px;">
          <div style="color:var(--admin-muted-2);margin-bottom:6px;font-family:sans-serif;font-size:11px;text-transform:uppercase;letter-spacing:0.05em">FIND:</div>
          <div style="color:var(--admin-err);margin-bottom:12px;white-space:pre-wrap">${esc(p.find)}</div>
          <div style="color:var(--admin-muted-2);margin-bottom:6px;font-family:sans-serif;font-size:11px;text-transform:uppercase;letter-spacing:0.05em">REPLACE:</div>
          <div style="color:var(--admin-ok);white-space:pre-wrap">${esc(p.replace)}</div>
        </div>
        <div style="display:flex;gap:8px">
          <button class="admin-btn small green" onclick="approvePatch(${p.id})">✅ Approve</button>
          <button class="admin-btn small red" onclick="rejectPatch(${p.id})">❌ Reject</button>
        </div>
      </div>`
    ).join('');
  } catch {}
}
async function approvePatch(id) { await api(`/patches/${id}/approve`, { method: 'POST' }); loadPatches(); }
async function rejectPatch(id) { await api(`/patches/${id}/reject`, { method: 'POST' }); loadPatches(); }


// ==================== DISCORD BOT MANAGEMENT ====================
let _botGuilds = [];

async function loadBot() {
  const alertEl = document.getElementById('botOfflineAlert');
  const statStatus = document.getElementById('botStatStatus');
  const statUptime = document.getElementById('botStatUptime');
  const statLatency = document.getElementById('botStatLatency');
  const statGuilds = document.getElementById('botStatGuilds');
  const statMembers = document.getElementById('botStatMembers');
  const guildSelect = document.getElementById('botGuildSelect');

  try {
    const res = await api('/bot/status');
    if (res.apiUrl && document.getElementById('botApiUrlText')) {
      document.getElementById('botApiUrlText').textContent = res.apiUrl;
    }
    if (!res.success || res.offline) {
      if (alertEl) alertEl.classList.remove('hidden');
      if (statStatus) { statStatus.textContent = 'Hors ligne'; statStatus.style.color = 'var(--admin-err)'; }
      if (statLatency) statLatency.textContent = '-';
      if (statGuilds) statGuilds.textContent = '0';
      if (statMembers) statMembers.textContent = '0';
      if (statUptime) statUptime.textContent = '-';
      return;
    }

    if (alertEl) alertEl.classList.add('hidden');
    const data = res.data;
    if (statStatus) { statStatus.textContent = 'Online 🟢'; statStatus.style.color = 'var(--admin-ok)'; }
    if (statLatency) statLatency.textContent = `${data.ws_latency_ms} ms`;
    if (statGuilds) statGuilds.textContent = `${data.guilds ? data.guilds.length : 0}`;

    const totalMembers = data.guilds ? data.guilds.reduce((sum, g) => sum + (g.member_count || 0), 0) : 0;
    if (statMembers) statMembers.textContent = `${totalMembers}`;

    const upSec = data.uptime_seconds || 0;
    const hours = Math.floor(upSec / 3600);
    const mins = Math.floor((upSec % 3600) / 60);
    if (statUptime) statUptime.textContent = `${hours}h ${mins}m`;

    _botGuilds = data.guilds || [];
    if (guildSelect) {
      guildSelect.innerHTML = _botGuilds.map(g => `<option value="${g.id}">${esc(g.name)} (${g.member_count} members)</option>`).join('');
      if (_botGuilds.length > 0) {
        onBotGuildChange();
      }
    }
  } catch (e) {
    console.error('[loadBot error]', e);
    if (alertEl) alertEl.classList.remove('hidden');
    if (statStatus) { statStatus.textContent = 'Error'; statStatus.style.color = 'var(--admin-err)'; }
  }
}

async function onBotGuildChange() {
  const guildSelect = document.getElementById('botGuildSelect');
  if (!guildSelect) return;
  const guildId = guildSelect.value;
  const guild = _botGuilds.find(g => g.id === guildId);
  if (!guild) return;

  const textChannels = guild.channels || [];
  const categories = guild.categories || [];
  const roles = guild.roles || [];

  const fillSelect = (id, items, defaultText = '-- None --') => {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = `<option value="">${defaultText}</option>` +
      items.map(it => `<option value="${it.id}"># ${esc(it.name)}</option>`).join('');
  };

  const fillRoleSelect = (id, items, defaultText = '-- None --') => {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = `<option value="">${defaultText}</option>` +
      items.map(it => `<option value="${it.id}">@ ${esc(it.name)}</option>`).join('');
  };

  const fillCatSelect = (id, items, defaultText = '-- None --') => {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = `<option value="">${defaultText}</option>` +
      items.map(it => `<option value="${it.id}">📁 ${esc(it.name)}</option>`).join('');
  };

  fillSelect('botVerifChannel', textChannels);
  fillRoleSelect('botVerifRole', roles);
  fillRoleSelect('botUnverifRole', roles);

  fillSelect('botTicketChannel', textChannels);
  fillCatSelect('botTicketCategory', categories);
  fillSelect('botTicketLogChannel', textChannels);
  fillRoleSelect('botSupportRole', roles);

  fillSelect('botWelcomeChannel', textChannels);
  fillSelect('botModLogChannel', textChannels);
  fillSelect('botAnnounceChannel', textChannels);

  // Fetch saved settings from bot
  try {
    const res = await api(`/bot/guilds/${guildId}/settings`);
    if (res.success && res.settings) {
      const s = res.settings;
      if (s.verification_channel_id) document.getElementById('botVerifChannel').value = s.verification_channel_id;
      if (s.verified_role_id) document.getElementById('botVerifRole').value = s.verified_role_id;
      if (s.unverified_role_id) document.getElementById('botUnverifRole').value = s.unverified_role_id;
      if (s.verification_type) document.getElementById('botVerifType').value = s.verification_type;

      if (s.ticket_channel_id) document.getElementById('botTicketChannel').value = s.ticket_channel_id;
      if (s.ticket_category_id) document.getElementById('botTicketCategory').value = s.ticket_category_id;
      if (s.ticket_log_channel_id) document.getElementById('botTicketLogChannel').value = s.ticket_log_channel_id;
      if (s.support_role_id) document.getElementById('botSupportRole').value = s.support_role_id;

      if (s.welcome_channel_id) document.getElementById('botWelcomeChannel').value = s.welcome_channel_id;
      if (s.welcome_message) document.getElementById('botWelcomeMsg').value = s.welcome_message;

      if (s.mod_log_channel_id) document.getElementById('botModLogChannel').value = s.mod_log_channel_id;

      document.getElementById('botAutomodEnabled').checked = s.automod_enabled === undefined || Number(s.automod_enabled) === 1;
      document.getElementById('botAntiSpam').checked = s.anti_spam_enabled === undefined || Number(s.anti_spam_enabled) === 1;
      document.getElementById('botAntiInvite').checked = s.anti_invite_enabled === undefined || Number(s.anti_invite_enabled) === 1;
      document.getElementById('botAiAutomod').checked = s.ai_automod_enabled === undefined || Number(s.ai_automod_enabled) === 1;
    }
  } catch (e) {
    console.error('[onBotGuildChange error]', e);
  }
}

async function saveBotSettings() {
  const guildId = document.getElementById('botGuildSelect').value;
  const statusEl = document.getElementById('botSaveStatus');
  if (!guildId) return;

  statusEl.textContent = '⏳ Saving...';
  statusEl.style.color = 'var(--admin-muted)';

  const payload = {
    verification_channel_id: document.getElementById('botVerifChannel').value || null,
    verified_role_id: document.getElementById('botVerifRole').value || null,
    unverified_role_id: document.getElementById('botUnverifRole').value || null,
    verification_type: document.getElementById('botVerifType').value,

    ticket_channel_id: document.getElementById('botTicketChannel').value || null,
    ticket_category_id: document.getElementById('botTicketCategory').value || null,
    ticket_log_channel_id: document.getElementById('botTicketLogChannel').value || null,
    support_role_id: document.getElementById('botSupportRole').value || null,

    welcome_channel_id: document.getElementById('botWelcomeChannel').value || null,
    welcome_message: document.getElementById('botWelcomeMsg').value,

    mod_log_channel_id: document.getElementById('botModLogChannel').value || null,

    automod_enabled: document.getElementById('botAutomodEnabled').checked ? 1 : 0,
    anti_spam_enabled: document.getElementById('botAntiSpam').checked ? 1 : 0,
    anti_invite_enabled: document.getElementById('botAntiInvite').checked ? 1 : 0,
    ai_automod_enabled: document.getElementById('botAiAutomod').checked ? 1 : 0,
  };

  try {
    const res = await api(`/bot/guilds/${guildId}/settings`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    if (res.success) {
      statusEl.textContent = '✅ Configuration saved to the bot successfully!';
      statusEl.style.color = 'var(--admin-ok)';
      setTimeout(() => { statusEl.textContent = ''; }, 4000);
    } else {
      statusEl.textContent = '❌ Error: ' + (res.error || 'Could not save');
      statusEl.style.color = 'var(--admin-err)';
    }
  } catch (e) {
    statusEl.textContent = '❌ Network error while saving';
    statusEl.style.color = 'var(--admin-err)';
  }
}

async function deployBotPanel(panelType) {
  const guildId = document.getElementById('botGuildSelect').value;
  if (!guildId) return;

  let channelId = null;
  if (panelType === 'verification') {
    channelId = document.getElementById('botVerifChannel').value;
  } else if (panelType === 'tickets') {
    channelId = document.getElementById('botTicketChannel').value;
  }

  if (!channelId) {
    alert('Please select a channel for this panel before deploying it.');
    return;
  }

  if (!confirm(`Deploy the "${panelType}" panel to the selected channel?`)) {
    return;
  }

  try {
    const res = await api(`/bot/guilds/${guildId}/deploy-panel`, {
      method: 'POST',
      body: JSON.stringify({ panel_type: panelType, channel_id: channelId }),
    });
    if (res.success) {
      alert(`✅ "${panelType}" panel sent to Discord successfully!`);
    } else {
      alert(`❌ Error: ${res.error || 'Deployment failed'}`);
    }
  } catch (e) {
    alert(`❌ Network error: ${e.message}`);
  }
}

async function sendBotAnnouncement() {
  const guildId = document.getElementById('botGuildSelect').value;
  const channelId = document.getElementById('botAnnounceChannel').value;
  const title = document.getElementById('botAnnounceTitle').value.strip ? document.getElementById('botAnnounceTitle').value.strip() : document.getElementById('botAnnounceTitle').value.trim();
  const desc = document.getElementById('botAnnounceDesc').value.trim();
  const color = document.getElementById('botAnnounceColor').value;
  const statusEl = document.getElementById('botAnnounceStatus');

  if (!channelId) {
    alert('Please select a destination channel for the announcement.');
    return;
  }
  if (!desc) {
    alert('Please enter the text of your announcement.');
    return;
  }

  statusEl.textContent = '⏳ Sending...';
  statusEl.style.color = 'var(--admin-muted)';

  try {
    const res = await api(`/bot/guilds/${guildId}/send-message`, {
      method: 'POST',
      body: JSON.stringify({
        channel_id: channelId,
        title: title,
        description: desc,
        color: color,
      }),
    });
    if (res.success) {
      statusEl.textContent = '✅ Announcement sent to Discord successfully!';
      statusEl.style.color = 'var(--admin-ok)';
      document.getElementById('botAnnounceTitle').value = '';
      document.getElementById('botAnnounceDesc').value = '';
      setTimeout(() => { statusEl.textContent = ''; }, 4000);
    } else {
      statusEl.textContent = '❌ Error: ' + (res.error || 'Send failed');
      statusEl.style.color = 'var(--admin-err)';
    }
  } catch (e) {
    statusEl.textContent = '❌ Network error while sending';
    statusEl.style.color = 'var(--admin-err)';
  }
}

// ==================== INIT ====================
(async function init() {
  try {
    const me = await fetch(API + '/me', { credentials: 'same-origin' }).then(r => r.json());
    if (me.loggedIn) { showMain(); showTab('dashboard'); }
    else showLogin();
  } catch { showLogin(); }
})();
