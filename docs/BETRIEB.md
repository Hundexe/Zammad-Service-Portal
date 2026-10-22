# Betrieb

Alle Befehle im Verzeichnis `deploy/` auf der VM.

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

Für Monitoring (z. B. Checkmk, Zabbix, Uptime Kuma) eignet sich `/readyz`: HTTP 200 mit Versionsnummer, wenn App und Datenbank laufen. Zusätzlich in der Verwaltung: **Zustellung** (fehlgeschlagene Anfragen) und **Updates** (meldet sich der Updater?).

Wichtige Log-Meldungen:

| Meldung | Bedeutung |
| --- | --- |
| `Zustellung fehlgeschlagen, neuer Versuch geplant` | Zammad kurz nicht erreichbar – erledigt sich meist selbst |
| `Zustellung endgültig fehlgeschlagen` | z. B. Gruppe in Zammad umbenannt → korrigieren, unter **Zustellung** erneut senden |
| `Virenscanner nicht erreichbar` | ClamAV läuft nicht oder lädt noch Signaturen (nach dem Start bis zu 2 Minuten) |
| `Microsoft-Anmeldung abgelehnt` | Grund steht dabei (z. B. Tenant nicht erlaubt, Secret abgelaufen) |
| `Entra liefert zu viele Gruppen im Token` | Gruppenanspruch auf „der Anwendung zugewiesene Gruppen“ umstellen |

## Kommandozeile

```bash
P="docker compose exec app /nodejs/bin/node src/server/cli.ts"
$P user:create --username max --name "Max Muster" --email max@firma.de          # normaler Benutzer, Passwort wird erzeugt
$P user:create --username notfall --name "Notfall-Admin" --role Super-Admin      # Admin (2FA bei erster Anmeldung)
$P user:reset-password --username max [--reset-totp]                              # neues generiertes Passwort
$P user:unlock --username max
$P user:list
$P backup                                     # Sicherung nach /data/backups/
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
15 2 * * * cd /opt/zammad-service-portal/deploy && docker compose exec -T app /nodejs/bin/node src/server/cli.ts backup --out /data/backups/taeglich.sqlite && docker compose cp app:/data/backups/taeglich.sqlite /opt/backup/portal-$(date +\%F).sqlite && find /opt/backup -name 'portal-*.sqlite' -mtime +30 -delete
```

`/opt/backup` sollte vom Proxmox-Backup (oder einem anderen Sicherungssystem) mit erfasst werden. Die VM selbst lässt sich zusätzlich mit Proxmox-Snapshots sichern.

## Wiederherstellung

```bash
cd /opt/zammad-service-portal/deploy
docker compose stop app worker updater
docker run --rm -v service-portal_portal-data:/data -v /opt/backup:/backup alpine:3.20 sh -c \
  'cp /backup/portal-2026-10-20.sqlite /data/portal.sqlite && rm -f /data/portal.sqlite-wal /data/portal.sqlite-shm && chown 65532:65532 /data/portal.sqlite'
docker compose up -d
```

Auf einer neuen VM: Repository klonen, `.env`, `certs/` und **denselben** `secret_key` zurückspielen, dann wie oben die Datenbank einspielen und `docker compose up -d`.

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
