#!/usr/bin/env bash
# Installation des Service-Portals direkt auf Debian/Ubuntu – ohne Docker.
#
# Aufruf (als root, im Repository):
#   deploy/native/install.sh              fragt Hostname/IP, Ports, Virenscanner, Microsoft-Anmeldung
#                                         und Benutzer ab
#   deploy/native/install.sh --ja         ohne Rückfragen (Werte aus der Konfigurationsdatei)
#   deploy/native/install.sh [--ja] NAME  Benutzername des ersten Admins (Standard: admin)
#
# Ergebnis:
#   Code              /opt/zammad-service-portal            (dieses Repository)
#   Node.js           /opt/zammad-service-portal-node       (offizielles Paket von nodejs.org, Prüfsumme geprüft)
#   Konfiguration     /etc/zammad-service-portal/portal.env (die eine Datei mit allen Einstellungen)
#   Geheimnisse       /etc/zammad-service-portal/secrets/
#   Daten             /var/lib/zammad-service-portal         (SQLite-Datenbank, Uploads)
#   Dienste           zammad-service-portal, zammad-service-portal-worker (systemd, Benutzer "zsp")
#   Reverse Proxy     Caddy (TLS, Weiterleitung HTTP → HTTPS)
#   Virenscanner      clamav-daemon (optional)
#   Kommandozeile     service-portal-cli user:create … (wie "cli.ts" im Docker-Betrieb)
#
# Erneut ausführen = aktualisieren: baut neu, startet neu, Einstellungen und Daten bleiben.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
NODE_DIR="${NODE_DIR:-/opt/zammad-service-portal-node}"
NODE_MAJOR=24
CONF_DIR=/etc/zammad-service-portal
ENV_FILE="$CONF_DIR/portal.env"
DATA_DIR=/var/lib/zammad-service-portal
SVC_USER=zsp
UNIT=zammad-service-portal
APP_PORT=3000

ADMIN_USER=""
INTERACTIVE=1
[ -t 0 ] || INTERACTIVE=0
[ "${INSTALL_INTERACTIVE:-}" = 1 ] && INTERACTIVE=1
for arg in "$@"; do
  case "$arg" in
    -y|--ja|--yes) INTERACTIVE=0 ;;
    -h|--hilfe|--help) sed -n '2,22p' "$0"; exit 0 ;;
    -*) echo "Unbekannte Option: $arg" >&2; exit 2 ;;
    *) ADMIN_USER="$arg" ;;
  esac
done

# shellcheck source=../lib.sh
. "$REPO_DIR/deploy/lib.sh"

# Belegt unser eigener Caddy den Port? Dann gilt er nicht als belegt.
port_is_ours() {
  if command -v ss >/dev/null; then ss -ltnpH "( sport = :$1 )" 2>/dev/null | grep -q '"caddy"'
  else grep -q ":$1 {" /etc/caddy/zammad-service-portal.caddy 2>/dev/null
  fi
}

apt_install() { DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "$@" >/dev/null; }

# ---------------------------------------------------------------- 1. Voraussetzungen
say "1/7 Voraussetzungen prüfen"
[ "$(id -u)" = 0 ] || fail "Bitte als root starten (sudo)."
command -v apt-get >/dev/null || fail "Die Installation ohne Docker unterstützt Debian und Ubuntu (apt). Für andere Systeme bitte Docker verwenden."
command -v systemctl >/dev/null && [ -d /run/systemd/system ] || fail "systemd wird benötigt."
note "Pakete installieren (curl, git, openssl, xz-utils, iproute2, ca-certificates, gnupg) …"
DEBIAN_FRONTEND=noninteractive apt-get update -qq
apt_install ca-certificates curl git openssl xz-utils iproute2 gnupg debian-keyring debian-archive-keyring apt-transport-https || \
  apt_install ca-certificates curl git openssl xz-utils iproute2 gnupg
note "ok"

# ---------------------------------------------------------------- 2. Konfiguration
say "2/7 Konfiguration ($ENV_FILE)"
install -d -m 755 "$CONF_DIR"
NEW_ENV=0
if [ ! -f "$ENV_FILE" ]; then
  cp "$REPO_DIR/deploy/.env.example" "$ENV_FILE"
  cat >> "$ENV_FILE" <<EOF

# ================================================================ Nur Installation ohne Docker
# (vom Installationsskript gesetzt – normalerweise nicht ändern)
NODE_ENV=production
HOST=127.0.0.1
PORT=$APP_PORT
DATA_DIR=$DATA_DIR
SECRET_KEY_FILE=$CONF_DIR/secrets/secret_key
ENTRA_CLIENT_SECRET_FILE=$CONF_DIR/secrets/entra_client_secret
TRUST_PROXY_CIDRS=127.0.0.1/32,::1/128
ALLOW_PRIVATE_TICKET_URLS=true
CLAMAV_HOST=
CLAMAV_PORT=3310
EOF
  # Docker-spezifische Zeilen haben hier keine Bedeutung; die Version kommt aus package.json
  for k in APP_VERSION COMPOSE_PROJECT_NAME COMPOSE_PROFILES BIND_ADDRESS UPDATE_SOURCE UPDATE_REQUIRE_SIGNED_TAGS REGISTRY_IMAGE PROXY_NET_CIDR PROXY_IP PROXY_NET_DYNAMIC; do del_env "$k"; done
  set_env PORTAL_DIR "$REPO_DIR"
  NEW_ENV=1
fi
# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a
WANT_CLAMAV=0; [ -n "${CLAMAV_HOST:-}" ] && WANT_CLAMAV=1
if [ "$NEW_ENV" = 1 ]; then
  if [ "$INTERACTIVE" = 1 ]; then
    configure_common
  else
    # Ohne Rückfragen: IP des Servers, freie Ports, Virenscanner je nach RAM
    ip="$(hostname -I | awk '{print $1}')"
    hp=443; port_busy 443 && hp=8443
    p80=80; port_busy 80 && p80=8080
    set_env PORTAL_HOST "$ip"; set_env HTTPS_PORT "$hp"; set_env HTTP_PORT "$p80"
    if [ "$hp" = 443 ]; then set_env PUBLIC_URL "https://$ip"; else set_env PUBLIC_URL "https://$ip:$hp"; fi
    mem_mb="$(awk '/MemTotal/ { printf "%d", $2 / 1024 }' /proc/meminfo)"
    if [ "$mem_mb" -ge 3500 ]; then WANT_CLAMAV=1; set_env CLAMAV_REQUIRED true; else set_env CLAMAV_REQUIRED false; fi
  fi
elif [ "$INTERACTIVE" = 1 ]; then
  note "Aktuell: ${PUBLIC_URL:-?}  (Virenscanner: $([ "$WANT_CLAMAV" = 1 ] && echo ja || echo nein))"
  if ask_yn "Einstellungen (Hostname/IP, Ports, Virenscanner, Microsoft) ändern?" "n"; then configure_common; fi
fi
if [ "$WANT_CLAMAV" = 1 ]; then set_env CLAMAV_HOST 127.0.0.1; else set_env CLAMAV_HOST ""; fi
# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a
check_urls
for p in "${HTTPS_PORT:-443}" "${HTTP_PORT:-80}"; do
  port_busy "$p" && fail "Port $p ist auf diesem Server schon belegt. Installation erneut starten und andere Ports wählen (z. B. 8443 / 8080)."
done
port_busy "$APP_PORT" && ! systemctl is-active --quiet "$UNIT" && fail "Port $APP_PORT (intern für die App) ist belegt."
note "Portal-Adresse: ${PUBLIC_URL}"

# ---------------------------------------------------------------- 3. Node.js
say "3/7 Node.js $NODE_MAJOR"
case "$(uname -m)" in x86_64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) fail "Prozessor $(uname -m) wird nicht unterstützt." ;; esac
current="$("$NODE_DIR/bin/node" -v 2>/dev/null || true)"
if [[ "$current" == v${NODE_MAJOR}.* ]] && [ "${NODE_UPDATE:-0}" != 1 ]; then
  note "vorhanden: $current"
else
  tmp="$(mktemp -d)"
  base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt" || fail "nodejs.org nicht erreichbar."
  file="$(awk -v a="linux-${arch}.tar.xz" '$2 ~ a"$" { print $2; exit }' "$tmp/SHASUMS256.txt")"
  [ -n "$file" ] || fail "Kein Node.js-Paket für linux-${arch} gefunden."
  note "lade $file …"
  curl -fsSL "$base/$file" -o "$tmp/$file"
  (cd "$tmp" && grep " $file\$" SHASUMS256.txt | sha256sum -c --quiet -) || fail "Prüfsumme von Node.js stimmt nicht – Abbruch."
  mkdir -p "$tmp/node" && tar -xJf "$tmp/$file" -C "$tmp/node" --strip-components=1
  rm -rf "$NODE_DIR.new" && mv "$tmp/node" "$NODE_DIR.new"
  rm -rf "$NODE_DIR" && mv "$NODE_DIR.new" "$NODE_DIR"
  chmod -R a+rX "$NODE_DIR"
  rm -rf "$tmp"
  note "installiert: $("$NODE_DIR/bin/node" -v)"
fi
NODE="$NODE_DIR/bin/node"

# ---------------------------------------------------------------- 4. Benutzer, Geheimnisse, Build
say "4/7 Dienstbenutzer, Geheimnisse, Build"
id "$SVC_USER" >/dev/null 2>&1 || useradd --system --home-dir "$DATA_DIR" --no-create-home --shell /usr/sbin/nologin "$SVC_USER"
install -d -m 700 -o "$SVC_USER" -g "$SVC_USER" "$DATA_DIR"
install -d -m 700 -o "$SVC_USER" -g "$SVC_USER" "$CONF_DIR/secrets"
chown root:"$SVC_USER" "$ENV_FILE" && chmod 640 "$ENV_FILE"
if [ ! -s "$CONF_DIR/secrets/secret_key" ]; then
  openssl rand -base64 32 > "$CONF_DIR/secrets/secret_key"
  note "Neuer Hauptschlüssel: $CONF_DIR/secrets/secret_key – bitte zusätzlich sicher aufbewahren (Passwort-Tresor)."
fi
if [ -n "$ENTRA_SECRET_NEW" ]; then
  printf '%s' "$ENTRA_SECRET_NEW" > "$CONF_DIR/secrets/entra_client_secret"; ENTRA_SECRET_NEW=""
  note "Client-Secret gespeichert."
fi
[ -f "$CONF_DIR/secrets/entra_client_secret" ] || : > "$CONF_DIR/secrets/entra_client_secret"
if [ -n "${ENTRA_CLIENT_ID:-}" ] && [ ! -s "$CONF_DIR/secrets/entra_client_secret" ]; then
  fail "ENTRA_CLIENT_ID ist gesetzt, aber das Client-Secret fehlt. Installation erneut starten und das Secret eingeben – oder ENTRA_* leer lassen."
fi
chown "$SVC_USER:$SVC_USER" "$CONF_DIR"/secrets/*
chmod 400 "$CONF_DIR"/secrets/*
(cd "$REPO_DIR" && umask 022 && "$NODE" --disable-warning=ExperimentalWarning tools/build-web.ts >/dev/null) || fail "Build der Oberfläche fehlgeschlagen."

# Kommandozeile für die Verwaltung (Benutzer anlegen, Passwort zurücksetzen, Backup …)
cat > /usr/local/bin/service-portal-cli <<EOF
#!/bin/sh
# Verwaltungsbefehle des Service-Portals, z. B.: service-portal-cli user:create --username max --email max@firma.de
set -a; . $ENV_FILE; set +a
cd $REPO_DIR
exec runuser -u $SVC_USER -- $NODE --disable-warning=ExperimentalWarning src/server/cli.ts "\$@"
EOF
chmod 750 /usr/local/bin/service-portal-cli

# ---------------------------------------------------------------- 5. Dienste
say "5/7 Dienste (systemd)"
unit() {
  local name="$1" desc="$2" cmd="$3"
  cat > "/etc/systemd/system/$name.service" <<EOF
[Unit]
Description=$desc
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SVC_USER
Group=$SVC_USER
EnvironmentFile=$ENV_FILE
Environment=NODE_OPTIONS=--disable-warning=ExperimentalWarning
WorkingDirectory=$REPO_DIR
ExecStart=$NODE src/server/cli.ts $cmd
Restart=on-failure
RestartSec=3
UMask=0077
MemoryMax=512M
# Härtung: nur Lesezugriff aufs System, Schreiben nur im Datenverzeichnis
NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=$DATA_DIR
ProtectHome=read-only
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
CapabilityBoundingSet=
AmbientCapabilities=
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallFilter=~@privileged
# Nicht erlaubte Aufrufe schlagen fehl statt den Prozess zu beenden (Node fällt z. B. von io_uring zurück)
SystemCallErrorNumber=EPERM

[Install]
WantedBy=multi-user.target
EOF
}
unit "$UNIT" "Service-Portal für Zammad (Web)" serve
unit "$UNIT-worker" "Service-Portal für Zammad (Zustellung an Zammad)" worker
systemctl daemon-reload
systemctl enable --quiet "$UNIT" "$UNIT-worker"
systemctl restart "$UNIT"
printf '  Warte auf das Portal '
ready=0
for _ in $(seq 1 40); do
  if curl -fs "http://127.0.0.1:$APP_PORT/readyz" >/dev/null 2>&1; then ready=1; echo ' bereit.'; break; fi
  printf '.'; sleep 1
done
[ "$ready" = 1 ] || fail "Das Portal startet nicht. Ursache: journalctl -u $UNIT -n 50"
systemctl restart "$UNIT-worker"

# ---------------------------------------------------------------- 6. Virenscanner und Caddy
say "6/7 Virenscanner und Reverse Proxy"
if [ "$WANT_CLAMAV" = 1 ]; then
  if ! dpkg -s clamav-daemon >/dev/null 2>&1; then
    note "installiere ClamAV (Signaturen werden im Hintergrund geladen) …"
    apt_install clamav-daemon clamav-freshclam
  fi
  conf=/etc/clamav/clamd.conf
  grep -q '^TCPSocket' "$conf" || printf 'TCPSocket 3310\n' >> "$conf"
  grep -q '^TCPAddr' "$conf" || printf 'TCPAddr 127.0.0.1\n' >> "$conf"
  systemctl enable --quiet clamav-freshclam clamav-daemon 2>/dev/null || true
  systemctl restart clamav-freshclam 2>/dev/null || true
  systemctl restart clamav-daemon 2>/dev/null || note "ClamAV startet, sobald die Signaturen geladen sind (einige Minuten)."
fi

if ! command -v caddy >/dev/null; then
  note "installiere Caddy …"
  if curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg 2>/dev/null \
     && curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt -o /etc/apt/sources.list.d/caddy-stable.list; then
    chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
    DEBIAN_FRONTEND=noninteractive apt-get update -qq
  fi
  apt_install caddy || fail "Caddy konnte nicht installiert werden."
fi
site=/etc/caddy/zammad-service-portal.caddy
cp "$REPO_DIR/deploy/caddy/security-headers.caddy" /etc/caddy/zammad-service-portal-headers.caddy
cat > "$site" <<EOF
# Service-Portal für Zammad – erzeugt von deploy/native/install.sh (wird bei jedem Lauf neu geschrieben)
http://${PORTAL_HOST}:${HTTP_PORT:-80} {
	redir https://${PORTAL_HOST}:${HTTPS_PORT:-443}{uri} 308
}

${PORTAL_HOST}:${HTTPS_PORT:-443} {
	# Interne CA von Caddy. Mit Firmenzertifikat stattdessen:
	#   tls $CONF_DIR/certs/portal.crt $CONF_DIR/certs/portal.key
	tls internal
	import /etc/caddy/zammad-service-portal-headers.caddy
	@hidden path /.* */.*
	respond @hidden 404
	reverse_proxy 127.0.0.1:$APP_PORT {
		header_up -X-Forwarded-Host
		transport http {
			read_timeout 120s
		}
	}
}
EOF
caddyfile=/etc/caddy/Caddyfile
if [ ! -s "$caddyfile" ] || grep -q 'The Caddyfile is an easy way' "$caddyfile" || grep -qi 'erzeugt von deploy/native/install.sh' "$caddyfile"; then
  # Standard-Caddyfile (Begrüßungsseite) ersetzen – Caddy gehört dann dem Portal
  cat > "$caddyfile" <<EOF
# Erzeugt von deploy/native/install.sh – eigene Seiten unten ergänzen.
{
	http_port ${HTTP_PORT:-80}
	https_port ${HTTPS_PORT:-443}
	# Weiterleitung HTTP → HTTPS übernimmt der eigene Block in zammad-service-portal.caddy
	auto_https disable_redirects
	skip_install_trust
	# Clients ohne SNI (Aufruf über die IP) bekommen trotzdem das richtige Zertifikat
	default_sni ${PORTAL_HOST}
}

import $site
EOF
elif ! grep -q "import $site" "$caddyfile"; then
  printf '\n# Service-Portal für Zammad\nimport %s\n' "$site" >> "$caddyfile"
  note "Vorhandene Caddy-Konfiguration erkannt – Portal per 'import' ergänzt ($caddyfile)."
fi
caddy validate --config "$caddyfile" --adapter caddyfile >/dev/null 2>&1 || { caddy validate --config "$caddyfile" --adapter caddyfile; fail "Caddy-Konfiguration ungültig."; }
systemctl enable --quiet caddy
systemctl restart caddy

# ---------------------------------------------------------------- 7. Benutzer
say "7/7 Benutzer"
cli() { /usr/local/bin/service-portal-cli "$@"; }
create_users "$ADMIN_USER" "$NEW_ENV"

say "Fertig"
note "Portal:         ${PUBLIC_URL}"
note "IP-Adresse:     $(hostname -I 2>/dev/null || echo unbekannt)"
case "$PORTAL_HOST" in
  *[!0-9.]*) note "Ohne DNS-Eintrag auf dem eigenen PC in die hosts-Datei eintragen: <IP des Servers>  ${PORTAL_HOST}" ;;
esac
note "Einstellungen:  $ENV_FILE  (danach: systemctl restart $UNIT $UNIT-worker)"
note "Logs:           journalctl -u $UNIT -f"
note "Benutzer:       service-portal-cli user:create --username max --name \"Max Muster\" --email max@firma.de"
note "Stammzertifikat für die Browser: /var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt"
note "Aktualisieren:  Installationsbefehl erneut ausführen."
