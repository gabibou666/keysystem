#!/usr/bin/env python3
"""Auto-heberge les polices Google Fonts (fin de la chaine bloquante + RGPD).

- telecharge les woff2 "latin" des polices utilisees par le site,
- les enregistre dans web/fonts/,
- regenere le bloc @font-face en tete de web/style.css (remplace l'@import).

RGPD/CNIL: charger fonts.googleapis.com transmet l'IP du visiteur a Google sans
consentement prealable. En auto-hebergeant, la police vient de notre domaine.
Performance: supprime deux connexions DNS/TLS bloquantes (googleapis + gstatic).
"""
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.normpath(os.path.join(HERE, '..', '..', 'web'))
FONT_DIR = os.path.join(WEB, 'fonts')

# Familles VARIABLES (un seul fichier couvre tous les graisses utilisees:
# Plus Jakarta Sans 300-800 et JetBrains Mono 400-600).
FAMILIES = [
    ('Plus Jakarta Sans', 'Plus+Jakarta+Sans:wght@200..800', 'plus-jakarta-sans'),
    ('JetBrains Mono', 'JetBrains+Mono:wght@100..800', 'jetbrains-mono'),
]

UA = (
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
)


def curl(url, binary=False):
    out = subprocess.run(
        ['curl', '-sSL', '-m', '60', '-A', UA, url],
        capture_output=True,
        check=True,
    ).stdout
    return out if binary else out.decode('utf-8')


def main():
    os.makedirs(FONT_DIR, exist_ok=True)
    faces = []

    for label, query, slug in FAMILIES:
        css = curl(f'https://fonts.googleapis.com/css2?family={query}&display=swap')
        # Ne garder que les blocs precedes du commentaire /* latin */
        blocks = re.findall(r'/\*\s*([a-z0-9-]+)\s*\*/\s*@font-face\s*\{(.*?)\}', css, re.S)
        kept = [(subset, body) for subset, body in blocks if subset == 'latin']
        if not kept:
            print(f'!! aucun bloc latin pour {label}', file=sys.stderr)
            sys.exit(1)

        for subset, body in kept:
            src = re.search(r'url\((https://[^)]+\.woff2)\)', body)
            if not src:
                continue
            url = src.group(1)
            filename = f'{slug}-{subset}.woff2'
            dest = os.path.join(FONT_DIR, filename)
            data = curl(url, binary=True)
            with open(dest, 'wb') as f:
                f.write(data)
            rng = re.search(r'unicode-range:\s*([^;]+);', body)
            faces.append(
                '@font-face {\n'
                f"  font-family: '{label}';\n"
                '  font-style: normal;\n'
                '  font-weight: 200 800;\n'
                '  font-display: swap;\n'
                f"  src: url('/fonts/{filename}') format('woff2');\n"
                + (f'  unicode-range: {rng.group(1).strip()};\n' if rng else '')
                + '}'
            )
            print(f'{label:20} {subset:6} {len(data) / 1024:6.1f} Ko  -> /fonts/{filename}')

    css_path = os.path.join(WEB, 'style.css')
    css = open(css_path, encoding='utf-8').read()
    header = (
        '/* ============================================================\n'
        '   POLICES AUTO-HEBERGEES (genere par scripts/selfhost-fonts.py)\n'
        '   - plus aucun appel a fonts.googleapis.com / fonts.gstatic.com\n'
        '     (RGPD/CNIL: aucune IP visiteur transmise a Google)\n'
        '   - suppression d une chaine bloquante de 2 requetes\n'
        '   ============================================================ */\n'
        + '\n'.join(faces)
        + '\n\n'
    )

    # Remplace l'@import Google Fonts s'il est encore present, sinon insere en tete
    css = re.sub(r"^@import url\('https://fonts\.googleapis\.com[^']*'\);\s*", '', css)
    if 'POLICES AUTO-HEBERGEES' in css:
        css = re.sub(r'/\* =+\n   POLICES AUTO-HEBERGEES.*?\*/\n(?:@font-face \{[^}]*\}\n)+',
                     header.rstrip('\n') + '\n\n', css, flags=re.S)
    else:
        css = header + css
    open(css_path, 'w', encoding='utf-8', newline='').write(css)
    print('\nstyle.css mis a jour: @import supprime, @font-face auto-heberges ajoutes.')


if __name__ == '__main__':
    main()
