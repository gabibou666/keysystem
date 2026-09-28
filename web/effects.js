/* ============================================================
   KeySystem UI Utilities — clean, professional, non-intrusive
   Toasts, scroll progress, reveal observer.
   Zero vibecoder fluff: no particles, no cursor glow, no 3D tilt.
   ============================================================ */
(function () {
  'use strict';

  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- 0. Embedded styles for toasts & progress bar ---------- */
  var css = [
    '#ks-progress{position:fixed;top:0;left:0;height:2px;width:100%;background:#8b5cf6;z-index:1000;transform-origin:left;transform:scaleX(0);pointer-events:none;}',
    '#ks-toasts{position:fixed;bottom:22px;right:22px;z-index:1001;display:flex;flex-direction:column;gap:10px;pointer-events:none;}',
    '.toast{background:#13111cf0;border:1px solid rgba(139,92,246,0.3);color:#f3e8ff;padding:10px 16px;border-radius:8px;font-size:13.5px;box-shadow:0 8px 24px rgba(0,0,0,0.5);font-family:inherit;}',
    '.toast.err{border-color:rgba(244,114,182,0.4);color:#fbcfe8;}',
    '.toast.out{opacity:0;transition:opacity 200ms ease;}'
  ].join('\n');
  var styleEl = document.createElement('style');
  styleEl.id = 'ks-effects-css';
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  /* ---------- 1. Scroll progress bar ---------- */
  var bar = document.createElement('div');
  bar.id = 'ks-progress';
  document.body.appendChild(bar);
  function updProgress() {
    var h = document.documentElement;
    var max = h.scrollHeight - h.clientHeight;
    var p = max > 0 ? h.scrollTop / max : 0;
    bar.style.transform = 'scaleX(' + p.toFixed(4) + ')';
  }
  window.addEventListener('scroll', updProgress, { passive: true });
  window.addEventListener('resize', updProgress);
  updProgress();

  /* ---------- 2. Toast system (global) ---------- */
  var toasts = document.createElement('div');
  toasts.id = 'ks-toasts';
  document.body.appendChild(toasts);
  window.showToast = function (msg, type) {
    var t = document.createElement('div');
    t.className = 'toast ' + (type === 'err' ? 'err' : 'ok');
    t.textContent = msg;
    toasts.appendChild(t);
    setTimeout(function () {
      t.classList.add('out');
      setTimeout(function () { t.remove(); }, 220);
    }, 2400);
  };

  /* ---------- 3. Reveal-on-scroll ---------- */
  var io = null;
  if ('IntersectionObserver' in window) {
    io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) {
          e.target.classList.add('in');
          io.unobserve(e.target);
        }
      });
    }, { threshold: 0.1 });
  }
  function observeReveals(root) {
    if (!io) {
      var els = (root || document).querySelectorAll('.reveal');
      for (var i = 0; i < els.length; i++) els[i].classList.add('in');
      return;
    }
    var list = (root || document).querySelectorAll('.reveal:not(.observed)');
    for (var j = 0; j < list.length; j++) {
      list[j].classList.add('observed');
      io.observe(list[j]);
    }
  }
  observeReveals(document);
  if (window.MutationObserver) {
    new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var added = muts[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var n = added[j];
          if (n.nodeType === 1) observeReveals(n.querySelectorAll ? n : document);
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  /* ---------- 4. No-op stubs for retired vibecoder animations ---------- */
  window.launchConfetti = function () {};
  window.startSocialTicker = function () {};
})();
