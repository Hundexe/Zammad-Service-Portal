#!/usr/bin/env bash
# Erstinstallation des Service-Portals auf einer VM mit Docker.
# Aufruf (im Verzeichnis deploy/):  ./install.sh [Benutzername-des-ersten-Admins]
set -euo pipefail
cd "$(dirname "$0")"

ADMIN_USER="${1:-admin}"
APP_UID=65532

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\n\033[31mFehler: %s\033[0m\n' "$*" >&2; exit 1; }

say "1/6 Voraussetzungen prüfen"
command -v docker >/dev/null || fail "Docker ist nicht installiert."
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 fehlt (Paket docker-compose-plugin)."
docker info >/dev/null 2>&1 || fail "Kein Zugriff auf Docker. Benutzer in die Gruppe 'docker' aufnehmen oder mit sudo starten."
command -v openssl >/dev/null || fail "openssl fehlt."

say "2/6 Konfiguration"
if [ ! -f .env ]; then
  cp .env.example .env
  chmod 600 .env
  fail "deploy/.env wurde aus .env.example erzeugt. Bitte PORTAL_HOST, PUBLIC_URL und ENTRA_* eintragen und install.sh erneut starten."
fi
# shellcheck disable=SC1091
set -a; . ./.env; set +a
[ -n "${PORTAL_HOST:-}" ] || fail "PORTAL_HOST fehlt in .env"
case "${PUBLIC_URL:-}" in https://*) ;; *) fail "PUBLIC_URL muss mit https:// beginnen";; esac
HTTPS_PORT="${HTTPS_PORT:-443}"
if [ "$HTTPS_PORT" = "443" ]; then
  [ "${PUBLIC_URL%/}" = "https://${PORTAL_HOST}" ] || fail "PUBLIC_URL muss https://${PORTAL_HOST} sein (passend zu PORTAL_HOST)."
else
  [ "${PUBLIC_URL%/}" = "https://${PORTAL_HOST}:${HTTPS_PORT}" ] || fail "Bei HTTPS_PORT=${HTTPS_PORT} muss PUBLIC_URL https://${PORTAL_HOST}:${HTTPS_PORT} sein."
fi
for p in "$HTTPS_PORT" "${HTTP_PORT:-80}"; do
  if command -v ss >/dev/null && ss -ltnH "( sport = :$p )" 2>/dev/null | grep -q . && ! docker compose ps -q caddy 2>/dev/null | grep -q .; then
    fail "Port $p ist auf der VM schon belegt. In .env HTTPS_PORT bzw. HTTP_PORT ändern (z. B. 8443 / 8080)."
  fi
done
[ "$(cd .. && pwd)" = "${PORTAL_DIR:-}" ] || echo "Hinweis: PORTAL_DIR in .env ($PORTAL_DIR) ist nicht dieses Verzeichnis ($(cd .. && pwd)). Für Updates aus der Oberfläche anpassen."

say "3/6 Geheimnisse"
mkdir -p secrets certs
chmod 700 secrets
if [ ! -s secrets/secret_key ]; then
  openssl rand -base64 32 > secrets/secret_key
  echo "Neuer Hauptschlüssel erzeugt: deploy/secrets/secret_key – bitte zusätzlich sicher aufbewahren (Passwort-Tresor)."
fi
if [ ! -f secrets/entra_client_secret ]; then
  : > secrets/entra_client_secret
  echo "Leere Datei secrets/entra_client_secret angelegt – Client-Secret aus Entra ID eintragen (siehe docs/INSTALLATION.md)."
fi
if [ -n "${ENTRA_CLIENT_ID:-}" ] && [ ! -s secrets/entra_client_secret ]; then
  fail "ENTRA_CLIENT_ID ist gesetzt, aber secrets/entra_client_secret ist leer. Client-Secret eintragen oder ENTRA_* vorerst leer lassen."
fi
# Die App läuft im Container als Benutzer $APP_UID und muss die Dateien lesen können.
if [ "$(id -u)" = "0" ]; then
  chown "$APP_UID:$APP_UID" secrets/secret_key secrets/entra_client_secret
else
  sudo chown "$APP_UID:$APP_UID" secrets/secret_key secrets/entra_client_secret
fi
chmod 400 secrets/secret_key secrets/entra_client_secret

if [[ ",${COMPOSE_PROFILES:-}," == *",updater,"* ]] && [ "${UPDATE_SOURCE:-git}" = "git" ]; then
  if git -C .. remote get-url origin 2>/dev/null | grep -q '^git@' && [ ! -f secrets/deploy_key ]; then
    echo "Hinweis: secrets/deploy_key fehlt – bei einem per SSH geklonten (privaten) Repository kann der Updater ohne Deploy-Key keine neuen Versionen holen (docs/UPDATES.md)."
  fi
  [ -f known_hosts ] || ssh-keyscan -t ed25519 github.com > known_hosts 2>/dev/null || true
  if [ "${UPDATE_REQUIRE_SIGNED_TAGS:-true}" = "true" ] && [ ! -f allowed_signers ]; then
    echo "Hinweis: deploy/allowed_signers fehlt – signierte Updates können erst danach installiert werden (docs/UPDATES.md)."
  fi
fi

say "4/6 Images bauen"
docker compose build

say "5/6 Starten"
docker compose up -d
printf 'Warte auf das Portal '
for _ in $(seq 1 60); do
  if [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q app)" 2>/dev/null)" = "healthy" ]; then echo ' bereit.'; break; fi
  printf '.'; sleep 3
done

say "6/6 Ersten Admin anlegen"
if docker compose exec -T app /nodejs/bin/node src/server/cli.ts user:list 2>/dev/null | grep -q "'${ADMIN_USER}'"; then
  echo "Benutzer ${ADMIN_USER} gibt es schon – übersprungen."
else
  docker compose exec -T app /nodejs/bin/node src/server/cli.ts user:create --username "$ADMIN_USER" --name "Portal-Admin" --role Super-Admin
fi

say "Fertig"
echo "Portal: ${PUBLIC_URL}"
echo "IP-Adressen dieser VM: $(hostname -I 2>/dev/null || echo unbekannt)"
case "$PORTAL_HOST" in
  *[!0-9.]*) echo "Ohne DNS-Eintrag auf dem eigenen PC in die hosts-Datei: <IP der VM>  ${PORTAL_HOST}";;
esac
echo "Weitere Benutzer mit generiertem Passwort:"
echo "  docker compose exec app /nodejs/bin/node src/server/cli.ts user:create --username max --name \"Max Muster\" --email max@firma.de"
