# Gemeinsame Hilfsfunktionen für deploy/install.sh (Docker) und deploy/native/install.sh (ohne Docker).
# Wird mit "." eingebunden. Erwartet: INTERACTIVE (0/1), ENV_FILE (Pfad der Konfigurationsdatei).
# Optional: Funktion port_is_ours PORT – liefert 0, wenn der Port vom Portal selbst belegt ist.

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*" >&2; }
fail() { printf '\n\033[31mFehler: %s\033[0m\n' "$*" >&2; exit 1; }

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

# Setzt KEY=VALUE in der Konfigurationsdatei (ersetzt die vorhandene Zeile oder hängt an).
set_env() {
  local key="$1" value="$2" file="${ENV_FILE:-.env}"
  case "$value" in *$'\n'*|*'"'*|*"'"*|*'$'*|*'`'*|*' '*) fail "Ungültiges Zeichen im Wert für $key" ;; esac
  if grep -q "^${key}=" "$file"; then
    K="$key" V="$value" awk 'BEGIN { k = ENVIRON["K"]; v = ENVIRON["V"] } index($0, k "=") == 1 { print k "=" v; next } { print }' "$file" > "$file.tmp"
    cat "$file.tmp" > "$file" && rm -f "$file.tmp"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}

# Entfernt KEY aus der Konfigurationsdatei.
del_env() {
  local key="$1" file="${ENV_FILE:-.env}"
  grep -q "^${key}=" "$file" || return 0
  K="$key" awk 'BEGIN { k = ENVIRON["K"] } index($0, k "=") != 1 { print }' "$file" > "$file.tmp"
  cat "$file.tmp" > "$file" && rm -f "$file.tmp"
}

valid_port() { case "$1" in ''|*[!0-9]*) return 1 ;; esac; [ "$1" -ge 1 ] && [ "$1" -le 65535 ]; }

# Ist der Port belegt – und zwar nicht vom Portal selbst?
port_busy() {
  if command -v ss >/dev/null; then
    ss -ltnH "( sport = :$1 )" 2>/dev/null | grep -q . || return 1
  else
    # Ohne ss: Verbindungsversuch auf den Port (erkennt alles, was auf 0.0.0.0 oder localhost lauscht)
    (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null || return 1
  fi
  if declare -F port_is_ours >/dev/null && port_is_ours "$1"; then return 1; fi
  return 0
}

ask_port() {
  local question="$1" def="$2" fallback="$3" other="${4:-}" p
  if port_busy "$def"; then
    local busy="$def"
    def="$fallback"
    while port_busy "$def" || [ "$def" = "$other" ]; do def=$((def + 1)); done
    note "Port $busy ist auf diesem Server schon belegt – Vorschlag: $def"
  fi
  while true; do
    p="$(ask "$question" "$def")"
    if ! valid_port "$p"; then note "Bitte eine Zahl von 1 bis 65535 eingeben."
    elif [ -n "$other" ] && [ "$p" = "$other" ]; then note "HTTP- und HTTPS-Port müssen verschieden sein."
    elif port_busy "$p"; then note "Port $p ist belegt (ss -ltnp zeigt, wovon)."
    else printf '%s' "$p"; return 0
    fi
    [ "$INTERACTIVE" = 1 ] || fail "Port $p ist nicht nutzbar. HTTPS_PORT bzw. HTTP_PORT in der Konfiguration ändern."
  done
}

# Fragt Hostname/IP, Ports, Virenscanner und Microsoft-Anmeldung ab und schreibt sie nach ENV_FILE.
# Setzt außerdem WANT_CLAMAV (0/1) und ENTRA_SECRET_NEW (falls eingegeben).
ENTRA_SECRET_NEW=""
WANT_CLAMAV=0
configure_common() {
  local ip host https_port http_port mem_mb
  ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  echo >&2
  note "IP-Adresse(n) dieses Servers: $(hostname -I 2>/dev/null || echo unbekannt)"
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
  [ "$clam_def" = "n" ] && note "Der Server hat ${mem_mb} MB RAM. Der Virenscanner ClamAV braucht etwa 1,5 GB."
  if ask_yn "Virenscanner (ClamAV) für hochgeladene Dateien verwenden?" "$clam_def"; then
    WANT_CLAMAV=1; set_env CLAMAV_REQUIRED true
  else
    WANT_CLAMAV=0; set_env CLAMAV_REQUIRED false
  fi

  if ask_yn "Microsoft-Anmeldung (Entra ID) jetzt einrichten oder ändern? (geht auch später)" "n"; then
    local tenant client allowed
    tenant="$(ask "Verzeichnis-ID (Tenant-ID)" "${ENTRA_TENANT_ID:-}")"
    client="$(ask "Anwendungs-ID (Client-ID)" "${ENTRA_CLIENT_ID:-}")"
    allowed="$(ask "Erlaubte Tenant-IDs, Komma-getrennt" "${ENTRA_ALLOWED_TENANTS:-$tenant}")"
    tenant="${tenant// /}"; client="${client// /}"; allowed="${allowed// /}"
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
}

# Prüft, ob PORTAL_HOST, PUBLIC_URL und HTTPS_PORT zusammenpassen.
check_urls() {
  [ -n "${PORTAL_HOST:-}" ] || fail "PORTAL_HOST fehlt in der Konfiguration"
  case "${PUBLIC_URL:-}" in https://*) ;; *) fail "PUBLIC_URL muss mit https:// beginnen";; esac
  local hp="${HTTPS_PORT:-443}"
  if [ "$hp" = "443" ]; then
    [ "${PUBLIC_URL%/}" = "https://${PORTAL_HOST}" ] || fail "PUBLIC_URL muss https://${PORTAL_HOST} sein (passend zu PORTAL_HOST)."
  else
    [ "${PUBLIC_URL%/}" = "https://${PORTAL_HOST}:${hp}" ] || fail "Bei HTTPS_PORT=${hp} muss PUBLIC_URL https://${PORTAL_HOST}:${hp} sein."
  fi
}

# Legt den ersten Admin und auf Wunsch einen normalen Testbenutzer an. Erwartet Funktion "cli".
create_users() {
  local admin="$1" new_install="$2" u n e
  [ -n "$admin" ] || admin="$(ask "Benutzername des ersten Admins" "admin")"
  if cli user:list 2>/dev/null | grep -q "'${admin}'"; then
    note "Benutzer ${admin} gibt es schon – übersprungen."
  else
    cli user:create --username "$admin" --name "Portal-Admin" --role Super-Admin
  fi
  if [ "$INTERACTIVE" = 1 ] && ask_yn "Zusätzlich einen normalen Benutzer (ohne Verwaltungsrechte) mit generiertem Passwort anlegen?" "$([ "$new_install" = 1 ] && echo j || echo n)"; then
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
}
