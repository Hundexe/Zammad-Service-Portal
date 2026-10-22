#!/usr/bin/env bash
# Installation des Service-Portals auf einer VM mit Docker.
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

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*" >&2; }
fail() { printf '\n\033[31mFehler: %s\033[0m\n' "$*" >&2; exit 1; }
SUDO=""; [ "$(id -u)" = "0" ] || SUDO="sudo"

# Frage mit Vorgabe. Ohne Terminal (oder mit --ja) wird die Vorgabe genommen.
ask() {
  local question="$1" def="${2:-}" answer=""
  if [ "$INTERACTIVE" = 1 ]; then
    read -r -p "  $question [${def}]: " answer || true
  fi
  printf '%s' "${answer:-$def}"
}

# Ja/Nein-Frage. Vorgabe j oder n. Rückgabe 0 = ja.
ask_yn() {
  local question="$1" def="$2" answer="" hint="j/N"
  [ "$def" = "j" ] && hint="J/n"
  if [ "$INTERACTIVE" = 1 ]; then
    read -r -p "  $question [$hint]: " answer || true
  fi
  answer="$(printf '%s' "${answer:-$def}" | tr '[:upper:]' '[:lower:]')"
  case "$answer" in j|ja|y|yes) return 0 ;; *) return 1 ;; esac
}

# Setzt KEY=VALUE in .env (ersetzt die vorhandene Zeile oder hängt an).
set_env() {
  local key="$1" value="$2"
  case "$value" in *$'\n'*|*'"'*|*"'"*|*'$'*|*'`'*) fail "Ungültiges Zeichen im Wert für $key" ;; esac
  if grep -q "^${key}=" .env; then
    K="$key" V="$value" awk 'BEGIN { k = ENVIRON["K"]; v = ENVIRON["V"] } index($0, k "=") == 1 { print k "=" v; next } { print }' .env > .env.tmp
    cat .env.tmp > .env && rm -f .env.tmp
  else
    printf '%s=%s\n' "$key" "$value" >> .env
  fi
}

valid_port() { case "$1" in ''|*[!0-9]*) return 1 ;; esac; [ "$1" -ge 1 ] && [ "$1" -le 65535 ]; }

# Ist der Port auf der VM belegt – und zwar nicht von unserem eigenen Caddy?
port_busy() {
  if command -v ss >/dev/null; then
    ss -ltnH "( sport = :$1 )" 2>/dev/null | grep -q . || return 1
  else
    # Ohne ss: Verbindungsversuch auf den Port (erkennt alles, was auf 0.0.0.0 oder localhost lauscht)
    (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null || return 1
  fi
  docker compose port caddy "$1" >/dev/null 2>&1 && return 1
  return 0
}

ask_port() {
  local question="$1" def="$2" fallback="$3" other="${4:-}" p
  if port_busy "$def"; then
    local busy="$def"
    def="$fallback"
    while port_busy "$def" || [ "$def" = "$other" ]; do def=$((def + 1)); done
    note "Port $busy ist auf dieser VM schon belegt – Vorschlag: $def"
  fi
  while true; do
    p="$(ask "$question" "$def")"
    if ! valid_port "$p"; then note "Bitte eine Zahl von 1 bis 65535 eingeben."
    elif [ -n "$other" ] && [ "$p" = "$other" ]; then note "HTTP- und HTTPS-Port müssen verschieden sein."
    elif port_busy "$p"; then note "Port $p ist belegt (sudo ss -ltnp zeigt, wovon)."
    else printf '%s' "$p"; return 0
    fi
    [ "$INTERACTIVE" = 1 ] || fail "Port $p ist nicht nutzbar. In .env HTTPS_PORT bzw. HTTP_PORT ändern."
  done
}

ENTRA_SECRET_NEW=""
configure() {
  local ip host https_port http_port mem_mb profiles=""
  ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  echo
  note "IP-Adresse(n) dieser VM: $(hostname -I 2>/dev/null || echo unbekannt)"
  note "Ohne DNS-Eintrag einfach die IP nehmen. Mit DNS-Eintrag den Namen, z. B. serviceportal.firma.intern."
  host="${PORTAL_HOST:-}"
  if [ -z "$host" ] || [ "$host" = "serviceportal.firma.intern" ]; then host="${ip:-serviceportal.firma.intern}"; fi
  while true; do
    host="$(ask "Hostname oder IP, unter der das Portal erreichbar ist" "$host")"
    case "$host" in ''|*[!A-Za-z0-9.-]*) note "Nur Buchstaben, Ziffern, Punkt und Bindestrich (ohne https:// und ohne Port)." ;; *) break ;; esac
    [ "$INTERACTIVE" = 1 ] || fail "PORTAL_HOST ungültig: $host"
  done

  https_port="$(ask_port "HTTPS-Port (Portal)" "${HTTPS_PORT:-443}" 8443)"
  http_port="$(ask_port "HTTP-Port (leitet nur auf HTTPS weiter)" "${HTTP_PORT:-80}" 8080 "$https_port")"

  mem_mb="$(awk '/MemTotal/ { printf "%d", $2 / 1024 }' /proc/meminfo 2>/dev/null || echo 0)"
  local clam_def="j"; [ "${mem_mb:-0}" -lt 3500 ] && clam_def="n"
  [ "$clam_def" = "n" ] && note "Die VM hat ${mem_mb} MB RAM. Der Virenscanner ClamAV braucht etwa 1,5 GB."
  if ask_yn "Virenscanner (ClamAV) für hochgeladene Dateien verwenden?" "$clam_def"; then
    profiles="clamav"; set_env CLAMAV_REQUIRED true
  else
    set_env CLAMAV_REQUIRED false
  fi
  if ask_yn "Updates aus der Verwaltungsoberfläche ermöglichen (Update-Dienst)?" "n"; then
    profiles="${profiles:+$profiles,}updater"
  fi

  local entra_def="n"; [ -n "${ENTRA_CLIENT_ID:-}" ] && entra_def="n"
  if ask_yn "Microsoft-Anmeldung (Entra ID) jetzt einrichten oder ändern? (geht auch später)" "$entra_def"; then
    local tenant client allowed
    tenant="$(ask "Verzeichnis-ID (Tenant-ID)" "${ENTRA_TENANT_ID:-}")"
    client="$(ask "Anwendungs-ID (Client-ID)" "${ENTRA_CLIENT_ID:-}")"
    allowed="$(ask "Erlaubte Tenant-IDs, Komma-getrennt" "${ENTRA_ALLOWED_TENANTS:-$tenant}")"
    read -r -s -p "  Client-Secret (Eingabe unsichtbar, leer = vorhandenes behalten): " ENTRA_SECRET_NEW || true; echo >&2
    set_env ENTRA_TENANT_ID "$tenant"
    set_env ENTRA_CLIENT_ID "$client"
    set_env ENTRA_ALLOWED_TENANTS "$allowed"
    note "Weiterleitungs-URI für die App-Registrierung: https://${host}$([ "$https_port" = 443 ] || printf ':%s' "$https_port")/api/auth/entra/callback"
  fi

  set_env PORTAL_HOST "$host"
  set_env HTTPS_PORT "$https_port"
  set_env HTTP_PORT "$http_port"
  if [ "$https_port" = "443" ]; then set_env PUBLIC_URL "https://${host}"; else set_env PUBLIC_URL "https://${host}:${https_port}"; fi
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

[ -n "${PORTAL_HOST:-}" ] || fail "PORTAL_HOST fehlt in .env"
case "${PUBLIC_URL:-}" in https://*) ;; *) fail "PUBLIC_URL muss mit https:// beginnen";; esac
HTTPS_PORT="${HTTPS_PORT:-443}"
if [ "$HTTPS_PORT" = "443" ]; then
  [ "${PUBLIC_URL%/}" = "https://${PORTAL_HOST}" ] || fail "PUBLIC_URL muss https://${PORTAL_HOST} sein (passend zu PORTAL_HOST)."
else
  [ "${PUBLIC_URL%/}" = "https://${PORTAL_HOST}:${HTTPS_PORT}" ] || fail "Bei HTTPS_PORT=${HTTPS_PORT} muss PUBLIC_URL https://${PORTAL_HOST}:${HTTPS_PORT} sein."
fi
for p in "$HTTPS_PORT" "${HTTP_PORT:-80}"; do
  port_busy "$p" && fail "Port $p ist auf der VM schon belegt. install.sh erneut starten und andere Ports wählen (z. B. 8443 / 8080)."
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
[ -n "$ADMIN_USER" ] || ADMIN_USER="$(ask "Benutzername des ersten Admins" "admin")"
cli() { docker compose exec -T app /nodejs/bin/node src/server/cli.ts "$@"; }
if cli user:list 2>/dev/null | grep -q "'${ADMIN_USER}'"; then
  note "Benutzer ${ADMIN_USER} gibt es schon – übersprungen."
else
  cli user:create --username "$ADMIN_USER" --name "Portal-Admin" --role Super-Admin
fi
if [ "$INTERACTIVE" = 1 ] && ask_yn "Zusätzlich einen normalen Benutzer (ohne Verwaltungsrechte) mit generiertem Passwort anlegen?" "$([ "$NEW_ENV" = 1 ] && echo j || echo n)"; then
  note "Die E-Mail-Adresse verbindet das Konto mit dem Kunden in Zammad."
  u="$(ask "Benutzername" "test.user")"
  n="$(ask "Name" "Test User")"
  e="$(ask "E-Mail-Adresse" "")"
  if cli user:list 2>/dev/null | grep -q "'${u}'"; then
    note "Benutzer ${u} gibt es schon – übersprungen."
  else
    cli user:create --username "$u" --name "$n" ${e:+--email "$e"}
  fi
fi

say "Fertig"
note "Portal:        ${PUBLIC_URL}"
note "IP dieser VM:  $(hostname -I 2>/dev/null || echo unbekannt)"
case "$PORTAL_HOST" in
  *[!0-9.]*) note "Ohne DNS-Eintrag auf dem eigenen PC in die hosts-Datei eintragen: <IP der VM>  ${PORTAL_HOST}" ;;
esac
note "Die Zertifikatswarnung im Browser verschwindet, sobald das Stammzertifikat verteilt ist (docs/BETRIEB.md)."
note "Einstellungen später ändern: ./install.sh erneut starten oder deploy/.env bearbeiten und 'docker compose up -d'."
note "Weitere Benutzer: docker compose exec app /nodejs/bin/node src/server/cli.ts user:create --username max --name \"Max Muster\" --email max@firma.de"
