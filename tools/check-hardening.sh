#!/usr/bin/env bash
# Prüft die Container-Härtung des Docker-Stacks – zuerst die Konfiguration, dann (falls er läuft)
# die tatsächlich gestarteten Container.
#
#   bash tools/check-hardening.sh                 Konfiguration aus deploy/docker-compose.yml + deploy/.env
#   bash tools/check-hardening.sh --config-only   nur die Konfiguration
#
# Erwartung je Dienst: Dateisystem schreibgeschützt, alle Linux-Capabilities entzogen, keine neuen Rechte
# (no-new-privileges), kein root, nicht privilegiert, kein Docker-Socket, keine veröffentlichten Ports.
# Bewusste Ausnahmen stehen unten in EXCEPTIONS und in docs/BETRIEB.md („Container-Härtung“).
# Exit-Code 0 = alles wie erwartet, 1 = Abweichung, 2 = Prüfung nicht möglich.
set -euo pipefail
cd "$(dirname "$0")/../deploy"

command -v docker >/dev/null || { echo "docker fehlt" >&2; exit 2; }
command -v jq >/dev/null || { echo "jq fehlt (apt-get install -y jq)" >&2; exit 2; }

ENV_ARGS=()
if [ -f .env ]; then ENV_ARGS=(--env-file .env)
else touch .env; trap 'rm -f .env' EXIT; fi  # nur für die Prüfung ohne Installation
# Alle Profile, damit auch ClamAV und Updater geprüft werden; Platzhalter für Pflichtwerte, falls .env fehlt
CONFIG="$(PUBLIC_URL="${PUBLIC_URL:-https://portal.example.org}" PORTAL_HOST="${PORTAL_HOST:-portal.example.org}" \
  docker compose "${ENV_ARGS[@]}" --profile clamav --profile updater config --format json)"

# Ausnahmen: Dienst:Prüfung – mit Begründung in docs/BETRIEB.md
EXCEPTIONS=(
  "caddy:ports"            # einziger Dienst mit Port nach außen
  "caddy:cap_add"          # NET_BIND_SERVICE für Port 80/443
  "caddy:user"             # bindet Port 80/443, Image läuft als root ohne Capabilities außer NET_BIND_SERVICE
  "clamav:read_only"       # schreibt Signaturen und Laufzeitdateien; eigenes Volume, kein Zugriff auf Portaldaten
  "clamav:cap_drop"        # das offizielle Image wechselt beim Start den Benutzer (setuid)
  "clamav:user"            # startet als root und wechselt selbst zu clamav
  "socket-proxy:docker_sock"  # nur lesend eingehängt; erlaubte API-Aufrufe begrenzt, internes Netz
  "socket-proxy:user"      # braucht Lesezugriff auf den Socket
  "socket-proxy:cap_drop"  # Image-Standard (HAProxy), dafür read_only und internes Netz
  "updater:user"           # root im Container, aber nur Datei-Capabilities, kein Docker-Socket
  "updater:cap_add"        # DAC_OVERRIDE, CHOWN, FOWNER für das Projektverzeichnis
)

is_exception() { local k="$1:$2"; for e in "${EXCEPTIONS[@]}"; do [ "$e" = "$k" ] && return 0; done; return 1; }

fail=0
report() { # dienst prüfung ok text
  if [ "$3" = ok ]; then printf '  \033[32m✓\033[0m %-13s %s\n' "$1" "$4"
  elif is_exception "$1" "$2"; then printf '  \033[33m~\033[0m %-13s %s (bewusste Ausnahme)\n' "$1" "$4"
  else printf '  \033[31m✗\033[0m %-13s %s\n' "$1" "$4"; fail=1; fi
}

echo "Konfiguration (docker compose config):"
for svc in $(jq -r '.services | keys[]' <<<"$CONFIG"); do
  s="$(jq -c --arg s "$svc" '.services[$s]' <<<"$CONFIG")"
  [ "$(jq -r '.read_only // false' <<<"$s")" = true ] && report "$svc" read_only ok "Dateisystem schreibgeschützt" || report "$svc" read_only no "Dateisystem beschreibbar"
  jq -e '(.cap_drop // []) | index("ALL")' <<<"$s" >/dev/null && report "$svc" cap_drop ok "alle Capabilities entzogen" || report "$svc" cap_drop no "Capabilities nicht entzogen"
  caps="$(jq -r '(.cap_add // []) | join(",")' <<<"$s")"
  [ -z "$caps" ] && report "$svc" cap_add ok "keine zusätzlichen Capabilities" || report "$svc" cap_add no "zusätzliche Capabilities: $caps"
  jq -e '(.security_opt // []) | map(select(test("no-new-privileges(:true)?$"))) | length > 0' <<<"$s" >/dev/null && report "$svc" nnp ok "no-new-privileges" || report "$svc" nnp no "no-new-privileges fehlt"
  user="$(jq -r '.user // ""' <<<"$s")"
  case "$user" in ""|0|0:*|root|root:*) report "$svc" user no "läuft als root${user:+ ($user)}" ;; *) report "$svc" user ok "Benutzer $user" ;; esac
  [ "$(jq -r '.privileged // false' <<<"$s")" = true ] && report "$svc" privileged no "privilegiert!" || true
  jq -e '(.volumes // []) | map(select((.source // "") | test("docker.sock"))) | length > 0' <<<"$s" >/dev/null && report "$svc" docker_sock no "Docker-Socket eingehängt" || true
  ports="$(jq -r '[(.ports // [])[] | "\(.host_ip // "0.0.0.0"):\(.published)"] | join(" ")' <<<"$s")"
  [ -n "$ports" ] && report "$svc" ports no "Ports nach außen: $ports" || true
  [ "$(jq -r '.network_mode // ""' <<<"$s")" = host ] && report "$svc" network no "network_mode: host" || true
done

if [ "${1:-}" != --config-only ] && ids="$(docker compose "${ENV_ARGS[@]}" --profile clamav --profile updater ps -q 2>/dev/null)" && [ -n "$ids" ]; then
  echo
  echo "Laufende Container (docker inspect):"
  for id in $ids; do
    i="$(docker inspect "$id")"
    svc="$(jq -r '.[0].Config.Labels["com.docker.compose.service"]' <<<"$i")"
    [ "$(jq -r '.[0].HostConfig.ReadonlyRootfs' <<<"$i")" = true ] && report "$svc" read_only ok "ReadonlyRootfs" || report "$svc" read_only no "ReadonlyRootfs=false"
    jq -e '.[0].HostConfig.CapDrop // [] | index("ALL")' <<<"$i" >/dev/null && report "$svc" cap_drop ok "CapDrop ALL" || report "$svc" cap_drop no "CapDrop fehlt"
    jq -e '.[0].HostConfig.SecurityOpt // [] | map(select(test("no-new-privileges"))) | length > 0' <<<"$i" >/dev/null && report "$svc" nnp ok "no-new-privileges" || report "$svc" nnp no "no-new-privileges fehlt"
    [ "$(jq -r '.[0].HostConfig.Privileged' <<<"$i")" = true ] && report "$svc" privileged no "privilegiert!" || true
    u="$(jq -r '.[0].Config.User' <<<"$i")"
    case "$u" in ""|0|0:*|root|root:*) report "$svc" user no "läuft als root${u:+ ($u)}" ;; *) report "$svc" user ok "Benutzer $u" ;; esac
  done
fi

echo
if [ "$fail" = 0 ]; then echo "Härtung: wie erwartet."; else echo "Härtung: Abweichungen gefunden (siehe ✗)." >&2; fi
exit "$fail"
