#!/bin/sh
# Baut Webseite und statische Demo und veröffentlicht sie im Branch "gh-pages".
# GitHub Pages zeigt sie dann kostenlos unter https://<konto>.github.io/<repo>/ an
# (einmalig aktivieren: Settings → Pages → Branch "gh-pages", Ordner "/ (root)").
# Voraussetzung: Playwright mit Chromium (docs/ENTWICKLUNG.md).
set -eu
cd "$(dirname "$0")/.."
node --disable-warning=ExperimentalWarning tools/build-pages.ts
# Nichts veröffentlichen, was Geheimnisse oder gesperrte Begriffe enthält
bash tools/secret-scan.sh dist/pages
remote="$(git remote get-url origin)"
name="$(git config user.name || echo Demo)"
email="$(git config user.email || echo demo@example.invalid)"
tmp="$(mktemp -d)"
cp -r dist/pages/. "$tmp"
cd "$tmp"
git init -q
git checkout -q -b gh-pages
git add -A
git -c user.name="$name" -c user.email="$email" -c commit.gpgsign=false commit -q -m "Demo vom $(date +%d.%m.%Y)"
git push -q -f "$remote" gh-pages
cd - >/dev/null
rm -rf "$tmp"
echo "Veröffentlicht im Branch gh-pages."
