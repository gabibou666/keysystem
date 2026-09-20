#!/usr/bin/env python3
"""Extrait les <script> inline des pages web vers des fichiers externes.

Pourquoi: la CSP du serveur ne peut plus autoriser 'unsafe-inline' sur scriptSrc
(vecteur XSS principal). Tous les blocs <script> sans src deviennent
/app-<page>.js, references en defer juste avant </body> (execution APRES le
parsing => tous les globals de effects.js/guard.js sont disponibles).

Les blocs atOptions (config pub) sont remplaces par un unique /ad-init.js charge
en <head> (doit etre defini AVANT que invoke.js ne soit injecte).
"""
import os
import re
import sys

WEB = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'web')
WEB = os.path.normpath(WEB)

SCRIPT_RE = re.compile(r'<script\b([^>]*)>(.*?)</script>', re.S | re.I)

report = []

for name in sorted(os.listdir(WEB)):
    if not name.endswith('.html'):
        continue
    base = name[:-5]
    path = os.path.join(WEB, name)
    html = open(path, encoding='utf-8').read()
    original = html

    app_parts = []
    has_ads = False
    removed = 0

    def repl(m):
        global removed, has_ads
        attrs, body = m.group(1), m.group(2)
        if 'src=' in attrs:
            return m.group(0)                     # script externe: conserve
        if 'ld+json' in attrs:
            return m.group(0)                     # donnees structurees: conserve
        if 'atOptions' in body:
            has_ads = True                        # config pub -> ad-init.js
            removed += 1
            return ''
        if not body.strip():
            removed += 1
            return ''
        app_parts.append(body.strip())
        removed += 1
        return '<!-- script inline extrait vers app-%s.js -->' % base

    html = SCRIPT_RE.sub(repl, html)

    # Config pub unique, chargee en <head> (avant toute injection d'invoke.js)
    if has_ads and 'ad-init.js' not in html:
        html = html.replace(
            '<link rel="stylesheet"',
            '<script src="/ad-init.js?v=__V__"></script>\n<link rel="stylesheet"',
            1,
        )

    if app_parts:
        out = os.path.join(WEB, 'app-%s.js' % base)
        with open(out, 'w', encoding='utf-8', newline='\n') as f:
            f.write('\n\n'.join(app_parts) + '\n')
        tag = '<script src="/app-%s.js?v=__V__" defer></script>\n' % base
        if '</body>' in html:
            html = html.replace('</body>', tag + '</body>', 1)
        else:
            html = html + tag

    if html != original:
        open(path, 'w', encoding='utf-8', newline='').write(html)
        report.append((name, removed, len(app_parts), has_ads))

print('%-16s %8s %8s %6s' % ('page', 'blocs', 'fichier', 'pub'))
for name, removed, parts, ads in report:
    print('%-16s %8d %8s %6s' % (name, removed, parts == 1, ads))

# Verification: plus aucun script inline executables
bad = []
for name in sorted(os.listdir(WEB)):
    if not name.endswith('.html'):
        continue
    html = open(os.path.join(WEB, name), encoding='utf-8').read()
    for attrs, body in SCRIPT_RE.findall(html):
        if 'src=' not in attrs and 'ld+json' not in attrs and body.strip():
            bad.append(name)
print('\nInlines restants (doit etre vide):', bad or 'AUCUN')
sys.exit(1 if bad else 0)
