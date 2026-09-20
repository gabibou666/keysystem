const KEY_STORAGE = 'keysystem_key';
const PUID_STORAGE = 'keysystem_pending_puid';
let pollTimer = null;
let discordOk = false;
let currentStep = 1;

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
  currentStep = n;
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

// ===== Discord gate =====
async function loadDiscordStatus() {
  try {
    const r = await fetch('/api/discord/status');
    const d = await r.json();
    if (d.loggedIn) {
      discordOk = true;
      document.getElementById('discordLoggedOut').classList.add('hidden');
      document.getElementById('discordLoggedIn').classList.remove('hidden');
      document.getElementById('userName').textContent = d.username || 'Discord user';
      const av = document.getElementById('userAvatar');
      if (d.avatar) { av.src = d.avatar; av.classList.remove('hidden'); }
      window.discordInServer = d.inServer;
      window.discordInviteUrl = d.inviteUrl || window.ksInviteUrl();
      if (d.inServer) {
        document.getElementById('serverNote').textContent = '✅ Member of our Discord server';
      } else {
        document.getElementById('serverNote').innerHTML = '⚠️ Not in server —' + (window.ksInviteLink('Rejoin Discord') || ' ask a staff member for an invite link.');
      }
      setStep(2);
    } else {
      discordOk = false;
      setStep(1);
    }
  } catch {}
}

async function discordLogout() {
  await fetch('/api/discord/logout', { method: 'POST' });
  location.reload();
}

(function loginBanner() {
  const q = new URLSearchParams(location.search);
  const ref = q.get('ref');
  if (ref && /^\d{17,20}$/.test(ref)) {
    localStorage.setItem('keysystem_ref', ref);
  }
  const login = q.get('login');
  if (login) {
    history.replaceState({}, '', '/getkey');
    const el = document.getElementById('loginError');
    if (login === 'ok') {
      el.textContent = '✅ Signed in with Discord!';
      el.className = 'status ok';
    } else if (login === 'denied') {
      el.textContent = 'You cancelled the Discord sign-in — you must join to get a key.';
      el.className = 'status err';
    } else if (login === 'invalid') {
      el.textContent = 'Sign-in expired — try again.';
      el.className = 'status err';
    } else {
      el.textContent = 'Discord sign-in failed — try again.';
      el.className = 'status err';
    }
    return;
  }
  // Message d'erreur renvoye par la page de verification anti-adblock
  const err = q.get('err');
  if (err) {
    history.replaceState({}, '', '/getkey');
    const el = document.getElementById('loginError');
    el.textContent = '❌ ' + err;
    el.className = 'status err';
  }
})();

// ===== HWID Management =====
async function loadHwidStatus() {
  try {
    const r = await fetch('/api/key/hwid-status');
    const d = await r.json();
    const btn = document.getElementById('btnResetHwid');
    const st = document.getElementById('hwidStatusText');
    if (!btn || !st) return;
    if (!d.loggedIn || !d.hasKey) {
      btn.style.display = 'none';
      st.textContent = '';
      return;
    }
    btn.style.display = 'inline-flex';
    if (!d.isBound) {
      st.textContent = 'Device not locked yet — will bind on in-game launch.';
      st.style.color = '#34d399';
      btn.disabled = true;
    } else if (d.canReset) {
      st.textContent = 'Device bound. 1 reset available.';
      st.style.color = '#c084fc';
      btn.disabled = false;
    } else {
      const h = Math.floor(d.remainingMs / 3600000);
      const m = Math.ceil((d.remainingMs % 3600000) / 60000);
      st.textContent = `Cooldown active — next reset in ${h}h ${m}m`;
      st.style.color = 'var(--color-muted)';
      btn.disabled = true;
    }
  } catch {}
}

async function resetHwid() {
  const btn = document.getElementById('btnResetHwid');
  const st = document.getElementById('hwidStatusText');
  if (btn) btn.disabled = true;
  if (st) { st.textContent = 'Resetting device link...'; st.style.color = '#c084fc'; }
  try {
    const r = await fetch('/api/key/reset-hwid', { method: 'POST' });
    const d = await r.json();
    if (d.success) {
      showToast('✅ HWID reset! Launch script on your new device.');
      loadHwidStatus();
    } else {
      if (st) { st.textContent = d.error || 'Failed to reset HWID'; st.style.color = 'var(--red)'; }
      if (btn) btn.disabled = false;
    }
  } catch {
    if (st) st.textContent = 'Network error.';
    if (btn) btn.disabled = false;
  }
}

// ===== Referral System =====
async function loadReferralStats() {
  try {
    const r = await fetch('/api/referrals/stats');
    const d = await r.json();
    const out = document.getElementById('refLoggedOut');
    const logged = document.getElementById('refLoggedIn');
    if (!out || !logged) return;
    if (!d.loggedIn) {
      out.classList.remove('hidden');
      logged.classList.add('hidden');
      return;
    }
    out.classList.add('hidden');
    logged.classList.remove('hidden');

    const origin = location.origin;
    const refLink = `${origin}/getkey?ref=${d.discordId}`;
    document.getElementById('refLinkInput').value = refLink;

    document.getElementById('refTotalCount').textContent = d.totalReferred || 0;
    document.getElementById('refCompletedCount').textContent = d.completedReferred || 0;
    document.getElementById('refRewardsAvailable').textContent = d.availableRewards || 0;

    const prog = document.getElementById('refProgressText');
    const needed = 2 - (d.progressToNext || 0);
    prog.textContent = d.availableRewards > 0 
      ? `🎉 You have ${d.availableRewards} VIP key(s) ready to claim!`
      : `${d.progressToNext || 0} / 2 friends completed. ${needed} more needed for a VIP key.`;

    const claimBtn = document.getElementById('btnClaimRef');
    if (claimBtn) claimBtn.disabled = (d.availableRewards || 0) <= 0;
  } catch {}
}

function copyRefLink() {
  const input = document.getElementById('refLinkInput');
  if (input && input.value) {
    navigator.clipboard.writeText(input.value);
    showToast('🔗 Referral link copied to clipboard!');
  }
}

async function claimReferralReward() {
  const btn = document.getElementById('btnClaimRef');
  const st = document.getElementById('refClaimStatus');
  if (btn) btn.disabled = true;
  if (st) { st.textContent = 'Claiming your 24h VIP Key...'; st.className = 'status'; }
  try {
    const r = await fetch('/api/referrals/claim', { method: 'POST' });
    const d = await r.json();
    if (d.success && d.key) {
      localStorage.setItem(KEY_STORAGE, d.key);
      if (window.launchConfetti) window.launchConfetti();
      showModal(d.key, false, d.expiresAt);
      loadCurrentKey();
      loadReferralStats();
      if (st) { st.textContent = '🎉 24h VIP Key claimed and saved!'; st.className = 'status ok'; }
      showToast('🎉 VIP Key successfully claimed!');
    } else {
      if (st) { st.textContent = d.error || 'Could not claim VIP key.'; st.className = 'status err'; }
      if (btn) btn.disabled = false;
    }
  } catch {
    if (st) { st.textContent = 'Network error.'; st.className = 'status err'; }
    if (btn) btn.disabled = false;
  }
}

// ===== Current key card =====
async function loadCurrentKey() {
  const key = localStorage.getItem(KEY_STORAGE);
  if (!key) return;
  document.getElementById('currentKeyCard').classList.remove('hidden');
  document.getElementById('currentKey').value = key;
  try {
    const r = await fetch('/api/key/info?key=' + encodeURIComponent(key));
    const d = await r.json();
    const st = document.getElementById('currentKeyStatus');
    if (!d.success) {
      st.textContent = d.error === 'Revoked' ? 'Key revoked — get a new one below.' : 'Unknown key — get a new one below.';
      st.className = 'status err';
    } else if (d.expired) {
      st.textContent = 'Key expired — renew it below (same key).';
      st.className = 'status err';
    } else if (d.inDiscord === false) {
      st.innerHTML = '⚠️ Inactive: you left our Discord!' + (d.discordInvite ? ' <a href="' + d.discordInvite + '" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:underline;font-weight:bold;">Rejoin to reactivate</a>' : window.ksInviteLink('Rejoin to reactivate'));
      st.className = 'status err';
    } else {
      const left = new Date(d.expiresAt) - Date.now();
      const h = Math.floor(left / 3600000);
      const m = Math.floor((left % 3600000) / 60000);
      st.textContent = '✅ Valid — ' + h + 'h ' + m + 'm remaining';
      st.className = 'status ok';
    }
    loadHwidStatus();
  } catch {
    document.getElementById('currentKeyStatus').textContent = 'Could not verify your key right now.';
  }
}

function copyCurrentKey() {
  const v = document.getElementById('currentKey').value;
  if (v) { navigator.clipboard.writeText(v); showToast('🔑 Key copied to clipboard!'); }
}

function copyLuauScriptFromKey(rawKey) {
  let key = rawKey || localStorage.getItem(KEY_STORAGE);
  if (!key) return;
  key = key.trim();
  const script = `getgenv().Key = "${key}"\nloadstring(game:HttpGet("${location.origin}/api/v1/loader"))()`;
  navigator.clipboard.writeText(script).then(() => {
    showToast('⚡ Luau script with key copied! Paste directly into your executor.');
  }).catch(() => {
    prompt('Copy this script into your executor:', script);
  });
}

// ===== Modal =====
function showModal(key, renewed, expiresAt) {
  document.getElementById('modalTitle').textContent = renewed ? '✅ Key renewed!' : '🔓 Key obtained!';
  document.getElementById('modalKey').textContent = key;
  if (expiresAt) {
    document.getElementById('modalExpires').textContent = 'Valid until ' + new Date(expiresAt).toLocaleString('en-US');
  }
  document.getElementById('keyModal').classList.add('open');
}
function closeModal() { document.getElementById('keyModal').classList.remove('open'); }
function copyModalKey() {
  const v = document.getElementById('modalKey').textContent;
  if (v) { navigator.clipboard.writeText(v); showToast('🔑 Key copied to clipboard!'); }
}
document.getElementById('keyModal').addEventListener('click', (e) => {
  if (e.target.id === 'keyModal') closeModal();
});

// ===== Getkey flow =====
async function start(duration) {
  if (!discordOk) {
    const status = document.getElementById('startStatus');
    status.textContent = '🔒 Sign in with Discord first (Step 1 above).';
    status.className = 'status err';
    return;
  }
  if (window.discordInServer === false) {
    const status = document.getElementById('startStatus');
    status.innerHTML = '⚠️ You must join our Discord server to get a key!' + (window.discordInviteUrl ? ' <a href="' + window.discordInviteUrl + '" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:underline;font-weight:bold;">Join Discord Server</a>' : window.ksInviteLink('Join Discord Server'));
    status.className = 'status err';
    return;
  }
  // ANTI-ADBLOCK: passe par la page de verification.
  // Elle detecte l'adblock (message blocant) et sinon demarre la session
  // LootLabs instantanement, puis ramene l'utilisateur ici pour le resultat.
  if (duration !== 12 && duration !== 24) return; // anti-URL forgee
  const existing = localStorage.getItem(KEY_STORAGE);
  const renewing = existing ? '1' : '0';
  location.href = '/verify?d=' + duration + '&k=' + renewing;
}

function cancelPendingSession() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  localStorage.removeItem(PUID_STORAGE);
  localStorage.removeItem(PUID_STORAGE + '_time');
  document.getElementById('result').classList.add('hidden');
  const retryWrap = document.getElementById('retryActions');
  if (retryWrap) retryWrap.classList.add('hidden');
  document.getElementById('choiceCard').classList.remove('hidden');
  setStep(discordOk ? 2 : 1);
  const st = document.getElementById('startStatus');
  if (st) { st.textContent = ''; st.className = 'status'; }
  if (window.showToast) showToast('Session reset. You can choose a duration below.');
}

function showWaiting(title, sub, retryable = false) {
  document.getElementById('result').classList.remove('hidden');
  document.getElementById('waitState').classList.remove('hidden');
  document.getElementById('resultTitle').textContent = title;
  document.getElementById('resultSub').textContent = sub;
  document.getElementById('newKey').classList.add('hidden');
  document.getElementById('resultActions').classList.add('hidden');
  document.getElementById('waitSteps').classList.remove('hidden');
  const cancelWrap = document.getElementById('waitCancel');
  const retryWrap = document.getElementById('retryActions');
  if (cancelWrap) cancelWrap.classList.remove('hidden');
  document.querySelector('#waitState .ks-spinner').classList.remove('hidden');
  if (retryable) {
    document.getElementById('waitState').classList.add('hidden');
    if (cancelWrap) cancelWrap.classList.add('hidden');
    if (retryWrap) retryWrap.classList.remove('hidden');
    document.getElementById('choiceCard').classList.remove('hidden');
    setStep(discordOk ? 2 : 1);
  } else {
    if (retryWrap) retryWrap.classList.add('hidden');
    document.getElementById('choiceCard').classList.add('hidden');
  }
}

function startPolling(puid) {
  if (pollTimer) clearInterval(pollTimer);
  poll(puid); // PREMIER poll immediat: en revenant de la pub, la reponse part tout de suite
  pollTimer = setInterval(() => poll(puid), 2000);
}

// INSTANT: poll des que l'onglet redevient visible/actif.
// Les timers d'onglets en arriere-plan sont brides par le navigateur (~1/min),
// donc au retour sur l'onglet on force un poll immediat.
function pollNowIfPending() {
  if (pollTimer === null) return; // polling termine: cle deja delivree
  const puid = localStorage.getItem(PUID_STORAGE);
  if (puid) poll(puid);
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') pollNowIfPending();
});
window.addEventListener('focus', pollNowIfPending);

let pollInFlight = false; // anti double-poll simultane (retour d'onglet: visibilitychange + focus + tick)

async function poll(puid) {
  if (pollInFlight) return;
  pollInFlight = true;
  try {
    const r = await fetch('/api/key/status?puid=' + encodeURIComponent(puid));
    const d = await r.json();
    if (pollTimer === null) return; // livraison/arrêt déjà survenu: réponse tardive jetée

    if (d.success && d.status === 'completed' && d.key) {
      clearInterval(pollTimer);
      pollTimer = null;
      localStorage.setItem(KEY_STORAGE, d.key);
      localStorage.removeItem(PUID_STORAGE);
      localStorage.removeItem(PUID_STORAGE + '_time');
      document.getElementById('waitState').classList.add('hidden');
      const cancelWrap = document.getElementById('waitCancel');
      if (cancelWrap) cancelWrap.classList.add('hidden');
      const retryWrap = document.getElementById('retryActions');
      if (retryWrap) retryWrap.classList.add('hidden');
      document.getElementById('resultTitle').textContent = d.renewed ? '✅ Key renewed!' : '🎉 Key obtained!';
      document.getElementById('resultSub').textContent = 'Paste it into the loader — it\'s also saved in your browser.';
      const el = document.getElementById('newKey');
      el.classList.remove('hidden');
      el.textContent = d.key;
      document.getElementById('resultActions').classList.remove('hidden');
      document.getElementById('waitSteps').classList.add('hidden');
      if (window.launchConfetti) window.launchConfetti();
      showModal(d.key, d.renewed, d.expiresAt);
      loadCurrentKey();
      return;
    }

    if (d.status === 'pending' && typeof d.tasksDone === 'number' && typeof d.tasksRequired === 'number' && d.tasksRequired > 1) {
      const remaining = d.tasksRequired - d.tasksDone;
      if (d.tasksDone > 0) {
        document.getElementById('resultTitle').textContent = `⏳ Checkpoint ${d.tasksDone}/${d.tasksRequired} complete!`;
        document.getElementById('resultSub').textContent = `Complete the next checkpoint (${remaining} remaining) on LootLabs to obtain your key.`;
      }
    }

    if (d.status === 'rejected' || d.status === 'token_expired' || d.status === 'token_invalid') {
      clearInterval(pollTimer);
      pollTimer = null;
      localStorage.removeItem(PUID_STORAGE);
      localStorage.removeItem(PUID_STORAGE + '_time');
      showWaiting('⚠️ Session expired', 'The verification took too long or was reset — pick a duration below.', true);
      return;
    }
    if (d.status === 'forbidden') {
      clearInterval(pollTimer);
      pollTimer = null;
      localStorage.removeItem(PUID_STORAGE);
      localStorage.removeItem(PUID_STORAGE + '_time');
      showWaiting('🔒 Session mismatch', 'This session doesn\'t belong to this browser — sign in again and retry.', true);
      return;
    }
    if (d.status === 'already_claimed') {
      clearInterval(pollTimer);
      pollTimer = null;
      localStorage.removeItem(PUID_STORAGE);
      localStorage.removeItem(PUID_STORAGE + '_time');
      showWaiting('✅ Already claimed', 'This session\'s key was already retrieved — pick a duration below.', true);
      return;
    }
    // Statut DEFINITIVMENT mort (session inconnue): on arrete et on nettoie.
    if (d.error === 'Unknown session' || d.status === 'revoked_key') {
      clearInterval(pollTimer);
      pollTimer = null;
      localStorage.removeItem(PUID_STORAGE);
      localStorage.removeItem(PUID_STORAGE + '_time');
      showWaiting('⚠️ Session reset', (d.error || 'Previous session finished — pick a duration below.'), true);
      return;
    }
    // 500 transitoire / reseau: PAS d'arret — le tick suivant reessaie.
  } catch {
    // Erreur reseau (offline, 429 rate-limit): on continue, tick suivant.
  } finally {
    pollInFlight = false;
  }
}

function flashCopied(btn) {
  if (!btn) return;
  const old = btn.innerHTML;
  btn.classList.add('copied');
  btn.innerHTML = 'Copied ✓';
  setTimeout(() => { btn.classList.remove('copied'); btn.innerHTML = old; }, 1400);
}

function copyKey() {
  const v = document.getElementById('newKey').textContent;
  if (v) { navigator.clipboard.writeText(v); showToast('🔑 Key copied to clipboard!'); flashCopied(document.querySelector('#resultActions .btn.small')); }
}

if (location.pathname.endsWith('/callback')) {
  history.replaceState({}, '', '/getkey');
}
resumePendingSession();

function resumePendingSession() {
  const puid = localStorage.getItem(PUID_STORAGE);
  if (!puid) return;
  const storedTime = parseInt(localStorage.getItem(PUID_STORAGE + '_time') || '0', 10);
  if (storedTime && Date.now() - storedTime > 15 * 60 * 1000) {
    localStorage.removeItem(PUID_STORAGE);
    localStorage.removeItem(PUID_STORAGE + '_time');
    return;
  }
  setStep(3);
  showWaiting('⏳ Verifying your session…', 'Your key will pop up as soon as it\'s validated.');
  startPolling(puid);
}

loadCurrentKey();
loadDiscordStatus();
loadHwidStatus();
loadReferralStats();
