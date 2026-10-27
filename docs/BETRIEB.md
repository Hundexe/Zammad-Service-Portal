# Betrieb

Alle Befehle im Verzeichnis `deploy/` auf der VM.

> Diese Seite beschreibt die Docker-Variante. Ohne Docker gelten dieselben Einstellungen, nur in `/etc/zammad-service-portal/portal.env`; Befehle und Pfade stehen in [Installation → Variante ohne Docker](INSTALLATION.md#variante-ohne-docker).

## Einstellungen ändern (deploy/.env)

Alle Einstellungen des Portals stehen in **einer** Datei auf dem Server: `deploy/.env`. Jede Einstellung ist dort kommentiert. Die Vorlage mit allen Möglichkeiten ist `deploy/.env.example`. Nach einer Änderung:

```bash
cd /opt/zammad-service-portal/deploy
docker compose --env-file .env up -d      # startet App und Worker mit den neuen Werten neu
docker compose logs app | tail -5         # zeigt die wirksamen Sicherheitseinstellungen
```

Sicherheitsrelevante Zahlen haben feste Grenzen, damit sich das Portal nicht versehentlich aufmachen lässt. Liegt ein Wert außerhalb, startet die App nicht und schreibt den Grund ins Log, zum Beispiel `LOGIN_MAX_ATTEMPTS=1 ist nicht erlaubt (erlaubt: 3 bis 20)`. Die laufende Version bleibt dann gestoppt, bis der Wert korrigiert ist.

| Einstellung | Standard | Erlaubt | Wirkung |
| --- | --- | --- | --- |
| `HTTPS_PORT` / `HTTP_PORT` | `443` / `80` | 1–65535 | Ports auf der VM. Bei anderem HTTPS-Port gehört er in `PUBLIC_URL`, z. B. `https://portal.firma.intern:8443` |
| `LOCAL_LOGIN_ENABLED` | `true` | true/false | Lokale Anmeldung. Bei `false` enden auch offene lokale Sitzungen sofort |
| `LOCAL_ADMIN_REQUIRE_TOTP` | `true` | true/false | 2FA-Pflicht für lokale Konten mit Verwaltungsrechten. `false` erzeugt eine Warnung in der Verwaltung |
| `LOCAL_USER_REQUIRE_TOTP` | `false` | true/false | 2FA-Pflicht auch für normale lokale Benutzer |
| `PASSWORD_MIN_LENGTH` | `12` | 10–128 | Mindestlänge eigener Passwörter |
| `LOGIN_MAX_ATTEMPTS` | `5` | 3–20 | Fehlversuche (Passwort, 2FA-Code, Bestätigung zusammen) bis zur Sperre |
| `LOGIN_LOCK_MINUTES` | `15` | 1–1440 | Dauer der ersten Sperre |
| `LOGIN_LOCK_PROGRESSIVE` | `true` | true/false | Jede weitere Sperre doppelt so lang |
| `LOGIN_LOCK_MAX_MINUTES` | `1440` | ≥ erste Sperre, ≤ 10080 | Längste Sperre |
| `SESSION_IDLE_MINUTES` | `30` | 5–480 | Abmeldung nach Inaktivität |
| `SESSION_MAX_HOURS` | `10` | 1–24 | Spätestens dann neu anmelden |
| `STEPUP_MINUTES` | `10` | 1–60 | Wie alt die Anmeldung für kritische Aktionen höchstens sein darf |
| `ADMIN_ALLOWED_CIDRS` | leer | Netze, Komma-getrennt | Admin-Bereich nur aus diesen Netzen |
| `RATE_LIMIT_LOGIN_BURST` / `_PER_MINUTE` | `10` / `10` | ≥ 3 / ≥ 1 | Anmeldeversuche je IP |
| `RATE_LIMIT_API_BURST` / `RATE_LIMIT_WRITE_BURST` | `240` / `60` | ≥ 20 / ≥ 5 | Allgemeine Ratenbegrenzung je IP |
| `CLAMAV_REQUIRED` | `true` | true/false | Uploads ablehnen, wenn der Virenscanner fehlt |
| `RETENTION_DAYS` | `30` | 1–3650 | Wie lange Anfrage-Inhalte nach der Zustellung im Portal bleiben |
| `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, `ENTRA_ALLOWED_TENANTS` | leer | | Microsoft-Anmeldung, siehe [Installation](INSTALLATION.md) |

Fest vorgegeben und nicht über `.env` änderbar sind: Produktionsmodus, Pfade der Geheimnisse, der vertrauenswürdige Proxy (nur Caddy) und das Datenverzeichnis. Das steht in `deploy/docker-compose.yml` unter `environment` und hat Vorrang vor `.env`.

Farben, Logos, Texte, Formulare, Rollen und Ticketsysteme werden in der Verwaltungsoberfläche gepflegt. Sie liegen in der Datenbank, sind versioniert und stehen im Audit-Log.

## Status und Logs

```bash
docker compose ps                     # alle Dienste "running", app "healthy"
docker compose logs -f app worker     # Logs als JSON, eine Zeile je Ereignis
curl -sk https://serviceportal.firma.intern/readyz   # {"status":"ok","version":"…"}
```

Für Monitoring (z. B. Checkmk, Zabbix, Uptime Kuma) eignet sich `/readyz`: HTTP 200 mit Versionsnummer, wenn App und Datenbank laufen. Mehr sagt der Befehl `status` (siehe [Überwachung](#überwachung-und-alarme)). Zusätzlich in der Verwaltung: **Zustellung** (fehlgeschlagene Anfragen) und **Updates** (meldet sich der Updater?).

Wichtige Log-Meldungen:

| Meldung | Bedeutung |
| --- | --- |
| `Zustellung fehlgeschlagen, neuer Versuch geplant` | Zammad kurz nicht erreichbar – erledigt sich meist selbst |
| `Zustellung endgültig fehlgeschlagen` | z. B. Gruppe in Zammad umbenannt → korrigieren, unter **Zustellung** erneut senden |
| `Virenscanner nicht erreichbar` | ClamAV läuft nicht oder lädt noch Signaturen (nach dem Start bis zu 2 Minuten) |
| `Microsoft-Anmeldung abgelehnt` | Grund steht dabei (z. B. Tenant nicht erlaubt, Secret abgelaufen) |
| `Entra liefert zu viele Gruppen im Token` | Gruppenanspruch auf „der Anwendung zugewiesene Gruppen“ umstellen |
| `Lokale Anmeldung` (mit `"alert":true`) | Jemand hat sich mit einem lokalen Konto angemeldet – im Normalbetrieb nur das Notfallkonto, also **immer prüfen** |
| `Signaturschlüssel von Microsoft nicht erneuerbar` (`"event":"jwks_stale"`, `"alert":true`) | Das Portal erreicht seit über 24 Stunden die Schlüssel von Microsoft nicht (Egress-Firewall, Proxy, DNS?) und nutzt die zwischengespeicherten weiter. Stündlich, mit Alter und Grenze |
| `Signaturschlüssel von Microsoft zu alt` (`"event":"jwks_expired"`, Level error) | Die Grenze `ENTRA_JWKS_MAX_STALE_HOURS` (Standard 72 h) ist überschritten: Microsoft-Anmeldung gesperrt, bis die Schlüssel wieder abrufbar sind. Notfallkonto geht weiter |
| `form.group_not_allowed` / `form.field_not_released` | Ein Formular will in eine nicht erlaubte Gruppe oder ein nicht freigegebenes Feld schreiben – Formular korrigieren |
| `Anfrage war schon zugestellt – kein zweites Ticket` | Nach einer Zeitüberschreitung wurde das schon vorhandene Ticket übernommen (kein Duplikat) |

## Kommandozeile

```bash
P="docker compose exec app /nodejs/bin/node src/server/cli.ts"
$P user:create --username max --name "Max Muster" --email max@firma.de          # normaler Benutzer, Passwort wird erzeugt
$P user:create --username notfall --name "Notfall-Admin" --role Super-Admin      # Admin (2FA bei erster Anmeldung)
$P user:reset-password --username max [--reset-totp]                              # neues generiertes Passwort
$P user:unlock --username max
$P user:list
$P backup                                     # Sicherung nach /data/backups/
$P backup:verify /data/backups/DATEI.sqlite   # Sicherung prüfen (Integrität, Schema, passender Schlüssel)
$P status                                     # Zustand für Monitoring, Exit-Code 2 bei Problemen (--json)
$P scanner:test                               # Virenscanner mit EICAR-Testdatei prüfen
$P audit:verify                               # Integrität des Audit-Logs prüfen
$P secret:generate                            # neuen 32-Byte-Schlüssel ausgeben
```

## Sicherung

Zu sichern sind **drei Dinge**:

| Was | Wo | Hinweis |
| --- | --- | --- |
| Datenbank | Volume `portal-data` → per `backup`-Befehl | konsistent auch im laufenden Betrieb |
| Konfiguration | `deploy/.env`, `deploy/caddy/`, `deploy/certs/` | |
| Hauptschlüssel | `deploy/secrets/secret_key` | **getrennt** vom Backup im Passwort-Tresor ablegen |

Täglich per Cron (als Benutzer `portal`):

```bash
crontab -e
# 02:15 Uhr: Datenbank sichern, auf die VM kopieren, Sicherungen älter als 30 Tage löschen
15 2 * * * cd /opt/zammad-service-portal/deploy && docker compose exec -T app /nodejs/bin/node src/server/cli.ts backup --out /data/backups/taeglich.sqlite && docker compose exec -T app /nodejs/bin/node src/server/cli.ts backup:verify /data/backups/taeglich.sqlite && docker compose cp app:/data/backups/taeglich.sqlite /opt/backup/portal-$(date +\%F).sqlite && find /opt/backup -name 'portal-*.sqlite' -mtime +30 -delete
```

`/opt/backup` sollte vom Proxmox-Backup (oder einem anderen Sicherungssystem) mit erfasst werden. Die VM selbst lässt sich zusätzlich mit Proxmox-Snapshots sichern.

## Wiederherstellung

Der Befehl `restore` prüft die Sicherung (Integrität, Schema-Version, passt der `SECRET_KEY`?), sichert den aktuellen Stand nach `backups/vor-wiederherstellung-*.sqlite`, entfernt alte `-wal`/`-shm`-Dateien und spielt die Sicherung ein. Ohne `--yes` passiert nichts.

**Docker:**

```bash
cd /opt/zammad-service-portal/deploy
docker compose stop app worker updater
docker compose cp /opt/backup/portal-2026-10-20.sqlite app:/data/backups/einspielen.sqlite   # nur nötig, wenn die Datei außerhalb liegt
docker compose run --rm --no-deps app backup:verify /data/backups/einspielen.sqlite
docker compose run --rm --no-deps app restore /data/backups/einspielen.sqlite --yes
docker compose up -d
docker compose exec app /nodejs/bin/node src/server/cli.ts status
```

(`docker compose cp` funktioniert auch mit gestopptem Container.)

**Ohne Docker:**

```bash
systemctl stop zammad-service-portal zammad-service-portal-worker
service-portal-cli backup:verify /opt/backup/portal-2026-10-20.sqlite
service-portal-cli restore /opt/backup/portal-2026-10-20.sqlite --yes
systemctl start zammad-service-portal zammad-service-portal-worker
```

Auf einer neuen VM: Repository klonen, `.env`, `certs/` und **denselben** `secret_key` zurückspielen, installieren, dann wie oben einspielen. Mit einem anderen Schlüssel meldet `backup:verify` „Schlüssel: PASST NICHT“ – API-Tokens und wartende Anfragen wären dann unlesbar.

Wartende Anfragen mit Anhängen brauchen zusätzlich die Dateien unter `/data/uploads` (Docker-Volume `portal-data` bzw. `/var/lib/zammad-service-portal/uploads`). Wer das ganze Volume sichert (Proxmox-Backup der VM), hat beides.

### Restore-Probe (alle 3 Monate)

Eine Sicherung ist erst etwas wert, wenn das Zurückspielen geklappt hat. Am einfachsten auf einer Test-VM oder lokal mit Docker:

1. Sicherung und `secret_key` auf die Test-VM kopieren, Portal dort installieren.
2. `backup:verify` – muss „Ergebnis: in Ordnung“ und „Schlüssel: passt“ melden.
3. `restore … --yes`, starten, als Notfall-Admin anmelden, Formulare und Ticketsysteme ansehen, **Verbindung testen**.
4. Ergebnis mit Datum festhalten (z. B. im Betriebshandbuch).

Der Ablauf Sicherung → Änderung → Wiederherstellung ist zusätzlich automatisch getestet (`test/review.test.ts`, Abschnitt „#10“).

## Überwachung und Alarme

**Zustand abfragen** – für Checkmk, Zabbix, Nagios-Plugins oder ein Cron-Skript:

```bash
docker compose exec -T app /nodejs/bin/node src/server/cli.ts status            # lesbar
docker compose exec -T app /nodejs/bin/node src/server/cli.ts status --json     # für Skripte
echo $?                                                                          # 0 = OK, 2 = Problem
```

`status` prüft: wartende und fehlgeschlagene Anfragen, wie lange die älteste Anfrage schon wartet (Grenze `--max-queue-minutes`, Standard 30), den Virenscanner mit einer EICAR-Testdatei, ob die Signaturschlüssel von Microsoft abrufbar sind (sonst Problem – so fällt eine gesperrte Verbindung auf, lange bevor die 72-Stunden-Grenze greift) und die Hash-Kette des Audit-Logs. Ist ClamAV Pflicht (`CLAMAV_REQUIRED=true`) und erkennt EICAR nicht, ist das ein Problem; sonst nur ein Hinweis.

Empfohlene Prüfungen:

| Prüfung | Intervall | Alarm, wenn |
| --- | --- | --- |
| `GET /readyz` | 1 Minute | nicht HTTP 200 |
| `cli.ts status` | 5 Minuten | Exit-Code ≠ 0 |
| `cli.ts scanner:test` | stündlich (in `status` enthalten) | Exit-Code ≠ 0 |
| Log-Ereignis `"alert":true` | sofort | immer (lokale Anmeldung) |
| Log-Ereignis `Konto gesperrt` | sofort | mehrfach in kurzer Zeit |
| Log-Ereignis `"event":"jwks_stale"` / `"jwks_expired"` | sofort | immer (Schlüssel von Microsoft nicht erneuerbar bzw. Microsoft-Anmeldung gesperrt) |
| Log-Ereignis `Zustellung endgültig fehlgeschlagen` | sofort | immer |
| Zertifikat (`https://…`) | täglich | läuft in < 14 Tagen ab |

**Logs weiterleiten.** Die Logs sind JSON-Zeilen auf stdout/stderr (ein Ereignis je Zeile, Geheimnisse geschwärzt).

- Docker: in `docker-compose.yml` den Logging-Treiber auf `syslog` oder `journald` umstellen, z. B.
  ```yaml
  x-hardening: &hardening
    logging:
      driver: syslog
      options: { syslog-address: "tcp://siem.firma.intern:514", tag: "service-portal/{{.Name}}" }
  ```
  oder lokal bei `json-file` bleiben und die Dateien mit dem vorhandenen Agenten (Filebeat, Vector, Promtail, Wazuh …) einsammeln.
- Ohne Docker: die Dienste schreiben ins Journal (`journalctl -u zammad-service-portal`). Weiterleitung über `rsyslog` (`ForwardToSyslog=yes` in `/etc/systemd/journald.conf`, dann `*.* @@siem.firma.intern:514`) oder den Agenten des SIEM.

Beispiel-Alarmregel (Graylog/Loki/Wazuh sinngemäß): `alert:true` → sofort an die Admin-Bereitschaft; `level:"warn" AND msg:"Konto gesperrt"` mehr als 5× in 10 Minuten → möglicher Angriff.

Das **Audit-Log** (Verwaltung → Audit) ist zusätzlich als CSV exportierbar und lässt sich mit `audit:verify` auf Manipulation prüfen.

## Container-Härtung prüfen

```bash
bash tools/check-hardening.sh              # Konfiguration + laufende Container (docker inspect)
bash tools/check-hardening.sh --config-only
```

Das Skript prüft je Dienst: schreibgeschütztes Dateisystem, alle Capabilities entzogen, `no-new-privileges`, kein root, nicht privilegiert, kein Docker-Socket, keine Ports nach außen, kein `network_mode: host`. Erwartetes Ergebnis (Stand 1.3.0):

| Dienst | read-only | cap_drop ALL | no-new-priv. | Benutzer | Ports | Ausnahme und Begründung |
| --- | --- | --- | --- | --- | --- | --- |
| app, worker | ✓ | ✓ | ✓ | 65532 | – | keine |
| caddy | ✓ | ✓ | ✓ | root | 80/443 | einziger Dienst mit Ports; nur `NET_BIND_SERVICE` |
| clamav | – | – | ✓ | root → clamav | – | offizielles Image schreibt Signaturen und wechselt beim Start selbst den Benutzer; eigenes Volume, kein Zugriff auf Portaldaten, nur internes Netz + Signatur-Updates |
| socket-proxy | ✓ | – | ✓ | root | – | liest den Docker-Socket (nur lesend eingehängt), erlaubte API-Aufrufe begrenzt, nur internes Netz |
| updater | ✓ | ✓ | ✓ | root | – | nur `DAC_OVERRIDE`, `CHOWN`, `FOWNER` für das Projektverzeichnis, kein Docker-Socket |

Wer den Updater nicht nutzt (empfohlen für den Start), hat socket-proxy und updater gar nicht laufen. Alle Dienste haben Speicher- und Prozessgrenzen sowie Log-Rotation.

## Ausgehende Verbindungen begrenzen (Egress-Firewall)

Das Portal prüft Zammad-Adressen selbst (keine Loopback-, Link-Local- und Metadaten-Adressen, keine eigenen Dienstnamen, Prüfung der IP bei **jedem** Verbindungsaufbau, keine Weiterleitungen). Zusätzlich sollte die VM nur dorthin dürfen, wohin sie muss:

| Ziel | Wofür |
| --- | --- |
| `login.microsoftonline.com`, `graph.microsoft.com` (443) | Anmeldung, Abteilung |
| eigene Zammad-Server (443) | Tickets |
| `github.com` (443/22) | nur mit Updater bzw. für `git fetch` |
| `database.clamav.net` (443) | Virensignaturen |
| Paketquellen (Debian, Docker, nodejs.org) | Updates des Systems |
| DNS- und NTP-Server | |

Beispiel **Docker** (Regeln in der Kette `DOCKER-USER`, gelten für alle Container; Adressen anpassen):

```bash
ZAMMAD=10.10.20.15          # eigener Zammad-Server
DNS=10.10.0.53
iptables -I DOCKER-USER -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A DOCKER-USER -s 172.16.0.0/12 -d $DNS -p udp --dport 53 -j ACCEPT
iptables -A DOCKER-USER -s 172.16.0.0/12 -d $ZAMMAD -p tcp --dport 443 -j ACCEPT
iptables -A DOCKER-USER -s 172.16.0.0/12 -d 10.0.0.0/8 -j REJECT        # sonst nichts im internen Netz
iptables -A DOCKER-USER -s 172.16.0.0/12 -d 192.168.0.0/16 -j REJECT
iptables -A DOCKER-USER -s 172.16.0.0/12 -p tcp --dport 443 -j ACCEPT   # HTTPS ins Internet (Entra, Graph, ClamAV)
iptables -A DOCKER-USER -s 172.16.0.0/12 -j REJECT
apt-get install -y iptables-persistent && netfilter-persistent save
```

Beispiel **ohne Docker** (nftables, Dienstbenutzer `zsp`):

```
# /etc/nftables.d/service-portal.nft
table inet zsp_egress {
  chain out {
    type filter hook output priority 0; policy accept;
    meta skuid "zsp" ct state established,related accept
    meta skuid "zsp" ip daddr 127.0.0.1 tcp dport 3310 accept          # ClamAV lokal
    meta skuid "zsp" udp dport 53 accept
    meta skuid "zsp" ip daddr 10.10.20.15 tcp dport 443 accept          # Zammad
    meta skuid "zsp" ip daddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16 } reject
    meta skuid "zsp" tcp dport 443 accept                               # Entra, Graph
    meta skuid "zsp" reject
  }
}
```

Das Hypervisor-Management (z. B. Proxmox auf 8006), die Docker-API und andere Verwaltungsoberflächen dürfen von der Portal-VM aus nicht erreichbar sein – am besten zusätzlich auf der Netzwerk-Firewall sperren.

## Wann Rechteänderungen greifen

| Änderung | wirkt |
| --- | --- |
| Benutzer im Portal deaktiviert | sofort, alle Sitzungen |
| lokale Anmeldung abgeschaltet | sofort für alle lokalen Sitzungen |
| Rolle im Portal entzogen/zugewiesen | sofort (bei der nächsten Anfrage) |
| Entra-Gruppe oder App-Rolle geändert | bei der nächsten Anmeldung **oder** Bestätigung (Step-up) über Microsoft, spätestens nach `SESSION_MAX_HOURS` |
| Benutzer in Entra gesperrt | keine neue Anmeldung/Bestätigung mehr möglich; laufende Sitzung endet spätestens nach `SESSION_IDLE_MINUTES` Inaktivität bzw. `SESSION_MAX_HOURS` |

Kritische Aktionen in der Verwaltung verlangen eine Bestätigung, die höchstens `STEPUP_MINUTES` (Standard 10) alt ist – dabei werden Gruppen frisch aus Entra übernommen. Wer Admin-Rechte schneller entziehen will: `SESSION_MAX_HOURS` verkürzen (z. B. 4) und beim Entzug den Benutzer zusätzlich kurz im Portal deaktivieren.

## Zertifikat der internen Caddy-CA verteilen

Nur bei `tls internal`:

```bash
docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./caddy-root.crt
```

Die Datei per GPO unter *Computerkonfiguration → Richtlinien → Windows-Einstellungen → Sicherheitseinstellungen → Richtlinien für öffentliche Schlüssel → Vertrauenswürdige Stammzertifizierungsstellen* verteilen. Caddy erneuert das Serverzertifikat selbstständig.

## Geheimnisse wechseln

| Geheimnis | Vorgehen |
| --- | --- |
| Entra-Client-Secret | neues Secret in Entra anlegen, `sudo nano secrets/entra_client_secret`, `docker compose up -d app`, altes Secret löschen |
| Zammad-API-Token | neuen Token in Zammad erzeugen, in der Verwaltung unter **Verbindung** eintragen, alten Token löschen |
| Hauptschlüssel `secret_key` | Damit sind Zammad-Tokens und 2FA-Geheimnisse verschlüsselt. Wechsel nur, wenn er kompromittiert ist: neuen Schlüssel eintragen, Portal starten, alle Zammad-Tokens neu eintragen, für lokale Konten `user:reset-password --reset-totp`. Noch nicht zugestellte Anfragen gehen dabei verloren – vorher unter **Zustellung** prüfen. |
| Deploy-Key | neuen Schlüssel erzeugen, in GitHub als Deploy-Key eintragen, `secrets/deploy_key` ersetzen, alten Key in GitHub löschen |

### Entra: Zertifikat statt Secret

Sicherer als ein Client-Secret ist ein Zertifikat:

```bash
openssl req -x509 -newkey rsa:3072 -nodes -days 730 -subj "/CN=Service-Portal" -keyout secrets/entra_cert.key -out entra_cert.crt
openssl x509 -in entra_cert.crt -outform DER | openssl dgst -sha256 -binary | openssl base64 | tr '+/' '-_' | tr -d '='   # Thumbprint (x5t#S256)
```

`entra_cert.crt` in der App-Registrierung unter **Zertifikate & Geheimnisse → Zertifikate** hochladen. In `docker-compose.yml` beim Dienst `app` das Secret `entra_cert_key` ergänzen und in `.env` bzw. der Umgebung `ENTRA_CERT_PRIVATE_KEY_FILE=/run/secrets/entra_cert_key` und `ENTRA_CERT_THUMBPRINT=<Thumbprint>` setzen. Das Client-Secret kann dann leer bleiben.

## Störungen beheben

| Problem | Ursache und Lösung |
| --- | --- |
| Browser meldet Zertifikatsfehler | interne Caddy-CA nicht verteilt oder Hostname passt nicht zum Zertifikat |
| „Falscher Hostname“ (421) | Portal unter anderem Namen als `PUBLIC_URL` aufgerufen – richtigen Namen verwenden |
| Nach Microsoft-Anmeldung zurück auf der Anmeldeseite mit Fehler | Log zeigt den Grund; häufig: Redirect-URI in Entra falsch, Tenant fehlt in `ENTRA_ALLOWED_TENANTS`, Client-Secret abgelaufen, Zuweisung in Entra fehlt |
| Verwaltung: „aus diesem Netz nicht erreichbar“ | `ADMIN_ALLOWED_CIDRS` enthält das Netz nicht |
| Formular: „keine Zammad-Gruppe festgelegt“ | im Formular unter **Ticket** eine Gruppe wählen oder Standard-Gruppe des Systems setzen |
| Mitarbeitende sehen keine Tickets | E-Mail-Adresse im Portal und im Zammad-Kunden müssen übereinstimmen; API-Benutzer braucht `admin.user` |
| Zammad-Objekte leer | API-Token ohne `admin.object` |
| Uploads werden abgelehnt („Virenscanner nicht erreichbar“) | `docker compose logs clamav`; ClamAV braucht etwa 1,5 GB RAM |
| `app` startet nicht: „SECRET_KEY … fehlt“ oder „nicht lesbar“ | `secrets/secret_key` fehlt oder gehört nicht Benutzer 65532 → `sudo chown 65532:65532 secrets/*` |
| Ausgesperrt (kein Admin kann sich anmelden) | `$P user:create --username notfall --role Super-Admin` (siehe Kommandozeile) |
| Konto gesperrt | 15 Minuten warten oder `$P user:unlock --username …` |
