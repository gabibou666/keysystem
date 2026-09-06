/* ============================================================
   KeySystem UI Effects — shared engine (particles, cursor glow,
   magnetic buttons, 3D tilt, ripple, toasts, scroll progress)
   ============================================================ */
(function () {
  'use strict';

  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var isTouch = window.matchMedia('(hover: none)').matches;

  /* ---------- 0. Styles embarques (autonome: marche sans style.css) ---------- */
  var css = [
    '#ks-progress{position:fixed;top:0;left:0;height:3px;width:100%;background:linear-gradient(90deg,#7c3aed,#c084fc,#e9d5ff);z-index:1000;border-radius:0 3px 3px 0;box-shadow:0 0 14px #c084fc99;transform-origin:left;transform:scaleX(0);pointer-events:none;will-change:transform;}',
    '#ks-particles{position:fixed;inset:0;z-index:0;pointer-events:none;}',
    '#ks-glow{position:fixed;width:340px;height:340px;margin:-170px 0 0 -170px;left:-500px;top:-500px;background:radial-gradient(circle,#8b5cf626 0%,transparent 65%);pointer-events:none;z-index:0;will-change:left,top;}',
    '#ks-toasts{position:fixed;bottom:22px;right:22px;z-index:1001;display:flex;flex-direction:column;gap:10px;pointer-events:none;}',
    '.toast{background:#12101af0;border:1px solid #c084fc55;color:#f3e8ff;padding:12px 18px;border-radius:12px;font-size:14px;box-shadow:0 8px 30px #00000080,0 0 24px #7c3aed26;animation:ksToastIn .35s cubic-bezier(.2,.9,.3,1.2) both;backdrop-filter:blur(10px);font-family:Segoe UI,system-ui,sans-serif;}',
    '.toast.err{border-color:#f472b655;color:#fbcfe8;}',
    '.toast.out{animation:ksToastOut .25s ease both;}',
    '@keyframes ksToastIn{from{opacity:0;transform:translateX(40px) scale(.9);}to{opacity:1;transform:translateX(0) scale(1);}}',
    '@keyframes ksToastOut{to{opacity:0;transform:translateX(40px) scale(.9);}}',
    '.ks-ripple{position:absolute;border-radius:50%;background:#c084fc55;transform:scale(0);animation:ksRip .55s ease-out forwards;pointer-events:none;}',
    '@keyframes ksRip{to{transform:scale(2.6);opacity:0;}}',
    'body > main, body > nav, body > footer, body > .keypanel, body > .games-grid, body > .activity-panel, body > .login, body > table, body > form, body > .panel, body > .grid, body > .stats, body > .games-head, body > .activity-head {position: relative; z-index: 1;}',
    '@media (prefers-reduced-motion: reduce){#ks-particles,#ks-glow,.ks-ripple{display:none !important;}}'
  ].join('\n');
  var styleEl = document.createElement('style');
  styleEl.id = 'ks-effects-css';
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  /* ---------- 1. Scroll progress bar (scaleX = GPU, pas de reflow width) ---------- */
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
      setTimeout(function () { t.remove(); }, 260);
    }, 2400);
  };

  /* ---------- 3. Reveal-on-scroll (auto, avec contenu dynamique) ---------- */
  var io = null;
  if ('IntersectionObserver' in window) {
    io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) {
          e.target.classList.add('in');
          io.unobserve(e.target);
        }
      });
    }, { threshold: 0.12 });
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
  new MutationObserver(function (muts) {
    for (var i = 0; i < muts.length; i++) {
      var added = muts[i].addedNodes;
      for (var j = 0; j < added.length; j++) {
        var n = added[j];
        if (n.nodeType === 1) observeReveals(n.querySelectorAll ? n : document);
      }
    }
  }).observe(document.body, { childList: true, subtree: true });

  if (reduced) return; /* pas d'animations lourdes en reduced-motion */

  /* ---------- 4. Particle network canvas ---------- */
  var canvas = document.createElement('canvas');
  canvas.id = 'ks-particles';
  document.body.prepend(canvas);
  var ctx = canvas.getContext('2d');
  var W = 0, H = 0, parts = [];
  var mouse = { x: -9999, y: -9999 };

  function resize() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var n = Math.min(70, Math.floor((W * H) / 22000));
    parts = [];
    for (var i = 0; i < n; i++) {
      parts.push({
        x: Math.random() * W,
        y: Math.random() * H,
        vx: (Math.random() - 0.5) * 0.25,
        vy: (Math.random() - 0.5) * 0.25,
        r: Math.random() * 1.6 + 0.6
      });
    }
  }
  window.addEventListener('resize', resize);
  window.addEventListener('mousemove', function (e) {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
  }, { passive: true });
  resize();

  var running = true;
  document.addEventListener('visibilitychange', function () {
    running = !document.hidden;
    if (running) tick();
  });

  function tick() {
    if (!running) return;
    ctx.clearRect(0, 0, W, H);
    var i, p;
    for (i = 0; i < parts.length; i++) {
      p = parts[i];
      var dx = mouse.x - p.x, dy = mouse.y - p.y;
      if (dx * dx + dy * dy < 40000) {
        p.vx += dx * 0.0000022;
        p.vy += dy * 0.0000022;
      }
      p.x += p.vx;
      p.y += p.vy;
      p.vx *= 0.995;
      p.vy *= 0.995;
      if (p.x < -10) p.x = W + 10;
      if (p.x > W + 10) p.x = -10;
      if (p.y < -10) p.y = H + 10;
      if (p.y > H + 10) p.y = -10;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, 7);
      ctx.fillStyle = 'rgba(192,132,252,0.38)';
      ctx.fill();
    }
    for (i = 0; i < parts.length; i++) {
      for (var j = i + 1; j < parts.length; j++) {
        var a = parts[i], b = parts[j];
        var ddx = a.x - b.x, ddy = a.y - b.y;
        var d = ddx * ddx + ddy * ddy;
        if (d < 12000) {
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.strokeStyle = 'rgba(168,85,247,' + (0.14 * (1 - d / 12000)).toFixed(3) + ')';
          ctx.stroke();
        }
      }
    }
    requestAnimationFrame(tick);
  }
  tick();

  /* ---------- 5. Cursor glow (desktop) ---------- */
  if (!isTouch) {
    var glow = document.createElement('div');
    glow.id = 'ks-glow';
    document.body.appendChild(glow);
    var gx = -500, gy = -500, tx = -500, ty = -500;
    window.addEventListener('mousemove', function (e) {
      tx = e.clientX;
      ty = e.clientY;
    }, { passive: true });
    (function glowLoop() {
      gx += (tx - gx) * 0.12;
      gy += (ty - gy) * 0.12;
      glow.style.left = gx + 'px';
      glow.style.top = gy + 'px';
      requestAnimationFrame(glowLoop);
    })();
  }

  /* ---------- 6. Ripple au clic (delegation: marche aussi en dynamique) ---------- */
  document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('.btn') : null;
    if (!btn) return;
    var r = btn.getBoundingClientRect();
    var d = Math.max(r.width, r.height);
    var s = document.createElement('span');
    s.className = 'ks-ripple';
    s.style.width = s.style.height = d + 'px';
    s.style.left = (e.clientX - r.left - d / 2) + 'px';
    s.style.top = (e.clientY - r.top - d / 2) + 'px';
    btn.appendChild(s);
    setTimeout(function () { s.remove(); }, 600);
  });

  /* ---------- 7. Magnetic buttons + 3D tilt (delegation mouseover) ---------- */
  function bindFx(el) {
    if (el.dataset.ksFx) return;
    el.dataset.ksFx = '1';

    if (el.classList.contains('btn') && !isTouch) {
      el.addEventListener('mousemove', function (e) {
        var r = el.getBoundingClientRect();
        var x = e.clientX - r.left - r.width / 2;
        var y = e.clientY - r.top - r.height / 2;
        el.style.transform = 'translate(' + (x * 0.12).toFixed(1) + 'px,' + (y * 0.18).toFixed(1) + 'px)';
      });
      el.addEventListener('mouseleave', function () {
        el.style.transform = '';
      });
    }

    if ((el.classList.contains('game-card') || el.classList.contains('card')) && !isTouch) {
      el.addEventListener('mousemove', function (e) {
        var r = el.getBoundingClientRect();
        var px = (e.clientX - r.left) / r.width - 0.5;
        var py = (e.clientY - r.top) / r.height - 0.5;
        el.style.transform =
          'perspective(700px) rotateY(' + (px * 6).toFixed(2) + 'deg) rotateX(' +
          (-py * 6).toFixed(2) + 'deg) translateY(-3px)';
      });
      el.addEventListener('mouseleave', function () {
        el.style.transform = '';
      });
    }
  }

  document.addEventListener('mouseover', function (e) {
    var t = e.target && e.target.closest ? e.target.closest('.btn, .game-card, .card') : null;
    if (t) bindFx(t);
  }, { passive: true });
  /* bind initial statiques */
  var init = document.querySelectorAll('.btn, .game-card, .card');
  for (var k = 0; k < init.length; k++) bindFx(init[k]);

  /* ---------- 8. View Transitions: navigation interne fluide ----------
     Progressive enhancement: si l'API existe, les liens internes du site
     declenchent une transition (fondu+glissement definis dans style.css).
     Sans support -> navigation normale, aucun changement. */
  if (document.startViewTransition && !reduced) {
    document.addEventListener('click', function (e) {
      var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      if (!a) return;
      var href = a.getAttribute('href') || '';
      // interne seulement, pas d'ancre pure ni de nouvelle fenetre
      if (!href || href.startsWith('#') || href.startsWith('http') || href.startsWith('mailto') || a.target === '_blank') return;
      e.preventDefault();
      document.startViewTransition(function () {
        location.assign(href);
      });
    });
  }
})();
