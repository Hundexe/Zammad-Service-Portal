# Änderungen

## 1.4.2 – 28.10.2026

- Bedienelemente verhalten sich wie in einer App: Schaltflächen, Navigation, Benutzermenü, Reiter, Formular-Kacheln und Seitenleiste lassen sich nicht mehr versehentlich markieren, Links und Bilder nicht mehr wegziehen (kein Drag-Bild mit Adresse). Tickettexte, Tabellen, Eingabefelder, Ticketnummern und Passwort-Anzeigen bleiben markier- und kopierbar; das Verschieben von Feldern im Formular-Editor funktioniert weiter

## 1.4.1 – 27.10.2026

- Behoben: Aufklapplisten von Auswahlfeldern waren im dunklen Design unter Windows (Chrome/Edge) unlesbar – helle Schrift auf weißer Liste, vor allem in den Stilen Glas und Material mit durchscheinenden Feldern. Die Optionen haben jetzt in jedem Stil einen deckenden Hintergrund und die Schriftfarbe des Designs

## 1.4.0 – 27.10.2026

Oberfläche:

- **Stile pro Ticketsystem:** Standard, Glas (durchscheinend mit Unschärfe, im Stil von Apple), Fluent (im Stil von Microsoft), Material (im Stil von Google) und Kontrast (besonders gut lesbar) – jeweils hell und dunkel
- **Farben:** entweder die abgestimmten Farben des Stils (nichts einzustellen) oder eigene – mit acht fertigen Kombinationen oder frei gewählt; eigene Farben bleiben beim Wechsel erhalten
- Stil-Auswahl in der Verwaltung mit Live-Vorschau jedes Stils; auch für die Anmeldeseite
- Auf heller Farbfläche erscheint automatisch das Logo für helle Flächen
- Moderner Feinschliff für alle Stile: sanfte Seitenübergänge, Lichtreflex auf der Farbfläche, ruhige Hover-Effekte
- Kein Aufblitzen beim Laden: der zuletzt gesehene Stil wird vor dem ersten Zeichnen gesetzt
- Bauteile der Stile sind per CSS `@scope` gekapselt; Browser ohne `@scope` zeigen die Farben und Formen des Stils mit Standard-Bauteilen

Tests: Stil- und Farbauswahl (Validierung, Kontraste aller Stil-Farben und Kombinationen, alte Daten ohne Stil, Veröffentlichung), insgesamt 202.

## 1.3.2 – 27.10.2026

- Signaturschlüssel von Microsoft (JWKS): Höchstalter bei dauerhafter Nichterreichbarkeit. Ab 24 h ohne Erneuerung stündlicher Alarm (`"event":"jwks_stale"`), nach `ENTRA_JWKS_MAX_STALE_HOURS` (Standard 72 h, 25–168) wird die Microsoft-Anmeldung gesperrt (`"event":"jwks_expired"`), bis die Schlüssel wieder abrufbar sind; Notfallkonten gehen weiter
- `cli.ts status` prüft, ob die Schlüssel von Microsoft abrufbar sind
- Doku: SICHERHEIT.md, BETRIEB.md (Log-Meldungen, Alarmregeln), GO-LIVE.md, REVIEW-2026-10.md (Nachtrag)

## 1.3.1 – 27.10.2026

Nachbesserungen zum zweiten Review (docs/REVIEW-2026-10.md, Abschnitt „Nachtrag“):

- **SSRF, behoben:** IPv4-mapped IPv6-Adressen in Hex-Schreibweise (`[::ffff:127.0.0.1]` wird vom URL-Parser zu `::ffff:7f00:1`) wurden nicht als Loopback erkannt. IPv6 wird jetzt vollständig ausgewertet, inklusive IPv4-kompatibel, NAT64, 6to4; Teredo, Dokumentations- und Site-Local-Adressen gesperrt
- TLS: SNI und Hostname-Prüfung ausdrücklich gesetzt und getestet (Name in der URL: SNI + Namensprüfung trotz Verbindung zur geprüften IP; IP in der URL: kein SNI, IP-SAN nötig)
- OIDC/JWKS: unbekannte und ungültige `kid`-Werte lösen keine Abruf-Flut aus, gleichzeitige Anfragen teilen sich einen Abruf, Schlüsselliste wird nach 24 h erneuert (zurückgezogene Schlüssel gelten nicht mehr), leere/kaputte Listen ersetzen die gültige nicht, nach Fehlschlag Wiederholung frühestens nach 30 s
- Offizieller Release-Signaturschlüssel in `deploy/release_signers`, von `install.sh` übernommen
- README auf aktuellem Stand

Tests: 9 neue, insgesamt 196.

## 1.3.0 – 27.10.2026

Umsetzung des externen Reviews (docs/REVIEW-2026-10.md, Issues #1–#14).

Sicherheit:

- Zammad-Felder: Kernattribute (`customer_id`, `owner_id`, `group_id`, `state_id`, `organization_id`, …) können aus Formularen nie gesetzt werden; freie Zuordnung nur in freigegebene Attribute – geprüft im Editor, beim Anlegen des Tickets und im Connector (#4)
- Neu je Ticketsystem: **Erlaubte Zammad-Gruppen**; Tickets nur in diese Gruppen, Warnung in der Übersicht ohne Liste (#4)
- `X-On-Behalf-Of` mit der Zammad-Kunden-ID statt der E-Mail-Adresse (#5)
- Ticketverlauf ohne E-Mail-Adressen; optional Namen der Bearbeiter ausblenden (#6)
- SSRF: Prüfung der aufgelösten IP bei jedem Verbindungsaufbau (DNS-Rebinding), eigene Dienstnamen gesperrt, `ALLOW_LOOPBACK_TICKET_URLS` nur für Demo (#7)
- OIDC: JWKS-Schlüssel unter 2048 Bit werden verworfen (#2)
- Step-up über Microsoft übernimmt Gruppen und Rollen frisch aus Entra; deaktivierte Benutzer kommen auch so nicht hinein (#12)
- Log-Ereignis mit `"alert": true` bei jeder lokalen Anmeldung (#13)

Betrieb:

- Kein doppeltes Ticket mehr, wenn die Antwort von Zammad verloren geht oder der Worker mitten in der Zustellung abstürzt (#11)
- `UPLOAD_MAX_FILE_MB`, `UPLOAD_MAX_TOTAL_MB` (#8)
- Neue Befehle: `backup:verify`, `restore`, `status`, `scanner:test` (#8, #10, #13)
- `tools/check-hardening.sh` (#9), `tools/loadtest.ts` (#11), `tools/release.sh` (#1), `tools/secret-scan.sh`

Doku:

- docs/GO-LIVE.md, docs/LASTTEST.md, docs/REVIEW-2026-10.md
- Zammad-Rechte je Betriebsart, Egress-Firewall, Monitoring und Alarme, Restore-Probe, manuelles Update/Rollback, Tabelle der Token-Prüfungen und Autorisierungstests
- SECURITY.md realistisch formuliert; keine Verweise mehr auf nicht vorhandene Tags (#1, #14)

Tests: 59 neue, insgesamt 187.

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
