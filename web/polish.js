/* ============================================================================
   polish.js — micro-interactions de la couche Design v2
   ----------------------------------------------------------------------------
   Regles du fichier:
   - progressive enhancement: si le JS ne tourne pas, le site reste identique;
   - 1 seul ecouteur par evenement (delegation) + lecture/ecriture groupees en
     requestAnimationFrame (aucun layout thrashing);
   - rien ne s'execute au doigt (hover: none) ni sous prefers-reduced-motion:
     inutile de payer du CPU sur mobile;
   - aucun script inline (compatibilite CSP stricte).
   ============================================================================ */
(function () {
  'use strict';

  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var fine = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  var frame = null;

  /* ------------------------------------------------------------------------
     1. Projecteur sous le curseur sur les cartes.
     On ajoute la classe .dx-spot (stylee dans design.css) uniquement sur les
     elements "carte", jamais sur les blocs a pseudo-element deja utilise
     (.hero-terminal, .ad-banner).
     ---------------------------------------------------------------------- */
  var SPOT_SELECTOR =
    '.card, .step-card, .game-card, .exec-card, .stat, .keypanel, .hub-card, ' +
    '.offer-enhanced, .legal-card, .ks-cookie-item';

  function enableSpotlight() {
    if (reduce || !fine) return;
    var nodes = document.querySelectorAll(SPOT_SELECTOR);
    for (var i = 0; i < nodes.length; i++) nodes[i].classList.add('dx-spot');
  }

  function trackSpotlight(event) {
    var target = event.target && event.target.closest ? event.target.closest('.dx-spot') : null;
    if (!target) return;
    var rect = target.getBoundingClientRect();
    var x = event.clientX - rect.left;
    var y = event.clientY - rect.top;
    if (frame) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(function () {
      target.style.setProperty('--dx-x', x + 'px');
      target.style.setProperty('--dx-y', y + 'px');
    });
  }

  /* ------------------------------------------------------------------------
     2. Navbar condensee apres defilement (detail "app native").
     ---------------------------------------------------------------------- */
  function navOnScroll() {
    var nav = document.querySelector('nav');
    if (!nav) return;
    var scrolled = false;
    var ticking = false;

    function update() {
      ticking = false;
      var next = window.scrollY > 36;
      if (next !== scrolled) {
        scrolled = next;
        nav.classList.toggle('dx-scrolled', scrolled);
      }
    }

    window.addEventListener(
      'scroll',
      function () {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(update);
      },
      { passive: true }
    );
    update();
  }

  /* ------------------------------------------------------------------------
     Demarrage
     ---------------------------------------------------------------------- */
  function boot() {
    enableSpotlight();
    navOnScroll();
    if (fine && !reduce) {
      document.addEventListener('pointermove', trackSpotlight, { passive: true });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // Les cartes de jeux arrivent apres un fetch: on les equipe a leur tour.
  var observer = null;
  if (window.MutationObserver && fine && !reduce) {
    observer = new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        if (records[i].addedNodes && records[i].addedNodes.length) {
          enableSpotlight();
          return;
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }
})();
