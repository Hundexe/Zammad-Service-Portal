#!/usr/bin/env bash
# Sucht nach Geheimnissen, bevor etwas veröffentlicht wird (Repository ist öffentlich!).
#
#   sh tools/secret-scan.sh            prüft alle Dateien, die Git verfolgt bzw. verfolgen würde
#   sh tools/secret-scan.sh VERZ …     prüft zusätzlich Verzeichnisse (z. B. dist/pages vor dem Veröffentlichen)
#
# Findet: private Schlüssel, GitHub-/Cloud-/Slack-Tokens, JWTs, Zammad-Tokens, Passwörter in Konfigurationen,
# Base64-Schlüssel, echte E-Mail-Adressen. Bekannte Demo-Werte sind ausdrücklich erlaubt (siehe ALLOW).
# Exit-Code 1 bei Fund.
set -euo pipefail
cd "$(dirname "$0")/.."

PATTERNS=(
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'
  'gh[pousr]_[A-Za-z0-9]{30,}'
  'github_pat_[A-Za-z0-9_]{40,}'
  'AKIA[0-9A-Z]{16}'
  'ASIA[0-9A-Z]{16}'
  'AIza[0-9A-Za-z_-]{35}'
  'xox[abpors]-[0-9A-Za-z-]{10,}'
  'sk-[A-Za-z0-9]{32,}'
  'sk-ant-[A-Za-z0-9_-]{20,}'
  'eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}'
  'Token token=[A-Za-z0-9_-]{20,}'
  '([Ss]ecret|[Tt]oken|[Pp]assword|[Pp]asswort|api_?[Kk]ey)[A-Za-z_]*["'"'"']?[[:space:]]*[:=][[:space:]]*["'"'"'][^"'"'"'[:space:]]{12,}["'"'"']'
  '^[A-Z_]*(SECRET|TOKEN|PASSWORD|API_KEY)[A-Z_]*=[^[:space:]#]{12,}'
  'DefaultEndpointsProtocol=https;AccountName='
  '[A-Za-z0-9+/]{43}='
)
# Erlaubte, bewusst öffentliche Werte (Demo, Tests, Beispiele)
ALLOW='Demo-Admin-Passwort-2026!|Demo-Passwort-2026!|JBSWY3DPEHPK3PXP|test-token|Test-Passwort-123!|Sehr-geheimes-Passwort-42|Kaffeetasse-Fahrrad-Sonnenhut-8|example\.(org|com)|firma\.(de|intern)|AAAAC3Nz|sha256-|integrity=|"sha256"|\.lock|SHASUMS|_FILE=\$|Kaffeetasse-Fahrrad-8|mock-[a-z-]*token'
# Zusätzliche verbotene Begriffe (z. B. Firmen- oder Ortsnamen) stehen NICHT im Repository,
# sondern lokal in .secret-scan-deny (eine Zeile pro Begriff, wird von Git ignoriert) oder in SECRET_SCAN_DENY.
DENY_FILE=.secret-scan-deny
DENY="${SECRET_SCAN_DENY:-}"
if [ -f "$DENY_FILE" ]; then DENY="$(grep -v '^[[:space:]]*\(#\|$\)' "$DENY_FILE" | paste -sd'|' -)${DENY:+|$DENY}"; fi
# Domains, die als E-Mail-Adresse nicht vorkommen dürfen (echte Firmen/Privatadressen). Fiktive Domains sind erlaubt.
EMAIL='[A-Za-z0-9._%+-]+@(?!example\.(org|com)|firma\.(de|intern)|users\.noreply\.github\.com|zammad\.demo|example\.invalid)[A-Za-z0-9.-]+\.[a-z]{2,}'

files() {
  git ls-files --cached --others --exclude-standard
  for d in "$@"; do find "$d" -type f; done
}

found=0
while IFS= read -r f; do
  [ -f "$f" ] || continue
  case "$f" in *.png|*.woff|*.woff2|*.ico|*.jpg|*.gif|*.mp4|tools/secret-scan.sh) continue ;; esac
  for p in "${PATTERNS[@]}"; do
    if hits="$(grep -nE -- "$p" "$f" 2>/dev/null | grep -vE -- "$ALLOW" || true)" && [ -n "$hits" ]; then
      printf '\033[31m%s\033[0m\n%s\n' "$f (Muster: $p)" "$(printf '%s\n' "$hits" | cut -c1-200 | head -5)"
      found=1
    fi
  done
  if [ -n "$DENY" ] && hits="$(grep -niE -- "$DENY" "$f" 2>/dev/null || true)" && [ -n "$hits" ]; then
    printf '\033[31m%s\033[0m\n%s\n' "$f (verbotener Begriff)" "$(printf '%s\n' "$hits" | cut -c1-200 | head -5)"
    found=1
  fi
  if command -v grep >/dev/null && grep -qP '' /dev/null 2>/dev/null; then
    if hits="$(grep -nP -- "$EMAIL" "$f" 2>/dev/null || true)" && [ -n "$hits" ]; then
      printf '\033[31m%s\033[0m\n%s\n' "$f (E-Mail-Adresse)" "$(printf '%s\n' "$hits" | cut -c1-200 | head -5)"
      found=1
    fi
  fi
done < <(files "$@")

if [ "$found" = 1 ]; then
  echo "Mögliche Geheimnisse gefunden – NICHT veröffentlichen, erst prüfen." >&2
  exit 1
fi
echo "Secret-Scan: keine Funde."
