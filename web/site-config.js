/* ============================================================================
   Config publique du site — une seule source de verite
   ----------------------------------------------------------------------------
   Pourquoi ce fichier existe:
   l'invitation Discord etait codee en dur dans les pages (discord.gg/2ZT28kXZR),
   et c'etait une invitation TEMPORAIRE — donc vouee a expirer. Or l'appartenance
   au serveur est obligatoire pour obtenir ET utiliser une cle: le jour de
   l'expiration, tous les boutons "Rejoin Discord" devenaient des liens morts.

   Ici on interroge /api/config/public (le serveur renvoie une invitation
   PERMANENTE, choisie automatiquement et mise en cache) et on branche tous les
   liens marques data-invite-link. Si aucune invitation exploitable n'existe, les
   liens sont MASQUES plutot que casses.
   ============================================================================ */
(function () {
  'use strict';

  window.KS_CONFIG = window.KS_CONFIG || null;

  function inviteUrl() {
    return (window.KS_CONFIG && window.KS_CONFIG.inviteUrl) || null;
  }

  // Renvoie un <a> vers l'invitation Discord, ou une chaine vide si aucune
  // invitation valide n'est disponible (jamais de lien mort affiche).
  window.ksInviteLink = function (label, style) {
    var url = inviteUrl();
    if (!url) return '';
    return (
      ' <a href="' +
      url +
      '" target="_blank" rel="noopener" style="' +
      (style || 'color:var(--accent);text-decoration:underline;font-weight:bold;') +
      '">' +
      label +
      '</a>'
    );
  };

  window.ksInviteUrl = inviteUrl;

  function apply(cfg) {
    window.KS_CONFIG = cfg || null;
    var url = inviteUrl();
    var links = document.querySelectorAll('[data-invite-link]');
    for (var i = 0; i < links.length; i++) {
      var el = links[i];
      if (url) {
        el.setAttribute('href', url);
        el.hidden = false;
        el.style.display = '';
        el.removeAttribute('aria-hidden');
      } else {
        // Pas de lien fiable: on masque (display inline explicite car la classe
        // .nav-discord-btn impose son propre display).
        el.hidden = true;
        el.style.display = 'none';
        el.setAttribute('aria-hidden', 'true');
      }
    }
  }

  fetch('/api/config/public', { credentials: 'same-origin' })
    .then(function (r) { return r.json(); })
    .then(apply)
    .catch(function () { apply(null); });
})();
