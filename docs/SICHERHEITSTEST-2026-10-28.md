# Sicherheitstest 28.10.2026 – Auswertung

| | |
| --- | --- |
| Version | 1.8.0 (Stand vor dem Test), Korrektur des kritischen Fundes in **1.8.1** |
| Datum | 28.10.2026 (über Nacht) |
| Umfang | gesamter Quellcode (Server, Oberfläche, Updater, Installer, Deployment), laufende Instanz im Produktionsmodus hinter Caddy mit TLS |
| Schwerpunkt | alles, was seit dem [letzten Pentest](PENTEST.md) dazugekommen ist: Freigabe durch Vorgesetzte, Benachrichtigungen, Personensuche, Export/Import, Formulare und Vorlagen aus Datei, Abbrechen durch Admins, neue Ticketliste, Navigationslinks, Update-Dienst ohne Docker |
| Ergebnis | **1 kritischer Fund (bereits behoben), 1 hoch, 7 mittel, 19 niedrig, 7 Info.** Alle Funde ab „Niedrig“ sind mit einem Test nachgestellt; Ausnahmen sind in der Tabelle markiert. Für jeden offenen Fund gibt es ein Issue (#16 bis #43, Info-Punkte gesammelt in #43). |

> **Einordnung:** Der Test lief in einer Testumgebung mit Simulatoren für Zammad, Microsoft Entra ID und ClamAV. Er ersetzt keinen unabhängigen Pentest gegen die echte Installation (siehe [GO-LIVE.md](GO-LIVE.md)). Die Beschreibungen hier und in den Issues nennen Ursache, Auswirkung und Behebung, aber keine fertigen Angriffsskripte.

## Zusammenfassung

Die Grundlagen halten: Anmeldung, Sitzungen, CSRF, Rechteprüfung je Ticketsystem, IDOR-Schutz, SSRF-Schutz, Uploads, Verschlüsselung und Sicherheits-Header sind sauber umgesetzt. Eine automatische Rechtematrix über alle 99 Routen und fünf Rollen sowie Scanner (nuclei, hadolint) fanden nichts.

Die Funde liegen fast alle in drei Bereichen:

1. **Identität über die E-Mail-Adresse.** Tickets (Zuordnung zum Zammad-Kunden) und Freigaben hängen an der E-Mail-Adresse, nicht an der festen Konto-ID. Wer ein Konto mit fremder Adresse bekommt (zweiter Tenant, lokales Konto, Zweitkonto), sieht fremde Tickets oder gibt Anfragen frei (ST-02, ST-06, ST-07).
2. **Verfügbarkeit.** Ein einzelner großer JSON-Request eines normalen Benutzers bringt das Portal zum Absturz; ein ungünstiges Prüfmuster in einem Formular blockiert es (ST-04, ST-05).
3. **Neue Funktionen mit Lücken im Detail.** Ein Admin für nur ein Ticketsystem kann das Zammad-Token auf einen eigenen Server umleiten (ST-03); beim Vier-Augen-Prinzip gehen Name, Beschreibung und Sichtbarkeit eines Formulars ohne Freigabe live (ST-08).

Der **kritische Fund ST-01** steckte im Update-Dienst ohne Docker, der erst am 28.10. (Version 1.8.0) dazukam: Er hätte einem bereits kompromittierten Dienstbenutzer zu root-Rechten verholfen. Er ist in 1.8.1 behoben, mit Regressionstest. Version 1.8.0 war nicht als Release veröffentlicht.

## Nachtrag 29.10.2026: Behebung in 1.9.0

Alle Funde bis auf vier sind in **Version 1.9.0** behoben, jeweils mit Regressionstest (`test/hardening.test.ts`, `test/identity.test.ts`, `test/admin-hardening.test.ts`, `test/data-hardening.test.ts` und Ergänzungen in bestehenden Tests). Die Nachstell-Tests aus dem Test laufen gegen 1.9.0 nicht mehr durch. Ausnahme ist ST-02: Dessen Test läuft im Simulator weiter durch, weil der Simulator dieselbe Domain für zwei Tenants als verifiziert meldet – bei Microsoft kann eine Domain nur in einem Tenant verifiziert sein. Mit realistisch getrennten Domains ist der Angriff abgewehrt (`test/identity.test.ts`).

| Status | Funde |
| --- | --- |
| **behoben** | ST-01 (1.8.1), ST-02 bis ST-08, ST-10 bis ST-13, ST-15 bis ST-27, ST-29, ST-30, ST-34, ST-35 |
| **teilweise** | **ST-09** Update-Dienst gehärtet (Kernel-, Namespace-, Rechte-Einschränkungen, keine Paketinstallation beim Update), aber ohne Schreibschutz des Dateisystems, weil `install.sh` Systemdateien schreibt; Datenbankzugriff als Dienstbenutzer statt root ist offen. **ST-14** Benachrichtigungen verschlüsselt, Abbruchgrund nicht mehr im Audit-Log, Titel und Fehlertexte nach der Aufbewahrungsfrist gelöscht – bis dahin stehen Titel und Fehlertext im Klartext in der Datenbank. **ST-31** volle GCM-Tags und asynchrones scrypt umgesetzt; AAD mit Datensatzbezug und Schlüsselrotation offen. **ST-32** Version, Zwischenzustand und Entra-Limit behoben; einmalig verwendbarer OIDC-`state` offen (nicht ausnutzbar), `amr` wird über GO-LIVE geprüft statt im Code |
| **offen** | **ST-28** „Private vulnerability reporting“ muss der Inhaber des Repositorys unter **Settings → Code security** einschalten (über die Schnittstelle dieser Sitzung nicht erlaubt). **ST-33** Rechte des Docker-Socket-Proxys (für das Bauen nötig, dokumentiert) |

## Nachtrag 29.10.2026, Nachmittag: Stand nach 1.10.2

Was seit 1.9.0 passiert ist:

| Version | Was | Fund |
| --- | --- | --- |
| 1.9.1 | Nicht erreichbares Zammad bremst die Verwaltung nicht mehr aus (Verbindungs-Timeout 5 s, 30 s Pause nach einem Ausfall, Stammdaten aus dem Zwischenspeicher) | Betrieb |
| 1.9.5 | Ticketlisten aus dem Zwischenspeicher, Verbindungen zu Zammad wiederverwendet, Log-Meldung bei langsamen Aufrufen | Betrieb |
| 1.9.7 | Nachrichten aus Zammad werden ohne fremdes HTML angezeigt: linearer Tokenizer erzeugt nur Text-Blöcke; Zitate eingeklappt | ergänzt ST-16 |
| 1.9.8, 1.9.10 | Nach Updates keine Mischung aus alten und neuen Programmteilen im Browser | Betrieb |
| 1.10.0 | Benachrichtigung bei Antworten: liest Nachrichten nur für Tickets bekannter Personen, nie interne Notizen | neu, mit Tests |
| **1.10.2** | **ST-32:** OIDC-`state` wird nach der Verwendung gesperrt (Tabelle `oidc_used_states`, gehasht); ein abgefangenes Transaktions-Cookie lässt sich kein zweites Mal einlösen | ST-32 behoben |
| **1.10.2** | **ST-14:** Anfragetitel verschlüsselt gespeichert (Zweck `request-title`); Bestand wird beim Start nachträglich verschlüsselt und die Datenbankdatei danach mit `VACUUM` bereinigt | ST-14 behoben |
| **1.10.2** | **ST-09:** Der Update-Dienst ohne Docker öffnet die Datenbank nicht mehr als root. Ein Helfer-Prozess (`updater/db-agent.ts`) mit den Rechten des Dienstbenutzers übernimmt Lesen, Schreiben, Sicherung und Wiederherstellung; root bleibt nur für `git`, `systemctl` und `install.sh` | ST-09 behoben (Test auf echter VM steht aus) |
| **1.10.2** | **ST-33:** Rechte des Socket-Proxys begründet, Restrisiko offen benannt, `UPDATER_ALLOW_BUILD=0` für Registry-Updates dokumentiert ([UPDATES.md](UPDATES.md#sicherheit-des-updaters)) | ST-33 dokumentiert |

| Status | Funde |
| --- | --- |
| **behoben** | ST-01 bis ST-27, ST-29, ST-30, ST-32, ST-34, ST-35 |
| **dokumentiert (Restrisiko)** | **ST-33** Die Docker-API lässt sich über einen Socket-Proxy nicht feiner begrenzen; wer den Updater-Container übernimmt, hat root auf der VM. Empfehlung: Updater zum Start weglassen, sonst Registry-Images mit `UPDATER_ALLOW_BUILD=0` |
| **zurückgestellt** | **ST-31 (Rest)** Bindung der verschlüsselten Werte an ihren Datensatz (AAD) und Schlüsselrotation. Braucht eine Migration aller verschlüsselten Werte; das Risiko eines Fehlers dabei ist größer als der Nutzen, solange der Hauptschlüssel geschützt liegt. Volle GCM-Tags und asynchrones scrypt sind umgesetzt |
| **beim Inhaber** | **ST-28** „Private vulnerability reporting“ unter **Settings → Advanced Security** einschalten. **ST-09** einmal Update und Zurückrollen auf einer Test-VM durchspielen, sobald ein signierter Release-Tag existiert |

## Funde

Die Spalte „Stand“ zeigt den aktuellen Stand (30.10.2026). Beim Test selbst waren alle Funde außer ST-01 und ST-35 offen.

| ID | Schwere | Fund | Stand |
| --- | --- | --- | --- |
| ST-01 | **Kritisch** | Update-Dienst (ohne Docker, root) folgte beim Übereignen von Dateien im Datenverzeichnis symbolischen Links → Rechteausweitung vom Dienstbenutzer zu root | **behoben in 1.8.1** (#15) |
| ST-02 | **Hoch** (bei mehreren Tenants, sonst Mittel) | E-Mail aus Entra ist ungeprüft und nicht eindeutig, entscheidet aber über Ticketzugriff und Freigaben | behoben in 1.9.0 (#16) |
| ST-03 | Mittel | Admin für ein Ticketsystem leitet das gespeicherte Zammad-Token durch Ändern der Adresse auf einen eigenen Server um (auch per Import) | behoben in 1.9.0 (#17) |
| ST-04 | Mittel | Ein großer JSON-Request (bis 40 MB) eines beliebigen Benutzers bringt den Prozess zum Absturz bzw. blockiert ihn ~19 s; gleichzeitige Uploads erschöpfen den Speicher | behoben in 1.9.0 (#18) |
| ST-05 | Mittel | ReDoS: Prüfmuster im Formular laufen ohne Zeitlimit; ein harmlos aussehendes Muster blockiert das Portal für alle | behoben in 1.9.0 (#19) |
| ST-06 | Mittel | Wer nur „Benutzer verwalten“ hat, legt ein lokales Konto mit der Adresse einer Person an, die noch nie im Portal war, und sieht deren Tickets und Freigaben | behoben in 1.9.0 (#20) |
| ST-07 | Mittel | Selbstfreigabe über ein eigenes Zweitkonto; jedes Konto kann als freigebende Person eingetragen werden | behoben in 1.9.0 (#21) |
| ST-08 | Mittel | Vier-Augen-Prinzip: Name, Beschreibung, sichtbare Gruppen und Aktiv-Status eines Formulars gehen ohne Freigabe live | behoben in 1.9.0 (#22) |
| ST-09 | Mittel | systemd-Unit des Update-Dienstes (root) ohne jede Härtung | behoben in 1.10.2, Test auf echter VM steht aus (#23) |
| ST-10 | Niedrig | Abbruch beim Lesen der Zammad-Antwort → Anfrage sofort „fehlgeschlagen“, „Erneut senden“ legt ein zweites Ticket an | behoben in 1.9.0 (#24) |
| ST-11 | Niedrig | `?` oder `#` am Ende der Zammad-Adresse umgeht die Prüfung „ohne Parameter“ → Pfad interner Aufrufe frei wählbar | behoben in 1.9.0 (#25) |
| ST-12 | Niedrig | `ALLOW_PRIVATE_TICKET_URLS` ist im Docker-Stack fest `true`, die Doku sagt, man könne es abschalten | behoben in 1.9.0 (#26) |
| ST-13 | Niedrig | Löschen eines Ticketsystems (auch per Import) lässt verschlüsselte Uploads fehlgeschlagener Anfragen dauerhaft liegen | behoben in 1.9.0 (#27) |
| ST-14 | Niedrig | Titel, Ablehnungs- und Abbruchgrund liegen im Klartext in der Datenbank (Anfragen, Benachrichtigungen, Audit-Log) | behoben in 1.10.2 (#28) |
| ST-15 | Niedrig | Sicherungen mit Dateirechten 0644; Sicherungen vor Updates werden nie gelöscht | behoben in 1.9.0 (#29) |
| ST-16 | Niedrig | Umwandlung von Zammad-HTML in Text mit quadratischer Laufzeit (präparierter Artikel blockiert das Portal) | behoben in 1.9.0, ergänzt in 1.9.7 (#30) |
| ST-17 | Niedrig | SVG-Logo-Filter per Namespace-Präfix und Entities umgehbar; nur die Sandbox-CSP verhindert XSS | behoben in 1.9.0 (#31) |
| ST-18 | Niedrig | Text-Vorlagen gehen als ungefiltertes HTML ins Ticket; Platzhalter in Attributen (`href="{{feld}}"`) erlauben `javascript:`-Links | behoben in 1.9.0 (#32) |
| ST-19 | Niedrig | Rate-Limiter: Aufräumen kostet ab 50 000 Adressen bei jedem Request O(n), keine Obergrenze, IPv6 je Adresse | behoben in 1.9.0 (#33) |
| ST-20 | Niedrig | Step-up und Passwortwechsel: derselbe TOTP-Code wird bei parallelen Requests zweimal angenommen; Sperre greift verspätet | behoben in 1.9.0 (#34) |
| ST-21 | Niedrig | 2FA einrichten ohne erneute Bestätigung (übernommene Sitzung sperrt den Inhaber aus) | behoben in 1.9.0 (#35) |
| ST-22 | Niedrig | Step-up über Entra: ohne `auth_time` gilt eine stille SSO-Anmeldung als Bestätigung | behoben in 1.9.0 (#36) |
| ST-23 | Niedrig | Personensuche ohne Recht `portal.use`, auch für lokale Konten; mit Zwei-Zeichen-Suchen sind Name, E-Mail und Abteilung aller Microsoft-Konten im Portal abrufbar | behoben in 1.9.0 (#37) |
| ST-24 | Niedrig | „Tickets der Organisation anzeigen“ erlaubt auch Antworten in fremde Tickets | behoben in 1.9.0 (#38) |
| ST-25 | Niedrig | Freigabefrist durch Umtragen beliebig verlängerbar; Benachrichtigungen an frei gewählte Adressen | behoben in 1.9.0 (#39) |
| ST-26 | Niedrig | Audit-Lücken: Vorlagen-Änderungen über den Formular-Import, Veröffentlichen per Import, Verbindungstest | behoben in 1.9.0 (#40) |
| ST-27 | Niedrig | Lieferkette: Signaturschlüssel per Trust-on-first-use aus dem Repository, Node.js-Download nur mit Prüfsumme aus derselben Quelle | behoben in 1.9.0 (#41) |
| ST-28 | Niedrig | `SECURITY.md` verweist auf „Report a vulnerability“, die private Meldung von Schwachstellen ist im Repository aber nicht eingeschaltet | beim Inhaber: Einstellung im Repository (#42) |
| ST-29 | Info | JSON-Body `null` führt auf 13 Routen (auch Login) zu 500 statt 400 | behoben in 1.9.0 (#18) |
| ST-30 | Info | Härtung im Frontend und bei Werten: URL-Filter in `h()` mit Steuerzeichen umgehbar (heute nicht erreichbar), `valueMap`-Zugriff auf Prototyp-Schlüssel | behoben in 1.9.0 (#43) |
| ST-31 | Info | Kryptografie: kurze GCM-Tags werden akzeptiert, AAD ohne Datensatzbezug, keine Schlüsselrotation; `scryptSync` beim Transfer blockiert | teilweise in 1.9.0, Rest zurückgestellt (#43) |
| ST-32 | Info | Kleinere Punkte bei der Anmeldung: Version auf `/readyz`, Rechte-Auskunft im Zustand `mfa_pending`, Entra-Limit je IP bei geteilten Adressen, Transaktions-Cookie mehrfach verwendbar, `amr` ungeprüft | behoben in 1.10.2 (#43) |
| ST-33 | Info | Docker-Socket-Proxy des Updaters mit weitreichenden Rechten (Container anlegen) | dokumentiert in 1.10.2, Restrisiko (#43) |
| ST-34 | Info | Tag „freigegeben“ nicht reserviert; Ziel-Admin kann das Vier-Augen-Prinzip für sein System selbst abschalten | behoben in 1.9.0 (#43) |
| ST-35 | Info | Doku: Wiederholungsanleitung in `PENTEST.md` nutzt Ratenlimits, die die Konfiguration ablehnt; testssl.sh braucht `hexdump` | behoben (Doku) |

## Details

### ST-01 – Update-Dienst folgte symbolischen Links (Kritisch, behoben)

**Ort:** `updater/updater.ts` (`fixOwnership`, `restoreDb`), Unit `zammad-service-portal-updater` aus `deploy/native/install.sh`.
**Problem:** Der Update-Dienst läuft ohne Docker als root. Nach jedem Durchlauf (alle 30 s) gab er Datenbank- und Backup-Dateien im Datenverzeichnis an den Dienstbenutzer `zsp` zurück. Das Verzeichnis gehört `zsp`; `chown` folgt symbolischen Links. Ein Link im Backup-Ordner auf eine Systemdatei hätte diese an `zsp` übereignet.
**Voraussetzung:** Codeausführung als `zsp` (z. B. über eine andere Lücke im Portal). Keine Admin-Rechte nötig.
**Behebung (1.8.1):** Dateien werden mit `O_NOFOLLOW` geöffnet und nur übereignet, wenn sie echte Dateien bzw. Verzeichnisse mit genau einem Link sind (`fchown` am offenen Handle, kein Zeitfenster). Liegt an Datenbank oder Backup-Ordner ein Link, bricht der Dienst ab. Die Wiederherstellung löscht die Zieldatei und legt sie exklusiv neu an. Test: `test/updater.test.ts` („Links im Datenverzeichnis werden nie übereignet“). Die Härtung der Unit selbst ist ST-09.

### ST-02 – E-Mail als Identitätsmerkmal (Hoch bei mehreren Tenants)

**Ort:** `src/server/services/users.ts` (`upsertEntraUser`: `mail` aus Graph, ersatzweise `email`/`preferred_username`), `src/server/services/requests.ts` (`customerFor`), `src/server/services/approvals.ts` (Zuordnung über `approver_email`), `src/server/services/notifications.ts`.
**Problem:** Konten werden über die `oid` erkannt, aber der Zammad-Kunde (alle Tickets samt Verlauf) und offene Freigaben werden über die E-Mail-Adresse gefunden. Das Graph-Attribut `mail` setzt der Administrator des jeweiligen Tenants beliebig, auch auf Adressen fremder Domains. Für Entra-Konten wird nicht verhindert, dass zwei Konten dieselbe Adresse haben (für lokale Konten schon, siehe PT-13).
**Auswirkung:** Ein Konto aus einem zweiten erlaubten Tenant mit der Adresse einer Person aus dem ersten sieht deren Tickets, antwortet in ihrem Namen und entscheidet ihre Freigaben. In `SICHERHEIT.md` steht dagegen „keine Zuordnung über frei manipulierbare Attribute“.
**Voraussetzung:** mehrere Tenants in `ENTRA_ALLOWED_TENANTS`, deren Administratoren sich nicht vollständig vertrauen, oder ein kompromittiertes Admin-Konto in einem davon.
**Empfehlung:** Erlaubte Mail-Domains je Tenant konfigurieren und andere Adressen nicht übernehmen; doppelte Adressen über alle aktiven Konten verhindern (Alarm im Log); verifizierte Quelle bevorzugen (UPN bzw. `xms_edov`); Freigaben bei der ersten Zuordnung an die Konto-ID binden; Doku korrigieren.

### ST-03 – Zammad-Token folgt einer geänderten Adresse (Mittel)

**Ort:** `src/server/routes/admin.ts` (`readSystemBody`, `PUT /api/admin/systems/:systemId`, `POST …/test`), `src/server/services/transfer.ts` (Import behält das vorhandene Token).
**Problem:** Wird die Zammad-Adresse ohne neues Token geändert, bleibt das gespeicherte Token erhalten und geht beim nächsten Aufruf an die neue Adresse. Die Rolle „Ziel-Admin“ (Recht `system.manage` nur für ein System) sieht das Token sonst nie. Beim Import zeigt die Vorschau die geänderte Adresse nicht an.
**Auswirkung:** Klartext-Token mit Zammad-Recht `admin.user` (im Modus On-Behalf-Of) beim Admin eines einzelnen Systems; der Verbindungstest wird nicht protokolliert.
**Empfehlung:** Bei geändertem Origin ein neues Token verlangen (sonst 422); beim Import in diesem Fall ohne Token und inaktiv übernehmen; Vorschau zeigt alte und neue Adresse; Adresswechsel und Verbindungstest ins Audit-Log.

### ST-04 – Absturz und Speicherengpass durch große JSON-Requests (Mittel)

**Ort:** `src/server/http/core.ts` (`readJson`), `src/server/routes/portal.ts` (Body-Limit 40 MB beim Absenden, 30 MB bei Antworten), `src/server/routes/admin.ts` (Transfer 40 MB), `Dockerfile` (`--max-old-space-size=384`), `deploy/docker-compose.yml` (`mem_limit 512m`).
**Problem:** Dateien kommen als Base64 im JSON. Der ganze Body wird vor dem Handler synchron geparst, ohne Grenze für Tiefe oder Anzahl der Elemente. Die Formular-ID muss nicht existieren.
**Auswirkung (nachgestellt):** 40 MB flaches Array → `JavaScript heap out of memory`, Prozess endet (Exit 134). 40 MB tief verschachtelt → Event-Loop ~19 s blockiert. Gleichzeitige 40-MB-Requests: +150 MB Speicher je Request (8 gleichzeitig: 616 MB), auch wenn sie am Ende abgelehnt werden.
**Voraussetzung:** beliebiges aktives Konto.
**Empfehlung:** kurzfristig vor `JSON.parse` Tiefe und Anzahl der Strukturzeichen linear prüfen (z. B. Tiefe > 64 oder > 100 000 ablehnen) und nur Objekte als Body annehmen; Body-Limit aus der Upload-Grenze ableiten; globale Grenze für Bytes „im Flug“ und höchstens 1–2 große Requests je Benutzer. Langfristig Uploads als Binär-Stream statt Base64.

### ST-05 – ReDoS über Prüfmuster (Mittel)

**Ort:** `src/shared/form.ts` (Prüfmuster der Felder, Ausführung bei jeder Eingabe), `test/security-app.test.ts` (der vorhandene ReDoS-Test scheitert schon an der Längenprüfung und prüft den Regex gar nicht).
**Problem:** Muster aus dem Formular-Editor laufen synchron in der Regex-Engine von V8, ohne Zeitlimit. Schon `([A-Za-z]+ ?)+` mit 26–29 Zeichen Eingabe blockiert den Server 4–37 s; jedes weitere Zeichen verdoppelt die Zeit.
**Auswirkung:** Ein gut gemeintes Muster macht das Portal für alle unbenutzbar, ausgelöst von jedem Benutzer.
**Empfehlung:** lineare Regex-Engine (`--enable-experimental-regexp-engine`, Flag `l`) oder Prüfung in einem Worker mit Zeitlimit; verschachtelte Quantoren beim Speichern ablehnen; Test mit kurzer Eingabe neu schreiben.

### ST-06 – Lokales Konto mit fremder Adresse (Mittel)

**Ort:** `src/server/routes/admin.ts` (`POST /api/admin/users`), `src/server/services/users.ts` (`emailInUse`), Zuordnung wie ST-02.
**Problem:** Die Sperre aus PT-13 greift nur, wenn die Adresse schon einem Konto gehört. Für Personen, die sich noch nie angemeldet haben, kann ein Konto mit „Benutzer verwalten“ ein lokales Konto mit ihrer Adresse anlegen.
**Auswirkung:** Das lokale Konto sieht die Zammad-Tickets der Person und entscheidet Freigaben, die an ihre Adresse gerichtet sind.
**Empfehlung:** Lokale Konten nicht über die E-Mail mit Zammad-Kunden verknüpfen und nicht als freigebende Person zulassen (außer ausdrücklich so eingerichtet); E-Mail lokaler Konten nur mit zusätzlichem Recht setzen.

### ST-07 – Selbstfreigabe über ein Zweitkonto (Mittel)

**Ort:** `src/server/services/approvals.ts` (`checkApprover`).
**Problem:** Geprüft wird nur, dass die freigebende Person nicht dieselbe Adresse bzw. dasselbe Konto ist. Jedes andere Konto ist erlaubt, auch ein eigenes Zweit- oder Admin-Konto.
**Empfehlung:** Nur Entra-Konten als freigebende Personen; optional eine Gruppe je Freigabe-Feld oder Abgleich mit dem Vorgesetzten aus Graph (`/me/manager`); UPN/oid der freigebenden Person im Ticket vermerken.

### ST-08 – Vier-Augen-Prinzip deckt Formular-Stammdaten nicht ab (Mittel)

**Ort:** `src/server/routes/admin.ts` (`PUT /api/admin/systems/:systemId/forms/:formId`).
**Problem:** Name, Beschreibung, sichtbare Gruppen und Aktiv-Status liegen am Formular, nicht an der Version. Ein Formular-Editor ohne Recht zum Veröffentlichen ändert sie sofort, auch wenn das System Freigaben verlangt.
**Auswirkung:** Irreführende Texte im Portal oder ein auf eine Gruppe beschränktes Formular für alle sichtbar, ohne zweite Person.
**Empfehlung:** Diese Felder in die Formularversion aufnehmen (oder Änderungen daran nur mit `form.publish` bzw. über den Freigabeweg).

### ST-09 – Update-Dienst ohne Härtung (Mittel)

**Ort:** `deploy/native/install.sh` (Unit `zammad-service-portal-updater`).
**Problem:** Die Unit läuft als root und hat außer `PrivateTmp` keine Einschränkung, anders als die stark gehärteten Units von Web und Worker. Jeder Fehler im Updater (wie ST-01) wirkt dadurch systemweit. Außerdem öffnet der Updater die Datenbank als root.
**Empfehlung:** so weit härten, wie `install.sh` es zulässt (`ProtectHome`, `ProtectKernel*`, `RestrictAddressFamilies`, `SystemCallFilter`, möglichst `ReadWritePaths`); besser die Rollen trennen: Datenbank-Zugriff als `zsp` (z. B. kleiner Helfer per `runuser`), root nur für `git`, `systemctl` und `install.sh`.

### ST-10 bis ST-28 (Niedrig)

| ID | Ort | Problem und Empfehlung |
| --- | --- | --- |
| ST-10 | `src/server/connectors/zammad.ts` (`call`), `src/server/services/requests.ts` | Das Lesen des Antwort-Bodys liegt außerhalb des `try`, ein Abbruch gilt nicht als wiederholbar; nach „Erneut senden“ (`attempts = 0`) entfällt die Duplikatprüfung. Nachgestellt: zwei gleiche Tickets. → Lesefehler als wiederholbaren `ConnectorError` werfen, Duplikatprüfung an ein Feld koppeln, das vor dem Anlegen gesetzt wird, oder Tag `portal-req-<id>`. |
| ST-11 | `src/server/services/systems.ts` (`validateSystemUrl`), `connectors/zammad.ts` | `u.search`/`u.hash` sind bei leerem `?`/`#` leer; der API-Pfad wird dann zur Query. Mit `system.manage` lassen sich beliebige interne Pfade aufrufen, Fehlermeldungen liefern Teile der Antwort. → Rohstring auf `[?#]` prüfen, normalisierte Adresse speichern, Aufruf-URL per `new URL()` bauen. |
| ST-12 | `deploy/docker-compose.yml`, `deploy/native/install.sh`, `docs/SICHERHEIT.md` | Unter `environment:` fest `true`, ein Wert in `.env` wirkt nicht. → Standardwert über `.env` (`${ALLOW_PRIVATE_TICKET_URLS:-true}`), besser Allowlist für Zammad-Hosts; eigene Compose-Netze per IP sperren. |
| ST-13 | `src/server/routes/admin.ts` (System löschen), `src/server/services/transfer.ts` | `DELETE FROM requests` ohne `removeRequestFiles`. → Dateien vorher entfernen, Aufräumjob für verwaiste Ordner unter `uploads/`. |
| ST-14 | `requests.title`, `notifications.body`, `audit_log.details` | Titel (aus Benutzereingaben), Ablehnungs- und Abbruchgrund im Klartext, teils lange aufbewahrt, im Audit-Log dauerhaft. → verschlüsselt speichern oder ohne Freitext; im Audit nur „Grund angegeben“; Doku präzisieren. |
| ST-15 | `src/server/cli.ts` (`backup`), `updater/updater.ts`, `docs/BETRIEB.md` | `VACUUM INTO` legt 0644 an; Update-Sicherungen bleiben für immer. → `chmod 600`, `umask 077` im Doku-Cronjob, nur die letzten N Update-Sicherungen behalten. |
| ST-16 | `src/server/routes/portal.ts` (`htmlToText`) | Regexe laufen bei vielen `<` ohne `>` quadratisch; ein Artikel aus rohem HTML blockiert jede Ticketansicht ~17 s. Nur über die Zammad-API mit Token oder Import erreichbar. → linearer Tokenizer. |
| ST-17 | `src/server/services/files.ts` (`checkLogo`) | Regex-Blockliste umgehbar (`<h:script>`, `x:href`, `&#x6A;avascript:`, `<animate>`/`<set>`). Die Sandbox-CSP verhindert XSS, solange der Header ankommt. → Allowlist-Parser oder SVG in PNG umwandeln; SVG außerhalb von Bild-Kontexten als Download. |
| ST-18 | `src/shared/template.ts`, `src/server/services/requests.ts` | `form.edit`/`template.edit` bringt beliebiges HTML in alle Tickets eines Formulars; `href="{{feld}}"` übernimmt `javascript:` aus der Eingabe. Benutzerwerte im Text sind korrekt escaped. → Allowlist-Sanitizer beim Speichern und Import, Platzhalter in Tags verbieten. |
| ST-19 | `src/server/http/core.ts` (`RateLimiter`) | `sweep()` bei jedem Aufruf über 50 000 Einträgen, Einträge erst nach 1 h entfernt, keine Obergrenze; IPv6 je Adresse. → zeitgesteuert aufräumen, volle Buckets entfernen, Obergrenze, IPv6 auf /64 kürzen. |
| ST-20 | `src/server/routes/auth.ts` (Step-up, Passwortwechsel) | Kontostand vor dem asynchronen scrypt gelesen, `totp_last_step` ohne Bedingung geschrieben. → Code atomar verbrauchen (`UPDATE … WHERE totp_last_step < ? RETURNING`), nach dem Hash frisch lesen und Sperre prüfen. |
| ST-21 | `src/server/routes/auth.ts` (`totp/setup`, `totp/enable`) | Im Zustand `active` kein Passwort oder Step-up nötig; die anderen Sitzungen des Inhabers werden beendet. → Passwort oder Step-up verlangen, Alarm-Log. |
| ST-22 | `src/server/auth/oidc.ts` | `auth_time ?? iat`; ob neu angemeldet wurde, hängt dann nur an `prompt=login` in der Browser-URL. → beim Step-up `auth_time` verlangen (optionalen Claim in der App-Registrierung als Pflicht dokumentieren), besser Authentifizierungskontext (`acrs`). |
| ST-23 | `src/server/routes/portal.ts` (`/api/portal/people`) | nur Anmeldung nötig, ab 2 Zeichen, 8 Treffer je Suche – systematisch abfragbar. → `portal.use`, nur Entra-Konten, mindestens 3 Zeichen, eigenes Limit. |
| ST-24 | `src/server/connectors/zammad.ts` (Antworten) | Mit „Tickets der Organisation anzeigen“ (Modus Kundenfeld) auch Antworten in Tickets von Kolleginnen. → Antworten nur ins eigene Ticket. |
| ST-25 | `src/server/services/approvals.ts` (`reassign`) | Jedes Umtragen setzt die Frist neu und benachrichtigt eine frei gewählte Adresse. → Frist ab Erstellung, Zahl der Wechsel begrenzen. |
| ST-26 | `src/server/routes/admin.ts` (Formular-Import, Verbindungstest) | Vorlagen-Änderungen über den Import und Veröffentlichen per Import erscheinen nicht als eigene Einträge, der Verbindungstest gar nicht. → Audit-Einträge ergänzen. |
| ST-27 | `deploy/native/install.sh`, `deploy/install.sh`, `setup.sh` | Erster Bezug per `curl … | bash` und `git clone` ohne Signaturprüfung; `allowed_signers` kommt aus demselben Repository; Node.js-Prüfsumme kommt von derselben Quelle wie das Paket. → Fingerprint des Release-Schlüssels über zweiten Kanal veröffentlichen und bei der Installation anzeigen; `SHASUMS256.txt.sig` mit gepinnten Node-Release-Schlüsseln prüfen. |
| ST-28 | `SECURITY.md`, Repository-Einstellungen | „Private vulnerability reporting“ ist aus; Meldende landen sonst bei öffentlichen Issues. → unter **Settings → Code security** einschalten. |

### ST-29 bis ST-35 (Info)

| ID | Punkt | Empfehlung |
| --- | --- | --- |
| ST-29 | Body `null` (gültiges JSON) → 500 mit Fehler-Log auf 13 Routen, auch vor der Anmeldung. Keine Daten offengelegt. | In `readJson` nur Objekte annehmen, sonst 400 (zusammen mit ST-04). |
| ST-30 | `h()` filtert `javascript:` mit `^\s*`, Tab/Zeilenumbruch/C0-Zeichen kommen durch (heute sind alle URLs serverseitig geprüft). `valueMap[value]` trifft `constructor`/`__proto__`. | Steuerzeichen entfernen und per `new URL` nur erlaubte Protokolle; `Object.hasOwn`. |
| ST-31 | GCM-Tags kürzer als 16 Byte werden akzeptiert; AAD nur Zweck; keine Rotation von `SECRET_KEY`; `scryptSync` im Transfer auf dem Haupt-Thread. | `authTagLength: 16`; Datensatz-ID in die AAD; Schlüssel-ID im Format und `key:rotate`; asynchrones scrypt über die vorhandene Semaphore. |
| ST-32 | `/readyz` nennt die Version ohne Anmeldung; `/api/me` liefert im Zustand `mfa_pending` Rechte; Entra-Anmeldung 10/min je IP (geteilte Adressen); OIDC-Transaktions-Cookie mehrfach verwendbar; `amr` wird nicht geprüft. | Version nur intern; in Zwischenzuständen nur `state` und `csrf`; Limit für `entra/login` großzügiger; `state` nach Verwendung sperren; `amr`/Conditional Access in GO-LIVE prüfen. |
| ST-33 | Socket-Proxy erlaubt dem Updater-Container Container zu erzeugen und zu starten. Die App erreicht den Proxy nicht. | Rechte auf das Nötigste begrenzen, Risiko dokumentieren. |
| ST-34 | Tag „freigegeben“ kann aus Formular-Einstellungen kommen; ein Ziel-Admin kann Vier-Augen für sein System abschalten, allein veröffentlichen und wieder einschalten. | Tag reservieren; Schalter nur mit globalem Recht oder ins Audit mit Hinweis. |
| ST-35 | `docs/PENTEST.md` nutzte Ratenlimits über dem erlaubten Bereich; testssl.sh braucht `hexdump`. | korrigiert. |

## Vorgehen

| # | Prüfung | Werkzeug | Ergebnis |
| --- | --- | --- | --- |
| 1 | White-Box-Review in fünf getrennten Bereichen (Anmeldung/Sitzungen, Rechte/Logik, Ausgabe/Injection, Daten/SSRF/Krypto, Updater/Installer/Deployment) | Code-Review, je Fund ein Test gegen die echte Anwendung | 34 Funde (ST-02 bis ST-35, Dubletten zusammengefasst), ST-01 sofort behoben |
| 2 | Rechtematrix: alle 99 Routen × anonym, Benutzer, Ziel-Admin eines anderen Systems, Auditor (schreibend), Super-Admin ohne CSRF-Token, mit fremdem `Origin`, mit `text/plain` | eigenes Testskript | keine Abweichung; alle Sicherheits-Header auf allen Antworten |
| 3 | Fuzzing aller 63 schreibenden Routen mit 11 feindlichen Bodies (`null`, Arrays, falsche Typen, Prototype Pollution, 5 000-fach verschachtelt, 3 MB-Strings, Unicode/Steuerzeichen) | eigenes Testskript | nur ST-29 (500 bei `null`), kein Absturz |
| 4 | Ratenbegrenzung der Anmeldung mit gefälschtem `X-Forwarded-For` | eigenes Testskript | greift, XFF wird ohne vertrauenswürdigen Proxy ignoriert |
| 5 | Bekannte Schwachstellen, Fehlkonfigurationen – anonym und mit Admin-Sitzung | nuclei 3.3.7, ~6 300 bzw. ~4 900 Templates | 0 Funde (1 Info-Fehlalarm `jan-detect` auf `/healthz`, wie im letzten Test) |
| 6 | TLS (Caddy) | openssl s_client (testssl.sh lief mangels `hexdump` nicht) | nur TLS 1.2/1.3, nur AEAD mit Forward Secrecy, kein CBC, kein RSA-Schlüsseltausch |
| 7 | Dockerfiles, Shell-Skripte | hadolint 2.12, shellcheck 0.10 | ohne Befund (shellcheck nur Stil/Info) |
| 8 | Host-Header über Caddy und direkt | curl | App antwortet in Produktion mit 421, Caddy liefert für fremde Hosts eine leere Antwort |
| 9 | Repository-Einstellungen | GitHub-API | ST-28 |

Nicht geprüft: echtes Zammad, echtes Entra ID (insbesondere ST-02, ST-22 gegen echte Tenants), der Docker-Stack in Docker (in der Testumgebung kein Docker), trivy (Release nicht abrufbar).

## Geprüft und in Ordnung

- **Sitzungen:** 256-Bit-Token, in der Datenbank nur als SHA-256; Cookie `__Host-`, HttpOnly, Secure, SameSite=Strict; neue Sitzungs-ID nach jeder Anmeldung und nach dem zweiten Faktor; Leerlauf und Höchstdauer serverseitig; Rechte, Deaktivierung und 2FA-Zustand bei jedem Request neu geprüft.
- **CSRF und Herkunft:** Token, `Origin` und `Sec-Fetch-Site` für alle ändernden Methoden, auch auf öffentlichen Routen; nur `application/json`; keine offenen Weiterleitungen.
- **OIDC:** state, nonce, PKCE S256; nur RS256; Aussteller je Tenant, Tenant-Allowlist, exakter `aud`; JWKS nur RSA ≥ 2048 Bit; Step-up an Sitzung und `oid` gebunden.
- **Lokale Anmeldung:** gleiche Laufzeit für unbekannte Konten, atomarer Fehlversuchszähler, fortschreitende Sperre, TOTP mit Wiederverwendungsschutz beim Login.
- **Rechte:** zentrale Prüfung mit System-ID aus dem Pfad hält; nachgeschlagene Objekte werden gegen das System geprüft; Rechteausweitung über Rollen und Benutzer (PT-09/PT-10) bleibt geschlossen; keine IDOR bei Tickets, Artikeln, Anhängen, Anfragen, Freigaben und Freigabe-Dateien; Ticketliste (neue Suche und Fallback) immer über `mayView` gefiltert.
- **Freigaben:** doppelte Entscheidung atomar; Entscheiden nach Abbruch, Rückzug oder Ablauf ergibt 409; nach dem Umtragen kein Zugriff mehr für die alte Person; Abbrechen gegen den Worker atomar.
- **Ausgabe:** kein `innerHTML`, `eval`, `srcdoc` oder `postMessage`; Navigationslinks, Farben und Logo-Größen serverseitig geprüft und über CSSOM gesetzt; Zammad-Artikel nur als Text; Feldwerte im Ticket escaped; CSV gegen Formel-Injection geschützt; Downloads mit `attachment`, Sandbox-CSP und bereinigtem Dateinamen.
- **SSRF:** Prüfung der IP bei jedem Verbindungsaufbau (gegen DNS-Rebinding), IPv4-Kurzformen und IPv6-Sonderformen korrekt, keine Weiterleitungen, TLS-Prüfung immer aktiv.
- **Uploads und Daten:** Typ am Inhalt erkannt, strenge Base64-Prüfung, ClamAV fail-closed, Speicherung unter UUIDs, verschlüsselt (AES-256-GCM, Zufalls-IV, HKDF je Zweck), 0600; scrypt N=2¹⁷ mit `timingSafeEqual`; Log-Schwärzung.
- **Export/Import:** ohne Passwort keine Geheimnisse; Tokens an das Kürzel gebunden; KDF-Parameter fest; Prototype Pollution abgefangen; Rollen werden nicht importiert; alles in einer Transaktion.
- **Updater:** Versionsangabe streng geprüft (keine Git- oder Shell-Injection), Signaturprüfung fail-closed, Code-Verzeichnis gehört root, `portal.env` für den Dienstbenutzer nur lesbar; Docker-Modus ohne ST-01.
- **Server:** Zeitgrenzen für Header und Requests, Header-Größe begrenzt, Host-Prüfung, Fehler ohne Stacktrace.

## Empfohlene Reihenfolge

1. **ST-04** und **ST-29** (ein Commit in `readJson` beseitigt Absturz und 500er) und **ST-05** – Verfügbarkeit für alle.
2. **ST-02**, **ST-06**, **ST-07** – vor dem Betrieb mit mehreren Tenants und vor dem breiten Einsatz der Freigaben.
3. **ST-03**, **ST-08**, **ST-09**.
4. Niedrige Punkte nach Aufwand, Info-Punkte bei Gelegenheit.

Rohdaten (Scanner, Testskripte) liegen nicht im Repository.
