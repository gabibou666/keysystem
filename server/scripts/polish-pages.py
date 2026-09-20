#!/usr/bin/env python3
"""Passe de finition sur les pages web (idempotente).

1. versionne les assets (?v=__V__) pour permettre un cache immutable d'un an;
2. precharge la police auto-hebergee (fin du flash de texte);
3. ajoute les metadonnees SEO/sociales manquantes (description, canonical, OG,
   Twitter, JSON-LD) et un noindex sur les pages non indexables;
4. rend le bouton hamburger accessible (aria-label/aria-expanded/aria-controls).
"""
import os
import re

WEB = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'web'))

SEO = {
    'index': dict(
        title='AUDIT HUB — Free Roblox Key System & Universal Script Loader',
        desc='Get a free Roblox key in under a minute: complete one short link and run your script in any supported game, on every executor (Delta, Wave, Xeno, Solara, Codex, MacSploit).',
        path='/',
    ),
    'getkey': dict(
        title='Get a Free Key — AUDIT HUB',
        desc='Choose 12h (1 link) or 24h (2 links), sign in with Discord and get your Roblox key instantly. Renewing extends the same key, so nothing to re-paste in your executor.',
        path='/getkey',
    ),
    'changelog': dict(
        title='Script Changelog — AUDIT HUB',
        desc='Every published script update for AUDIT HUB: version, supported game and the exact build currently served to executors.',
        path='/changelog',
    ),
    'robux': dict(
        title='Pay with Robux — AUDIT HUB',
        desc='Skip the links: unlock 24h, weekly, monthly or lifetime access with Robux and start your script right away.',
        path='/robux',
    ),
    'privacy': dict(title=None, desc=None, path='/privacy'),
    'terms': dict(title=None, desc=None, path='/terms'),
    'cookies': dict(title=None, desc=None, path='/cookies'),
    'verify': dict(title=None, desc=None, path='/verify', noindex=True),
    'admin': dict(title=None, desc=None, path='/admin', noindex=True),
}

FAQ_JSONLD = {
    'index': '''<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebSite",
      "name": "AUDIT HUB",
      "url": "__SITE__/",
      "description": "Free Roblox key system with a universal script loader."
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {"@type": "Question", "name": "Which executors are supported?",
         "acceptedAnswer": {"@type": "Answer", "text": "Synapse Z, Wave, Xeno, Delta, Codex, Fluxus, Hydrogen, Solara, Ronin, MacSploit, Potassium and most others. The loader auto-detects your executor and adapts its UI."}},
        {"@type": "Question", "name": "How long does a key last?",
         "acceptedAnswer": {"@type": "Answer", "text": "12 hours with 1 link or 24 hours with 2 links. When it expires, renewing re-activates the same key, so your executor still has it saved."}},
        {"@type": "Question", "name": "Can I use my key on another Roblox account?",
         "acceptedAnswer": {"@type": "Answer", "text": "No. A key binds to the first Roblox account and device that uses it; a shared key is rejected for everyone else and can be auto-revoked."}},
        {"@type": "Question", "name": "My key says expired, what should I do?",
         "acceptedAnswer": {"@type": "Answer", "text": "Open the key page and pick 12h or 24h again: it extends your existing key, same string, no need to paste anything new in your executor."}},
        {"@type": "Question", "name": "Why do I need to sign in with Discord?",
         "acceptedAnswer": {"@type": "Answer", "text": "One sign-in links your key to your Discord account and adds you to the community server, which is what prevents bots and proxies from farming keys."}}
      ]
    }
  ]
}
</script>''',
}

VERSIONED = [
    ('href="/style.css"', 'href="/style.css?v=__V__"'),
    ('href="/favicon.svg"', 'href="/favicon.svg?v=__V__"'),
    ('href="/favicon.png"', 'href="/favicon.png?v=__V__"'),
    ('href="/favicon.ico"', 'href="/favicon.ico?v=__V__"'),
    ('src="/effects.js"', 'src="/effects.js?v=__V__"'),
    ('src="/guard.js"', 'src="/guard.js?v=__V__"'),
    ('src="/cookie-consent.js"', 'src="/cookie-consent.js?v=__V__"'),
]

FONT_PRELOAD = '<link rel="preload" href="/fonts/plus-jakarta-sans-latin.woff2" as="font" type="font/woff2" crossorigin>\n'

changed = []
for name in sorted(os.listdir(WEB)):
    if not name.endswith('.html'):
        continue
    base = name[:-5]
    path = os.path.join(WEB, name)
    html = open(path, encoding='utf-8').read()
    before = html

    for old, new in VERSIONED:
        html = html.replace(old, new)

    # Police principale prechargee (evite le flash de police sur mobile)
    if 'plus-jakarta-sans-latin.woff2' not in html and 'style.css?v=__V__' in html:
        html = html.replace('<link rel="stylesheet" href="/style.css?v=__V__">',
                            FONT_PRELOAD + '<link rel="stylesheet" href="/style.css?v=__V__">')

    # Metadonnees SEO / sociales
    meta = SEO.get(base)
    if meta:
        block = []
        if meta.get('noindex') and 'name="robots"' not in html:
            block.append('<meta name="robots" content="noindex, nofollow">')
        if meta.get('desc') and 'name="description"' not in html:
            block.append(f'<meta name="description" content="{meta["desc"]}">')
        if meta.get('title') and f'<title>{meta["title"]}</title>' not in html:
            html = re.sub(r'<title>.*?</title>', f'<title>{meta["title"]}</title>', html, count=1, flags=re.S)
        if 'rel="canonical"' not in html:
            block.append(f'<link rel="canonical" href="__SITE__{meta["path"]}">')
        if 'property="og:title"' not in html:
            og_title = meta.get('title') or re.search(r'<title>(.*?)</title>', html, re.S).group(1)
            og_desc = meta.get('desc') or (re.search(r'name="description" content="([^"]*)"', html) or [None, ''])[1]
            block += [
                '<meta property="og:type" content="website">',
                '<meta property="og:site_name" content="AUDIT HUB">',
                f'<meta property="og:title" content="{og_title}">',
                f'<meta property="og:description" content="{og_desc}">',
                f'<meta property="og:url" content="__SITE__{meta["path"]}">',
                '<meta property="og:image" content="__SITE__/og.png">',
                '<meta property="og:image:width" content="1200">',
                '<meta property="og:image:height" content="630">',
                '<meta property="og:image:alt" content="AUDIT HUB — free Roblox key system and universal script loader">',
                '<meta name="twitter:card" content="summary_large_image">',
                f'<meta name="twitter:title" content="{og_title}">',
                f'<meta name="twitter:description" content="{og_desc}">',
                '<meta name="twitter:image" content="__SITE__/og.png">',
            ]
        if block:
            anchor = '<link rel="icon"'
            html = html.replace(anchor, '\n'.join(block) + '\n' + anchor, 1)

    # Donnees structurees (FAQ: rich results)
    if base in FAQ_JSONLD and 'application/ld+json' not in html:
        html = html.replace('</head>', FAQ_JSONLD[base] + '\n</head>', 1)

    # Hamburger accessible
    html = html.replace(
        '<button class="nav-hamburger" id="navHamburger" onclick="toggleNav()">',
        '<button class="nav-hamburger" id="navHamburger" type="button" onclick="toggleNav()" '
        'aria-label="Open navigation menu" aria-expanded="false" aria-controls="navLinks">',
    )
    if 'navLinks' in html and 'aria-label="Open navigation' not in html:
        print(f'!! hamburger non annote sur {name}')

    if html != before:
        open(path, 'w', encoding='utf-8', newline='').write(html)
        changed.append(name)

print('pages mises a jour:', changed)
print('\n--- controle des references non versionnees ---')
for name in sorted(os.listdir(WEB)):
    if name.endswith('.html'):
        h = open(os.path.join(WEB, name), encoding='utf-8').read()
        rest = re.findall(r'(?:src|href)="/(?:style\.css|effects\.js|guard\.js|cookie-consent\.js|app-[a-z]+\.js|ad-init\.js|favicon\.[a-z]+)"', h)
        if rest:
            print(f'  {name}: {len(rest)} reference(s) sans version -> {set(rest)}')
        if 'jsdelivr' in h:
            print(f'  {name}: utilise cdn.jsdelivr.net')
print('controle termine')
