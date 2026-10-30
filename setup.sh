#!/usr/bin/env bash
# Self-Service-Portal für Zammad – Installation mit einem Befehl.
#
#   curl -fsSL https://raw.githubusercontent.com/Hundexe/Zammad-Service-Portal/main/setup.sh | sudo bash
#
# Das Skript fragt, wie das Portal laufen soll:
#   1) Docker (Docker Compose)    – Docker wird bei Bedarf installiert
#   2) Direkt auf Debian/Ubuntu   – ohne Docker, als systemd-Dienst mit Caddy
#   3) Nur ausprobieren (Demo)    – Beispieldaten, simuliertes Zammad und Microsoft-Login, nichts wird eingerichtet
# Danach fragt die eigentliche Installation Hostname/IP, Ports, Virenscanner usw. ab und legt
# den ersten Admin mit generiertem Passwort an.
#
# Ohne Menü:  … | sudo bash -s -- --docker      (oder --debian, --demo; zusätzlich --ja = keine Rückfragen)
#
# Erneut ausführen = aktualisieren. Einstellungen, Schlüssel und Daten bleiben erhalten.
#
# Umgebungsvariablen (z. B. … | sudo PORTAL_DIR=/srv/portal bash):
#   PORTAL_DIR   Zielverzeichnis   (Standard: /opt/zammad-service-portal, Demo: …-demo)
#   PORTAL_REF   Branch oder Tag   (Standard: neuester Release-Tag, sonst main)
#   PORTAL_REPO  Repository-URL    (Standard: https://github.com/Hundexe/Zammad-Service-Portal.git)
set -euo pipefail

PORTAL_REPO="${PORTAL_REPO:-https://github.com/Hundexe/Zammad-Service-Portal.git}"
PORTAL_REF="${PORTAL_REF:-}"
MODE="${PORTAL_MODE:-}"
YES="${PORTAL_YES:-0}"
for arg in "$@"; do
  case "$arg" in
    --docker) MODE=docker ;;
    --debian|--native|--ohne-docker) MODE=native ;;
    --demo) MODE=demo ;;
    -y|--ja|--yes) YES=1 ;;
    -h|--hilfe|--help) sed -n '2,21p' "$0" 2>/dev/null || true; exit 0 ;;
    *) echo "Unbekannte Option: $arg (erlaubt: --docker, --debian, --demo, --ja)" >&2; exit 2 ;;
  esac
done

say()  { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }
fail() { printf '\n\033[31mFehler: %s\033[0m\n' "$*" >&2; exit 1; }

# Beim Aufruf über "curl … | bash" ist stdin das Skript selbst. Rückfragen kommen dann vom Terminal.
TTY=""
if [ "$YES" != 1 ]; then
  if [ -t 0 ]; then TTY=/dev/stdin
  elif (exec </dev/tty) 2>/dev/null; then TTY=/dev/tty
  else YES=1
  fi
fi
confirm() {
  local answer=""
  [ "$YES" = 1 ] && return 0
  read -r -p "  $1 [J/n]: " answer <"$TTY" || true
  case "$(printf '%s' "${answer:-j}" | tr '[:upper:]' '[:lower:]')" in j|ja|y|yes) return 0 ;; *) return 1 ;; esac
}
is_root() { [ "$(id -u)" = 0 ]; }
os_like() { [ -r /etc/os-release ] && (. /etc/os-release && echo "${ID:-} ${ID_LIKE:-}"); }

cat <<'EOF'

  ┌──────────────────────────────────────────────┐
  │   Self-Service-Portal für Zammad – Installation   │
  └──────────────────────────────────────────────┘
EOF

# ---------------------------------------------------------------- Variante wählen
if [ -z "$MODE" ]; then
  default=1
  [ -f /etc/zammad-service-portal/portal.env ] && default=2
  if [ "$YES" = 1 ]; then
    MODE=$([ "$default" = 2 ] && echo native || echo docker)
  else
    echo
    echo "  Wie soll das Portal laufen?"
    echo "    1) Docker (Docker Compose)    – Docker wird bei Bedarf installiert"
    echo "    2) Direkt auf Debian/Ubuntu   – ohne Docker, als systemd-Dienst"
    echo "    3) Nur ausprobieren (Demo)    – Beispieldaten, simuliertes Zammad, nichts wird eingerichtet"
    read -r -p "  Auswahl [$default]: " choice <"$TTY" || true
    case "${choice:-$default}" in 1) MODE=docker ;; 2) MODE=native ;; 3) MODE=demo ;; *) fail "Bitte 1, 2 oder 3 wählen." ;; esac
  fi
fi
case "$MODE" in docker|native|demo) ;; *) fail "Unbekannte Variante: $MODE" ;; esac
if [ "$MODE" = demo ]; then
  PORTAL_DIR="${PORTAL_DIR:-$(is_root && echo /opt/zammad-service-portal-demo || echo "$HOME/zammad-service-portal-demo")}"
else
  PORTAL_DIR="${PORTAL_DIR:-/opt/zammad-service-portal}"
fi

# ---------------------------------------------------------------- System
say "System prüfen"
[ "$(uname -s)" = Linux ] || fail "Nur Linux wird unterstützt. Unter Windows/macOS: Docker Desktop oder WSL verwenden."
note "$( (. /etc/os-release 2>/dev/null && echo "${PRETTY_NAME:-Linux}") || echo Linux), $(uname -m)"
if [ "$MODE" != demo ]; then
  is_root || fail "Bitte mit sudo starten:  curl -fsSL …/setup.sh | sudo bash"
fi
need=()
for cmd in git curl; do command -v "$cmd" >/dev/null || need+=("$cmd"); done
[ "$MODE" = docker ] && ! command -v openssl >/dev/null && need+=(openssl)
if [ "${#need[@]}" -gt 0 ]; then
  is_root || fail "Bitte zuerst installieren: ${need[*]}"
  note "Installiere: ${need[*]}"
  if command -v apt-get >/dev/null; then
    DEBIAN_FRONTEND=noninteractive apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${need[@]}" ca-certificates >/dev/null
  elif command -v dnf >/dev/null; then dnf install -y -q "${need[@]}"
  else fail "Bitte zuerst installieren: ${need[*]}"
  fi
fi

# ---------------------------------------------------------------- Docker (nur Variante 1)
if [ "$MODE" = docker ]; then
  say "Docker prüfen"
  if ! command -v docker >/dev/null; then
    note "Docker ist nicht installiert."
    case "$(os_like)" in *debian*|*ubuntu*|*rhel*|*centos*|*fedora*) ;; *) fail "Docker bitte selbst installieren (https://docs.docker.com/engine/install/) und setup.sh erneut starten." ;; esac
    confirm "Docker jetzt über das offizielle Skript (get.docker.com) installieren?" || fail "Ohne Docker: setup.sh erneut starten und Variante 2 (direkt auf Debian) wählen."
    curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
    sh /tmp/get-docker.sh
    rm -f /tmp/get-docker.sh
    systemctl enable --now docker >/dev/null 2>&1 || true
  fi
  docker info >/dev/null 2>&1 || { systemctl start docker 2>/dev/null || true; sleep 2; }
  docker info >/dev/null 2>&1 || fail "Docker läuft nicht (systemctl status docker)."
  docker compose version >/dev/null 2>&1 || {
    note "Docker Compose fehlt – installiere das Plugin."
    command -v apt-get >/dev/null && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker-compose-plugin >/dev/null || true
    docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 fehlt (Paket docker-compose-plugin)."
  }
  note "$(docker --version)"
fi
if [ "$MODE" = native ]; then
  case "$(os_like)" in *debian*|*ubuntu*) ;; *) fail "Die Installation ohne Docker gibt es für Debian und Ubuntu. Sonst bitte Variante 1 (Docker)." ;; esac
fi

# ---------------------------------------------------------------- Code
say "Code holen nach ${PORTAL_DIR}"
if [ -d "$PORTAL_DIR/.git" ]; then
  git -C "$PORTAL_DIR" fetch --quiet --tags origin
  note "Vorhandene Installation gefunden – wird aktualisiert."
elif [ -e "$PORTAL_DIR" ] && [ -n "$(ls -A "$PORTAL_DIR" 2>/dev/null)" ]; then
  fail "${PORTAL_DIR} existiert und ist kein Git-Verzeichnis. Anderes Ziel mit PORTAL_DIR=… wählen."
else
  mkdir -p "$(dirname "$PORTAL_DIR")"
  (umask 022 && git clone --quiet "$PORTAL_REPO" "$PORTAL_DIR") || fail "Klonen fehlgeschlagen. Ist github.com erreichbar?"
fi
cd "$PORTAL_DIR"
if [ -z "$PORTAL_REF" ]; then
  PORTAL_REF="$(git tag --list 'v[0-9]*' --sort=-version:refname | head -n1)"
  [ -n "$PORTAL_REF" ] || PORTAL_REF=main
fi
if git show-ref --verify --quiet "refs/remotes/origin/$PORTAL_REF"; then
  git checkout --quiet "$PORTAL_REF" 2>/dev/null || git checkout --quiet -b "$PORTAL_REF" "origin/$PORTAL_REF"
  git merge --quiet --ff-only "origin/$PORTAL_REF" || fail "Lokale Änderungen in ${PORTAL_DIR} verhindern das Aktualisieren (git status)."
else
  git checkout --quiet "$PORTAL_REF" || fail "Version ${PORTAL_REF} nicht gefunden."
fi
note "Version: ${PORTAL_REF} ($(git rev-parse --short HEAD))"

# ---------------------------------------------------------------- Weiter je nach Variante
case "$MODE" in
  docker)
    say "Portal einrichten (Docker)"
    cd deploy
    if [ "$YES" = 1 ]; then ./install.sh --ja; else ./install.sh <"$TTY"; fi
    ;;

  native)
    say "Portal einrichten (ohne Docker)"
    if [ "$YES" = 1 ]; then deploy/native/install.sh --ja; else deploy/native/install.sh <"$TTY"; fi
    ;;

  demo)
    say "Demo vorbereiten"
    # Node.js >= 22.18 nötig. Fehlt es, wird es nur für die Demo in deren Verzeichnis geladen.
    NODE=""
    if command -v node >/dev/null; then
      v="$(node -v | tr -d v)"; major="${v%%.*}"; minor="$(echo "$v" | cut -d. -f2)"
      if [ "$major" -gt 22 ] || { [ "$major" = 22 ] && [ "$minor" -ge 18 ]; }; then NODE="$(command -v node)"; fi
    fi
    if [ -z "$NODE" ]; then
      case "$(uname -m)" in x86_64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) fail "Prozessor $(uname -m) wird nicht unterstützt." ;; esac
      if [ ! -x .node/bin/node ]; then
        note "Lade Node.js 24 (nur für die Demo, nach .node/) …"
        base="https://nodejs.org/dist/latest-v24.x"
        curl -fsSL "$base/SHASUMS256.txt" -o .node-sums.txt
        file="$(awk -v a="linux-${arch}.tar.xz" '$2 ~ a"$" { print $2; exit }' .node-sums.txt)"
        curl -fsSL "$base/$file" -o "$file"
        grep " $file\$" .node-sums.txt | sha256sum -c --quiet - || fail "Prüfsumme von Node.js stimmt nicht."
        command -v xz >/dev/null || fail "xz fehlt (Paket xz-utils)."
        mkdir -p .node && tar -xJf "$file" -C .node --strip-components=1 && rm -f "$file" .node-sums.txt
      fi
      NODE="$PWD/.node/bin/node"
    fi
    for p in 3000 3101 3102 3103 3104; do
      (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null && fail "Port $p ist belegt. Läuft die Demo schon? Sonst den Dienst auf Port $p beenden."
    done
    ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
    host=localhost
    if [ -n "$ip" ] && [ "$YES" != 1 ]; then
      echo
      echo "  Von wo soll die Demo im Browser geöffnet werden?"
      echo "    1) Nur auf diesem Rechner      (http://localhost:3000)"
      echo "    2) Von anderen Rechnern im Netz (http://$ip:3000)"
      read -r -p "  Auswahl [1]: " where <"$TTY" || true
      [ "${where:-1}" = 2 ] && host="$ip"
    fi
    "$NODE" --disable-warning=ExperimentalWarning tools/build-web.ts >/dev/null
    say "Demo startet – Beenden mit Strg+C"
    note "Im Browser öffnen:  http://$host:3000"
    note "„Mit Microsoft anmelden“ meldet ohne Passwort als Alex Berger (Admin) an. Zammad und Microsoft sind nur simuliert."
    note "Daten werden bei jedem Start zurückgesetzt. Nicht für den echten Betrieb gedacht."
    if [ "$host" = localhost ]; then listen=127.0.0.1; else listen=0.0.0.0; fi
    PUBLIC_URL="http://$host:3000" DEMO_HOST="$listen" exec "$NODE" --disable-warning=ExperimentalWarning tools/demo.ts
    ;;
esac
