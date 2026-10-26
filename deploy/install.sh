#!/usr/bin/env bash
# Installation des Service-Portals mit Docker Compose (Variante ohne Docker: deploy/native/install.sh).
#
# Aufruf (im Verzeichnis deploy/):
#   ./install.sh              fragt Hostname/IP, Ports, Virenscanner, Updates, Microsoft-Anmeldung
#                             und Benutzer ab und schreibt alles in deploy/.env
#   ./install.sh --ja         ohne Rückfragen, nimmt die Werte aus deploy/.env (für Automatisierung)
#   ./install.sh [--ja] NAME  Benutzername des ersten Admins (Standard: admin)
#
# Erneut ausführen ist gefahrlos: vorhandene Einstellungen, Schlüssel und Benutzer bleiben erhalten.
set -euo pipefail
cd "$(dirname "$0")"

APP_UID=65532
ADMIN_USER=""
INTERACTIVE=1
[ -t 0 ] || INTERACTIVE=0
[ "${INSTALL_INTERACTIVE:-}" = 1 ] && INTERACTIVE=1   # erzwingt Rückfragen (z. B. für Tests mit Eingabe über stdin)
for arg in "$@"; do
  case "$arg" in
    -y|--ja|--yes) INTERACTIVE=0 ;;
    -h|--hilfe|--help) sed -n '2,10p' "$0"; exit 0 ;;
    -*) echo "Unbekannte Option: $arg" >&2; exit 2 ;;
    *) ADMIN_USER="$arg" ;;
  esac
done

ENV_FILE=.env
# shellcheck source=lib.sh
. ./lib.sh
SUDO=""; [ "$(id -u)" = "0" ] || SUDO="sudo"

# Belegt unser eigener Caddy-Container den Port? Dann ist er nicht "belegt".
port_is_ours() { docker compose port caddy "$1" >/dev/null 2>&1; }

configure() {
  local profiles=""
  configure_common
  [ "$WANT_CLAMAV" = 1 ] && profiles="clamav"
  if ask_yn "Updates aus der Verwaltungsoberfläche ermöglichen (Update-Dienst)?" "n"; then
    profiles="${profiles:+$profiles,}updater"
  fi
  set_env COMPOSE_PROFILES "$profiles"
  set_env PORTAL_DIR "$(cd .. && pwd)"
}

say "1/6 Voraussetzungen prüfen"
command -v docker >/dev/null || fail "Docker ist nicht installiert."
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 fehlt (Paket docker-compose-plugin)."
docker info >/dev/null 2>&1 || fail "Kein Zugriff auf Docker. Benutzer in die Gruppe 'docker' aufnehmen oder mit sudo starten."
command -v openssl >/dev/null || fail "openssl fehlt."
note "ok"

say "2/6 Konfiguration (deploy/.env)"
NEW_ENV=0
if [ ! -f .env ]; then
  cp .env.example .env
  chmod 600 .env
  NEW_ENV=1
  [ "$INTERACTIVE" = 1 ] || fail "deploy/.env wurde aus .env.example erzeugt. Bitte PORTAL_HOST, PUBLIC_URL, HTTPS_PORT eintragen und install.sh erneut starten (oder ohne --ja für Rückfragen)."
fi
# shellcheck disable=SC1091
set -a; . ./.env; set +a
if [ "$NEW_ENV" = 1 ]; then
  configure
elif [ "$INTERACTIVE" = 1 ]; then
  note "Aktuell: ${PUBLIC_URL:-?}  (Profile: ${COMPOSE_PROFILES:-keine})"
  if ask_yn "Einstellungen (Hostname/IP, Ports, Virenscanner, Updates, Microsoft) ändern?" "n"; then configure; fi
fi
# shellcheck disable=SC1091
set -a; . ./.env; set +a

check_urls
HTTPS_PORT="${HTTPS_PORT:-443}"
for p in "$HTTPS_PORT" "${HTTP_PORT:-80}"; do
  port_busy "$p" && fail "Port $p ist auf diesem Server schon belegt. install.sh erneut starten und andere Ports wählen (z. B. 8443 / 8080)."
done
[ "$(cd .. && pwd)" = "${PORTAL_DIR:-}" ] || note "Hinweis: PORTAL_DIR in .env (${PORTAL_DIR:-}) ist nicht dieses Verzeichnis ($(cd .. && pwd)). Für Updates aus der Oberfläche anpassen."
note "Portal-Adresse: ${PUBLIC_URL}"

say "3/6 Geheimnisse"
mkdir -p secrets certs
chmod 700 secrets
if [ ! -s secrets/secret_key ]; then
  openssl rand -base64 32 > secrets/secret_key
  note "Neuer Hauptschlüssel erzeugt: deploy/secrets/secret_key – bitte zusätzlich sicher aufbewahren (Passwort-Tresor)."
fi
if [ -n "$ENTRA_SECRET_NEW" ]; then
  tmp="$(mktemp secrets/.entra.XXXXXX)"
  printf '%s' "$ENTRA_SECRET_NEW" > "$tmp"
  mv -f "$tmp" secrets/entra_client_secret
  ENTRA_SECRET_NEW=""
  note "Client-Secret gespeichert (deploy/secrets/entra_client_secret)."
elif [ ! -f secrets/entra_client_secret ]; then
  : > secrets/entra_client_secret
fi
if [ -n "${ENTRA_CLIENT_ID:-}" ] && ! $SUDO test -s secrets/entra_client_secret; then
  fail "ENTRA_CLIENT_ID ist gesetzt, aber das Client-Secret fehlt. install.sh erneut starten und das Secret eingeben – oder ENTRA_* vorerst leer lassen."
fi
# Die App läuft im Container als Benutzer $APP_UID und muss die Dateien lesen können.
$SUDO chown "$APP_UID:$APP_UID" secrets/secret_key secrets/entra_client_secret
$SUDO chmod 400 secrets/secret_key secrets/entra_client_secret

if [[ ",${COMPOSE_PROFILES:-}," == *",updater,"* ]] && [ "${UPDATE_SOURCE:-git}" = "git" ]; then
  if git -C .. remote get-url origin 2>/dev/null | grep -q '^git@' && [ ! -f secrets/deploy_key ]; then
    note "Hinweis: secrets/deploy_key fehlt – bei einem per SSH geklonten (privaten) Repository kann der Updater ohne Deploy-Key keine neuen Versionen holen (docs/UPDATES.md)."
  fi
  [ -f known_hosts ] || ssh-keyscan -t ed25519 github.com > known_hosts 2>/dev/null || true
  if [ "${UPDATE_REQUIRE_SIGNED_TAGS:-true}" = "true" ] && [ ! -f allowed_signers ]; then
    note "Hinweis: deploy/allowed_signers fehlt – signierte Updates können erst danach installiert werden (docs/UPDATES.md)."
  fi
fi

say "4/6 Images bauen (beim ersten Mal einige Minuten)"
docker compose build

say "5/6 Starten"
docker compose up -d --remove-orphans
printf '  Warte auf das Portal '
ready=0
for _ in $(seq 1 60); do
  if [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q app)" 2>/dev/null)" = "healthy" ]; then ready=1; echo ' bereit.'; break; fi
  printf '.'; sleep 3
done
[ "$ready" = 1 ] || fail "Das Portal startet nicht. Ursache steht in: docker compose logs app"

say "6/6 Benutzer"
cli() { docker compose exec -T app /nodejs/bin/node src/server/cli.ts "$@"; }
create_users "$ADMIN_USER" "$NEW_ENV"

say "Fertig"
note "Portal:        ${PUBLIC_URL}"
note "IP-Adresse:    $(hostname -I 2>/dev/null || echo unbekannt)"
case "$PORTAL_HOST" in
  *[!0-9.]*) note "Ohne DNS-Eintrag auf dem eigenen PC in die hosts-Datei eintragen: <IP des Servers>  ${PORTAL_HOST}" ;;
esac
note "Die Zertifikatswarnung im Browser verschwindet, sobald das Stammzertifikat verteilt ist (docs/BETRIEB.md)."
note "Einstellungen später ändern: ./install.sh erneut starten oder deploy/.env bearbeiten und 'docker compose up -d'."
note "Weitere Benutzer: docker compose exec app /nodejs/bin/node src/server/cli.ts user:create --username max --name \"Max Muster\" --email max@firma.de"
