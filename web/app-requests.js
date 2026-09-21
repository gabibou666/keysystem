/* ============================================================================
   app-requests.js — Demandes de scripts (page d'accueil uniquement).

   1. CLASSEMENT : GET /api/requests/top (public) affiche les jeux les plus
      demandés sous forme de tier list (S/A/B/C) : icône, nom, nombre de
      demandes, et la pastille « Script prêt » quand un script existe déjà.
   2. FORMULAIRE : POST /api/requests {placeId, note?} — visible seulement
      quand l'utilisateur est connecté (même détection que le parrainage :
      GET /api/referrals/stats -> { loggedIn }), sinon une invitation à se
      connecter avec Discord.
   3. MODALE « TON SCRIPT EST PRÊT » : à la prochaine visite,
      GET /api/requests/mine renvoie les demandes servies non vues ; on affiche
      la modale puis on appelle POST /api/requests/seen pour qu'elle ne
      revienne pas.

   Aucun gestionnaire d'événement dans le HTML : tout passe par
   addEventListener. Les textes viennent de l'API : ils sont insérés en
   textContent, jamais en innerHTML.
   ========================================================================== */
(function () {
  'use strict';

  var TOP_URL = '/api/requests/top';
  var MINE_URL = '/api/requests/mine';
  var REQUEST_URL = '/api/requests';
  var SEEN_URL = '/api/requests/seen';
  var STATS_URL = '/api/referrals/stats';

  // Tier list : les 3 premiers en S, puis A, B, C. Au-delà de 12 lignes le
  // classement complet est résumé en bas de liste.
  var TIER_BY_RANK = ['S', 'S', 'S', 'A', 'A', 'A', 'B', 'B', 'B', 'C', 'C', 'C'];
  var MAX_ROWS = TIER_BY_RANK.length;

  var GAME_GLYPH =
    '<svg class="icon-svg" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<line x1="6" y1="11" x2="10" y2="11"/><line x1="8" y1="9" x2="8" y2="13"/>' +
    '<line x1="15.5" y1="10.5" x2="15.6" y2="10.5"/><line x1="18" y1="13" x2="18.1" y2="13"/>' +
    '<path d="M17.5 5H6.5A4.5 4.5 0 0 0 2 9.5v5A4.5 4.5 0 0 0 6.5 19h11a4.5 4.5 0 0 0 4.5-4.5v-5A4.5 4.5 0 0 0 17.5 5Z"/></svg>';

  var CHECK_GLYPH =
    '<svg class="icon-svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';

  // Réponses serveur -> message français. Le refus peut venir du code HTTP
  // (401/409/429) ou d'un jeton `reason`/`error` : on couvre les deux
  // conventions (contrat écrit et implémentation en place).
  var REASONS = {
    auth_required: 'Connecte-toi avec Discord pour envoyer une demande.',
    invalid_place_id: "Cet identifiant de jeu n'existe pas — vérifie le PlaceId.",
    already_requested: 'Tu as déjà demandé un script pour ce jeu.',
    rate_limited: 'Trop de demandes d\u2019un coup — réessaie dans quelques minutes.',
    error: "La demande n'a pas pu être enregistrée — réessaie plus tard.",
  };

  function reasonFor(status, d) {
    var token = String((d && (d.reason || d.error)) || '');
    if (status === 401 || token === 'auth_required' || token === 'discord_required') return 'auth_required';
    if (status === 429 || token === 'rate_limited' || token === 'too_many_requests') return 'rate_limited';
    if (status === 409 || token === 'already_requested' || token === 'deja_demande') return 'already_requested';
    if (status === 400 || token === 'invalid_place_id' || token === 'place_id_invalide') return 'invalid_place_id';
    return 'error';
  }

  function plural(n, one, many) {
    return n + ' ' + (n > 1 ? many : one);
  }

  function setFeedback(text, kind) {
    var el = document.getElementById('reqFeedback');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'requests-feedback' + (kind ? ' ' + kind : '');
  }

  /* ==========================================================================
     1. Classement (tier list)
     ======================================================================== */

  function iconFor(item) {
    var box = document.createElement('span');
    box.className = 'requests-icon';
    var url = typeof item.iconUrl === 'string' ? item.iconUrl : '';
    if (!/^https:\/\//.test(url)) {
      box.innerHTML = GAME_GLYPH;
      return box;
    }
    var img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.addEventListener('error', function () {
      img.remove();
      box.innerHTML = GAME_GLYPH;
    });
    img.src = url;
    box.appendChild(img);
    return box;
  }

  function rowFor(item, rank) {
    var li = document.createElement('li');
    li.className = 'requests-row';

    var pos = document.createElement('span');
    pos.className = 'requests-rank';
    pos.textContent = '#' + rank;

    var name = document.createElement('span');
    name.className = 'requests-name';
    // textContent : un nom renvoyé par l'API ne peut pas injecter de HTML.
    name.textContent = typeof item.name === 'string' && item.name ? item.name : 'Jeu ' + item.placeId;
    name.title = name.textContent;

    var count = document.createElement('span');
    count.className = 'requests-count';
    count.textContent = plural(Number(item.count) || 0, 'demande', 'demandes');

    li.appendChild(pos);
    li.appendChild(iconFor(item));
    li.appendChild(name);
    li.appendChild(count);

    if (item.hasScript) {
      var flag = document.createElement('span');
      flag.className = 'requests-flag';
      flag.title = 'Un script existe déjà pour ce jeu';
      flag.innerHTML = CHECK_GLYPH;
      flag.appendChild(document.createTextNode('Script prêt'));
      li.appendChild(flag);
    }
    return li;
  }

  function clearTopBox(box) {
    box.textContent = '';
    box.setAttribute('aria-busy', 'false');
  }

  // Le classement est servi sous deux jeux de noms de champs selon la version
  // déployée : { requests: [{ count, hasScript }] } ou
  // { games: [{ requests, available }] }. On accepte les deux pour ne pas
  // dépendre d'une seule orthographe.
  function normalizeTop(d) {
    var raw = d && (Array.isArray(d.requests) ? d.requests : Array.isArray(d.games) ? d.games : null);
    if (!raw) return [];
    return raw.map(function (g) {
      return {
        placeId: g.placeId,
        name: g.name,
        iconUrl: g.iconUrl,
        count: Number(g.count != null ? g.count : g.requests) || 0,
        hasScript: !!(g.hasScript != null ? g.hasScript : g.available),
      };
    });
  }

  function renderTop(list) {
    var box = document.getElementById('requestsTierList');
    if (!box) return;
    clearTopBox(box);

    if (!list.length) {
      var empty = document.createElement('p');
      empty.className = 'requests-empty';
      empty.textContent = "Aucune demande pour l'instant : sois le premier à réclamer un script.";
      box.appendChild(empty);
      return;
    }

    var shown = list.slice(0, MAX_ROWS);
    var tier = null;
    var rows = null;
    shown.forEach(function (item, i) {
      var label = TIER_BY_RANK[i] || 'C';
      if (label !== tier) {
        tier = label;
        var block = document.createElement('div');
        block.className = 'requests-tier';
        var badge = document.createElement('span');
        badge.className = 'tier-badge';
        badge.textContent = label;
        badge.setAttribute('aria-hidden', 'true');
        rows = document.createElement('ul');
        rows.className = 'requests-rows';
        block.appendChild(badge);
        block.appendChild(rows);
        box.appendChild(block);
      }
      rows.appendChild(rowFor(item, i + 1));
    });

    if (list.length > shown.length) {
      var note = document.createElement('p');
      note.className = 'requests-note';
      note.textContent = plural(list.length, 'jeu demandé au total', 'jeux demandés au total');
      box.appendChild(note);
    }
  }

  function renderTopError() {
    var box = document.getElementById('requestsTierList');
    if (!box) return;
    clearTopBox(box);
    var p = document.createElement('p');
    p.className = 'requests-error';
    p.textContent = 'Impossible de charger le classement pour le moment.';
    box.appendChild(p);
  }

  function loadTop() {
    return fetch(TOP_URL, { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (d) {
        renderTop(normalizeTop(d));
      })
      .catch(function () {
        renderTopError();
      });
  }

  /* ==========================================================================
     2. État de connexion + formulaire de demande
     ======================================================================== */

  function paintAuth(loggedIn) {
    var out = document.getElementById('reqLoggedOut');
    var form = document.getElementById('reqForm');
    if (out) out.classList.toggle('hidden', loggedIn);
    if (form) form.classList.toggle('hidden', !loggedIn);
  }

  function loadAuth() {
    return fetch(STATS_URL, { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
      .then(function (r) {
        return r.json();
      })
      .then(function (d) {
        paintAuth(!!(d && d.loggedIn));
      })
      .catch(function () {
        paintAuth(false);
      });
  }

  function sendRequest(placeId, note) {
    var btn = document.getElementById('reqSubmitBtn');
    var label = btn ? btn.textContent : '';
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Envoi…';
    }
    setFeedback('', '');
    return fetch(REQUEST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(note ? { placeId: placeId, note: note } : { placeId: placeId }),
    })
      .then(function (r) {
        return r
          .json()
          .catch(function () {
            return {};
          })
          .then(function (d) {
            return { status: r.status, body: d || {} };
          });
      })
      .then(function (res) {
        var d = res.body;
        if (res.status >= 200 && res.status < 300 && d.ok !== false) {
          setFeedback(
            d.gameName
              ? 'Demande envoyée pour « ' + d.gameName + ' » ! Tu es prévenu ici dès que le script est publié.'
              : 'Demande envoyée ! Tu es prévenu ici dès que le script est publié.',
            'ok'
          );
          var id = document.getElementById('reqPlaceId');
          var nt = document.getElementById('reqNote');
          if (id) id.value = '';
          if (nt) nt.value = '';
          loadTop();
          return;
        }
        var reason = reasonFor(res.status, d);
        if (reason === 'auth_required') paintAuth(false);
        setFeedback(REASONS[reason], 'err');
      })
      .catch(function () {
        setFeedback('Connexion impossible — vérifie ton réseau et réessaie.', 'err');
      })
      .then(function () {
        if (btn) {
          btn.disabled = false;
          btn.textContent = label;
        }
      });
  }

  function onSubmit(e) {
    e.preventDefault();
    var idEl = document.getElementById('reqPlaceId');
    var noteEl = document.getElementById('reqNote');
    var raw = idEl ? String(idEl.value).trim() : '';
    if (!/^\d{3,}$/.test(raw)) {
      setFeedback('Identifiant invalide : indique le PlaceId du jeu (chiffres uniquement).', 'err');
      if (idEl) idEl.focus();
      return;
    }
    sendRequest(Number(raw), noteEl ? noteEl.value.trim().slice(0, 240) : '');
  }

  /* ==========================================================================
     3. Modale « Ton script est prêt ! »
     ======================================================================== */

  var lastFocused = null;
  var seenChecked = false;

  function focusables(ov) {
    return Array.prototype.slice
      .call(ov.querySelectorAll('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'))
      .filter(function (el) {
        return el.offsetWidth > 0 || el.offsetHeight > 0 || el === document.activeElement;
      });
  }

  function onModalKey(e) {
    var ov = document.getElementById('reqSeenModal');
    if (!ov || !ov.classList.contains('open')) return;
    if (e.key === 'Escape' || e.key === 'Esc') {
      e.preventDefault();
      closeSeenModal();
      return;
    }
    if (e.key !== 'Tab') return;
    // Piège de focus : la tabulation tourne dans la modale, jamais derrière.
    var f = focusables(ov);
    if (!f.length) return;
    var first = f[0];
    var last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function openSeenModal(items) {
    var ov = document.getElementById('reqSeenModal');
    if (!ov) return;
    var list = document.getElementById('reqSeenList');
    if (list) {
      list.textContent = '';
      items.forEach(function (it) {
        var li = document.createElement('li');
        li.textContent = it.name || 'Jeu ' + it.placeId;
        list.appendChild(li);
      });
    }
    var desc = document.getElementById('reqSeenDesc');
    if (desc) {
      desc.textContent =
        items.length > 1
          ? "Les scripts que tu avais demandés viennent d'être ajoutés :"
          : "Le script que tu avais demandé vient d'être ajouté :";
    }
    lastFocused = document.activeElement;
    ov.classList.add('open');
    document.addEventListener('keydown', onModalKey);
    var first = ov.querySelector('a[href], button');
    if (first) first.focus();
  }

  function closeSeenModal() {
    var ov = document.getElementById('reqSeenModal');
    if (!ov || !ov.classList.contains('open')) return;
    ov.classList.remove('open');
    document.removeEventListener('keydown', onModalKey);
    if (lastFocused && typeof lastFocused.focus === 'function') lastFocused.focus();
  }

  function checkSeen() {
    if (seenChecked) return;
    seenChecked = true;
    fetch(MINE_URL, { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
      .then(function (r) {
        if (!r.ok) return null; // visiteur non connecté : rien à annoncer
        return r.json();
      })
      .then(function (d) {
        var fulfilled = d && Array.isArray(d.fulfilled) ? d.fulfilled : [];
        var items = fulfilled.filter(function (x) {
          return x && (x.name || x.placeId);
        });
        if (!items.length) return;
        openSeenModal(items);
        // Appelé APRÈS l'affichage : la modale ne revient pas à la visite suivante.
        return fetch(SEEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({}),
        }).catch(function () {});
      })
      .catch(function () {});
  }

  /* ==========================================================================
     Branchements (aucun attribut onclick dans le HTML)
     ======================================================================== */

  var form = document.getElementById('reqForm');
  if (form) form.addEventListener('submit', onSubmit);

  var pick = document.getElementById('reqPlaceId');
  if (pick) {
    // Champ numérique : on écarte les caractères non chiffrés à la saisie.
    pick.addEventListener('input', function () {
      var clean = pick.value.replace(/[^\d]/g, '').slice(0, 20);
      if (clean !== pick.value) pick.value = clean;
    });
  }

  var overlay = document.getElementById('reqSeenModal');
  if (overlay) {
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) closeSeenModal();
    });
  }

  var closeBtn = document.getElementById('reqSeenClose');
  if (closeBtn) closeBtn.addEventListener('click', closeSeenModal);

  var openBtn = document.getElementById('reqSeenOpen');
  if (openBtn) {
    openBtn.addEventListener('click', function (e) {
      var games = document.getElementById('games');
      if (!games) return; // on laisse le lien suivre sa route
      e.preventDefault();
      closeSeenModal();
      var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      games.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
    });
  }

  if (document.getElementById('requestsTierList')) {
    loadTop();
    loadAuth();
    checkSeen();
  }
})();
