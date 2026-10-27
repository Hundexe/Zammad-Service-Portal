#!/usr/bin/env bash
# Neue Version veröffentlichen – auf dem Build-PC mit eigenem SSH-Signaturschlüssel.
#
#   bash tools/release.sh 1.3.0
#
# Ablauf: prüft Arbeitsstand, Version in package.json und CHANGELOG.md, lässt Typprüfung, Tests und
# Secret-Scan laufen, erstellt einen SIGNIERTEN Tag vX.Y.Z, prüft die Signatur gegen deploy/allowed_signers
# und schiebt Commit und Tag. Das GitHub-Release (Text aus dem CHANGELOG) legt das Skript an, wenn die
# GitHub-CLI (gh) angemeldet ist – sonst steht am Ende, was auf der Webseite zu tun ist.
# Nichts davon braucht GitHub Actions.
set -euo pipefail
cd "$(dirname "$0")/.."

V="${1:-}"
[[ "$V" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Aufruf: bash tools/release.sh X.Y.Z" >&2; exit 64; }
TAG="v$V"
die() { echo "Abbruch: $*" >&2; exit 1; }

[ -z "$(git status --porcelain)" ] || die "Arbeitsverzeichnis nicht sauber (git status)"
[ "$(git rev-parse --abbrev-ref HEAD)" = main ] || die "Releases nur von main"
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && die "Tag $TAG gibt es schon"
[ "$(node -p 'require("./package.json").version')" = "$V" ] || die "package.json hat nicht Version $V"
grep -q "^## $V " CHANGELOG.md || die "CHANGELOG.md hat keinen Abschnitt „## $V – Datum“"
[ "$(git config gpg.format)" = ssh ] || die "Signatur nicht eingerichtet: git config gpg.format ssh (siehe docs/UPDATES.md)"
[ -f deploy/allowed_signers ] || die "deploy/allowed_signers fehlt (öffentlicher Signaturschlüssel)"

echo "→ Typprüfung, Tests, Secret-Scan"
npm run -s typecheck
npm test --silent
bash tools/secret-scan.sh

echo "→ Signierter Tag $TAG"
git tag -s "$TAG" -m "Version $V"
git -c gpg.ssh.allowedSignersFile=deploy/allowed_signers verify-tag "$TAG" || { git tag -d "$TAG"; die "Signatur nicht prüfbar – ist der Schlüssel in deploy/allowed_signers?"; }

echo "→ Hochladen"
git push origin main
git push origin "$TAG"

NOTES="$(awk -v v="## $V " 'index($0, v) == 1 { on = 1; next } /^## / && on { exit } on' CHANGELOG.md)"
if command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
  gh release create "$TAG" --verify-tag --title "Version $V" --notes "$NOTES"
  echo "GitHub-Release $TAG angelegt."
else
  echo "GitHub-Release noch anlegen: Repository → Releases → Draft a new release → Tag $TAG → Text aus CHANGELOG.md"
fi
