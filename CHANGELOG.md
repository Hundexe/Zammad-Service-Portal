# Änderungen

## 1.2.0 – 26.10.2026

- Installation mit einem Befehl: `curl -fsSL …/setup.sh | sudo bash` – Auswahl Docker, direkt auf Debian/Ubuntu oder Demo
- Neue Variante ohne Docker (`deploy/native/install.sh`): Node.js 24, Caddy, optional ClamAV, gehärtete systemd-Dienste, Konfiguration in `/etc/zammad-service-portal/portal.env`, Kommandozeile `service-portal-cli`
- Demo ohne Installation: `npm run demo` auf http://localhost:3000, auf Wunsch im Netz erreichbar
- Aufruf über die IP-Adresse: Caddy liefert auch ohne SNI das richtige Zertifikat (`default_sni`)
- Gemeinsame Hilfsfunktionen der Installationsskripte in `deploy/lib.sh`
- Online-Demo auf GitHub Pages (statisch, kostenlos): Oberfläche mit Simulator im Browser, gebaut mit `tools/build-pages.ts`, veröffentlicht mit `tools/publish-pages.sh`

## 1.1.0 – 22.10.2026

Oberfläche:

- Neues, ruhiges Design: helle Flächen ohne Rahmen, große Schrift (Inter, selbst ausgeliefert), durchscheinende Navigationsleiste
- Startseite mit großer Farbfläche je Ticketsystem und Auswahl als Segmentschalter; Formulare als Liste mit Symbolen
- Anmeldung zweigeteilt (Farbfläche und Formular), Ticketverlauf als Nachrichtenverlauf
- Dunkles Design per Schalter (Mond/Sonne), folgt sonst der Systemeinstellung
- Verwaltung mit Seitenleiste im macOS-Stil; Branding-Vorschau zeigt das neue Layout
- Alle Screenshots neu, zusätzlich Erstanmeldung und dunkles Design
- Beispieldaten, Demo und Doku neutral (fiktive Firmen- und Personennamen), Repository öffentlich klonbar

Sicherheit (gezielte Nachprüfung der lokalen Anmeldung, siehe docs/PENTEST.md, PT-09 bis PT-16):

- Keine Rechteausweitung mehr über „Benutzer verwalten“ oder „Rollen verwalten“: niemand vergibt oder übernimmt mehr Rechte, als er selbst hat
- Falsche 2FA-Codes, Bestätigungen und Passwortwechsel zählen zur Kontosperre; Sperre wächst von 15 Minuten bis 24 Stunden
- 2FA-Pflicht für lokale Admins wird bei jeder Anfrage geprüft
- Lokale Sitzungen enden sofort, wenn die lokale Anmeldung abgeschaltet wird
- Neue Sitzungs-ID nach dem zweiten Faktor
- E-Mail-Adressen sind eindeutig; lokale Konten können nicht auf Tickets von Microsoft-Konten zugreifen
- 20 neue Sicherheitstests (127 insgesamt)

Konfiguration:

- Alle Einstellungen in einer Datei auf dem Server (`deploy/.env`), kommentiert in `deploy/.env.example`
- Neu einstellbar: `LOCAL_USER_REQUIRE_TOTP`, `LOGIN_MAX_ATTEMPTS`, `LOGIN_LOCK_MINUTES`, `LOGIN_LOCK_PROGRESSIVE`, `LOGIN_LOCK_MAX_MINUTES`, `PASSWORD_MIN_LENGTH`, `RATE_LIMIT_LOGIN_PER_MINUTE`; `LOCAL_ADMIN_REQUIRE_TOTP`, `STEPUP_MINUTES` und die Ratenbegrenzung wirken jetzt auch im Docker-Stack
- Sicherheitsrelevante Werte haben Grenzen; außerhalb davon startet das Portal nicht

## 1.0.0 – 21.10.2026

Erste Version.

- Anmeldung über Microsoft Entra ID (mehrere Tenants) und lokale Konten mit generiertem Passwort, Pflicht-Passwortwechsel und Zwei-Faktor-Anmeldung für Admins
- Mehrere Zammad-Instanzen mit eigenem Branding (Farben, Logos, Texte)
- Formular-Editor mit Drag-and-Drop, Live-Vorschau, Sichtbarkeitsregeln, Gruppenfreigabe, Versionen und Vier-Augen-Prinzip
- Freigabe von Zammad-Objekten (Ticket-Attribute inkl. tree_select) als Auswahlfelder
- Tickets im Namen des Kunden mit Portal-Tag; Meine Tickets mit Übersichten, Verlauf und Antworten
- Rollen und Rechte global oder pro Ticketsystem, Audit-Log mit Hash-Kette
- Updates aus der Oberfläche mit Signaturprüfung, Backup und automatischem Rollback
- Docker-Compose-Stack mit Caddy, ClamAV, gehärteten Containern
- 107 automatisierte Tests, Penetrationstest
