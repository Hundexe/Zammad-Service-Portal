# Änderungen

## 1.10.2 – 29.10.2026

Restpunkte aus dem Sicherheitstest vom 28.10.2026 (Stand: [Nachtrag in der Auswertung](docs/SICHERHEITSTEST-2026-10-28.md#nachtrag-29102026-nachmittag-stand-nach-1102)):

- **Microsoft-Anmeldung (ST-32):** Der Einmalwert (`state`) wird nach der Verwendung gesperrt – ein abgefangenes Transaktions-Cookie lässt sich nicht ein zweites Mal einlösen (Migration 010)
- **Anfragetitel verschlüsselt (ST-14):** Titel stehen nicht mehr im Klartext in der Datenbank. Vorhandene Titel werden beim ersten Start einmalig verschlüsselt, danach wird die Datenbankdatei bereinigt (`VACUUM`, kann bei großen Datenbanken einige Sekunden dauern)
- **Update-Dienst ohne Docker (ST-09):** Öffnet die Datenbank nicht mehr als root. Aufträge, Status, Sicherung und Wiederherstellung laufen über einen Helfer-Prozess mit den Rechten des Dienstbenutzers; root bleibt nur für `git`, `systemctl` und `install.sh`
- **Docker-Updater (ST-33):** Rechte des Socket-Proxys begründet, Restrisiko dokumentiert, `UPDATER_ALLOW_BUILD=0` für Updates aus der Registry
- Auswertung des Sicherheitstests um den aktuellen Stand ergänzt

## 1.10.1 – 29.10.2026

- **Neue Anleitung [Microsoft-Anmeldung (Entra ID)](docs/ENTRA.md):** jeder Schritt im Entra Admin Center (App-Registrierung, Umleitungs-URIs, Secret oder Zertifikat, genau benötigte Rechte, Gruppen- und `auth_time`-Anspruch, App-Rollen, Zuweisung, bedingter Zugriff), ein oder zwei Tenants, Einrichtung im Portal mit und ohne Docker, Rechte an Gruppen, Test, Secret erneuern, Fehlertabelle mit AADSTS-Codes und Checkliste
- Installationsanleitung verweist für Entra auf die neue Anleitung; README-Version aktualisiert

## 1.10.0 – 29.10.2026

- **Benachrichtigung bei Antworten der IT:** Antwortet ein Bearbeiter in Zammad auf ein Ticket, erscheint im Portal unter der Glocke „Neue Antwort: <Ticket>“ mit dem Anfang der Antwort; ein Klick öffnet das Ticket. Mehrere Antworten seit dem letzten Blick werden zu einer Nachricht zusammengefasst
  - Der Worker schaut jede Minute je Ticketsystem nach geänderten Tickets (eine Abfrage) und liest Nachrichten nur bei Tickets von Personen, die das Portal kennt
  - Keine internen Notizen, keine Benachrichtigungen für Antworten von vor der Einführung
  - Einstellung `TICKET_WATCH_SECONDS` (Standard 60, 0 = aus); funktioniert auch mit älteren Zammad-Versionen ohne Suche mit Bedingung
  - Der API-Benutzer braucht Leserechte (`ticket.agent`) auf die Gruppen der Tickets

## 1.9.11 – 29.10.2026

- **Antworten aus dem Portal mit Verlauf:** Wie bei E-Mails hängt an jeder Antwort aus dem Portal die letzte Nachricht des Tickets als Zitat („Am … schrieb …:“) – mit den Zitaten davor, also dem ganzen Verlauf. In Zammad und in E-Mails an das Team ist der Zusammenhang so sofort sichtbar. Interne Notizen werden nie zitiert; bei ausgeblendeten Bearbeiternamen steht auch im Zitat nur der Name des Ticketsystems
- Im Portal selbst bleibt das Zitat wie bisher eingeklappt

## 1.9.10 – 29.10.2026

- **Updates kommen immer vollständig im Browser an:** Alle Programmteile laden sich gegenseitig mit der Build-Kennung. Nach einem Update holt der Browser damit den ganzen Stand neu, auch wenn er einzelne Dateien von früher noch zwischengespeichert hat. Kein Strg+F5 mehr nötig

## 1.9.9 – 29.10.2026

- **Neue Anmeldeseite:** Farbfläche und Anmeldung bilden einen gemeinsamen, mittig stehenden Rahmen statt zwei weit auseinanderliegender Hälften. Das Logo nutzt die Logogröße der Farbfläche, Fußzeile sowie Impressum und Datenschutz stehen unten auf der Farbfläche. Auf dem Handy steht die Farbfläche kompakt über der Anmeldung
- **Einstellungen der Anmeldeseite aufgeräumt:** nur noch, was dort sichtbar ist – gegliedert in *Farbfläche* (Logo, Logogröße, Überschrift, Text darunter, Fußzeile, Impressum/Datenschutz), *Stil und Farben* und *Browser-Tab* (Anzeigename, Favicon). Logos der Navigationsleiste, Navigationslinks und die Begrüßung der Startseite sind dort entfallen (gespeicherte Werte bleiben erhalten)
- Überschrift und Text unter der Überschrift der Anmeldeseite sind jetzt einstellbar
- Die Vorschau zeigt die Anmeldeseite statt der Startseite

## 1.9.8 – 29.10.2026

- **Nach einem Update sofort alles neu:** Die Programmteile im Browser wurden bis zu einer Stunde zwischengespeichert, während Startdatei und Gestaltung schon neu waren. Nach einem Update lief so kurzzeitig eine Mischung aus alt und neu (z. B. Ticketverlauf als ein einziger Textblock). Jetzt fragt der Browser bei jedem Aufruf kurz nach, ob sich etwas geändert hat (unverändert: kurze Antwort ohne Inhalt)
- Ticketverlauf behält Zeilenumbrüche auch in diesem Fall

## 1.9.7 – 29.10.2026

- **Ticketverlauf im Portal aufgeräumt** (in Zammad bleibt jede Nachricht unverändert)
  - Antworten aus Zammad zeigen nicht mehr die komplette zitierte Anfrage darunter. Der zitierte Verlauf (`<blockquote>`, Outlook „Von: … Gesendet: …“, „Am … schrieb …:“) ist eingeklappt unter **Zitierten Verlauf anzeigen**
  - Signaturen stehen klein und abgesetzt unter der Nachricht
  - Die Angaben aus dem Formular erscheinen als übersichtliche Feldliste statt als Text mit Tabulatoren; die Zeile „Erstellt über das Service-Portal · Anfrage …“ klein darunter
  - Zeilenumbrüche aus dem HTML-Quelltext erzeugen keine falschen Umbrüche mehr
- Kommentar bei einer Freigabe steht im Ticket als normaler Absatz („Kommentar: …“) statt als Zitat

## 1.9.6 – 29.10.2026

- **Status auf der Server-Konsole** (Installation ohne Docker): Vor `login:` stehen jetzt Version, Adresse und IP des Portals, der Zustand aller Dienste (Portal, Zustellung, Updates, Caddy, Virenscanner), ob jedes Zammad erreichbar ist und wie viele Anfragen warten oder fehlgeschlagen sind. Aktualisiert sich jede Minute, die Anmeldung wird nur bei Änderungen neu gezeichnet. Abschalten mit `CONSOLE_STATUS=false` in `portal.env`
- Neuer Befehl `service-portal-cli console-status` (Kurzstatus ohne Virenscanner-Test und ohne Microsoft-Abfrage)

## 1.9.5 – 29.10.2026

- **Schnellere Seiten, auch wenn Zammad langsam ist**
  - Die Startseite wartet nicht mehr auf Zammad: Formulare erscheinen sofort, „Offene Tickets“ wird nachgeladen
  - Ticketlisten: bis 30 s alt direkt aus dem Zwischenspeicher, bis 10 Minuten alt sofort mit dem gespeicherten Stand und im Hintergrund erneuert. Bisher wartete alle 30 s eine Seite auf Zammad – daher „mal schnell, mal langsam“
  - Verbindungen zu Zammad werden wiederverwendet (Keep-Alive), statt für jeden Aufruf neu aufgebaut zu werden (DNS, TCP, TLS)
  - Organisation und eigene Tickets werden gleichzeitig abgefragt; die Organisation wird wirklich 10 Minuten zwischengespeichert (vorher bei jedem Aufruf neu)
  - Lesende Zammad-Aufrufe brechen nach 10 s ab (vorher 20 s)
  - Neue Log-Meldung `Zammad antwortet langsam` mit Dauer, wenn ein Aufruf über 2 s braucht
- **Logo auf der Farbfläche:** Abstand zur Überschrift wächst mit der Logogröße, oben weniger Leerraum – große Logos wirken nicht mehr gequetscht

## 1.9.4 – 29.10.2026

- **Startseite:** Die Farbfläche schließt links und rechts genau mit Logo, Navigationsleiste und Formularliste ab, statt über die ganze Bildschirmbreite zu laufen. Auf großen Monitoren wirkt die Seite dadurch nicht mehr auseinandergezogen
- Auf sehr breiten Bildschirmen (ab 2100 px) wird der Inhalt etwas breiter
- Handy-Ansicht unverändert

## 1.9.3 – 29.10.2026

- **Große Bildschirme:** Der Farbschein im Hintergrund (Stil „Glas“) wächst mit der Bildschirmgröße, statt nur in den Ecken zu sitzen. Neben dem Inhalt bleibt keine leere schwarze Fläche mehr
- Die Farbfläche der Startseite geht ab 1500 px Breite nicht mehr über den ganzen Bildschirm, sondern sitzt mittig passend zum Inhalt; der Inhalt wird etwas breiter
- Kleine Bildschirme unverändert

## 1.9.2 – 29.10.2026

- **Logos klar zugeordnet:** Die Navigationsleiste nutzt nie mehr das Logo der Farbfläche (das enthält oft mehr, z. B. Partnerlogos)
  - **Logo auf der Farbfläche** – Startseite und Anmeldung
  - **Logo für die Navigationsleiste – helles Design**
  - **Logo für die Navigationsleiste – dunkles Design** (neu, optional, helle Schrift). Fehlt es, steht im dunklen Design das Logo des hellen Designs auf einem weißen Feld, statt unlesbar oder zu groß zu sein
- Vorschau unter **Stil, Farben und Logo** zeigt die Navigationsleiste genau wie im Portal (passend zum hellen bzw. dunklen Design); jede Logo-Vorschau auf der passenden Fläche
- Export/Import übernimmt das neue Logo mit

## 1.9.1 – 29.10.2026

- **Nicht erreichbares Zammad bremst die Seiten nicht mehr aus:**
  - Verbindungsaufbau (inkl. Namensauflösung) bricht nach 5 Sekunden ab, statt bis zur Gesamtzeit von 20 Sekunden zu warten – bei einer Firewall, die Pakete verwirft, wartete bisher jeder Aufruf so lange (mehrere Aufrufe nacheinander ergaben fast eine Minute)
  - Danach schlagen Aufrufe an dieses Zammad 30 Sekunden lang sofort fehl („gerade nicht erreichbar“), statt jedes Mal erneut zu warten; „Verbindung testen“ versucht es immer sofort
  - Stammdaten aus Zammad (Gruppen, Status, Objekte) kommen sofort aus dem Zwischenspeicher und werden im Hintergrund erneuert; gleichzeitige Abrufe teilen sich einen Aufruf
  - Verwaltung: Hinweis „Zammad ist gerade nicht erreichbar – angezeigt wird der Stand von …“; die Seite **Verbindung** wartet höchstens 4 Sekunden auf die Gruppenliste
- Tests: 2 neue, insgesamt 282

## 1.9.0 – 29.10.2026

Behebt die Funde aus dem [Sicherheitstest vom 28.10.2026](docs/SICHERHEITSTEST-2026-10-28.md).

**Bitte beachten beim Update**
- **Microsoft-Anmeldung:** In der App-Registrierung unter **Tokenkonfiguration** den optionalen Anspruch **`auth_time`** (ID-Token) hinzufügen – sonst ist die erneute Anmeldung vor kritischen Aktionen (Step-up) für Microsoft-Admins nicht möglich.
- **Mail-Adressen von Microsoft-Konten** werden nur übernommen, wenn ihre Domain zu den verifizierten Domains des Tenants gehört (Graph, Recht `User.Read` genügt) oder in `ENTRA_TENANT_DOMAINS` steht. Konten mit fremder Domain sehen keine Tickets und können nicht freigeben (Alarm im Log `entra_email_rejected`).
- **Lokale Konten** können nicht mehr freigeben; ihre E-Mail-Adresse setzt nur ein Super-Admin.
- **Prüfmuster** in Formularen laufen jetzt linear: Rückverweise, Lookarounds und `\p{…}` werden beim Speichern abgelehnt (solche Muster in bestehenden Formularen werden bis zur nächsten Änderung nicht mehr ausgeführt).
- **Text-Vorlagen** erlauben nur noch einfache Formatierung (keine Bilder, Styles, Skripte; Links nur http(s)/mailto, keine Platzhalter in Tags).
- **Zammad-Adresse ändern** verlangt jetzt auch das API-Token.

**Verfügbarkeit**
- JSON-Bodys werden vor dem Parsen linear geprüft (nur Objekte, Tiefe höchstens 64, höchstens 100 000 Elemente) – ein einzelner Request bringt das Portal nicht mehr zum Absturz; `null` u. Ä. ergibt 400 statt 500
- Body-Grenze für Uploads aus `UPLOAD_MAX_TOTAL_MB` abgeleitet, gemeinsames Speicherbudget für große Requests (`UPLOAD_INFLIGHT_MB`, Standard 64), je Benutzer ein Upload gleichzeitig
- Prüfmuster in der linearen Regex-Engine von V8 (kein ReDoS), HTML aus Zammad linear in Text umgewandelt
- Rate-Limiter mit Obergrenze und zeitgesteuertem Aufräumen, IPv6 je /64

**Anmeldung**
- TOTP-Code bei Step-up und Login atomar verbraucht (auch parallel nur einmal gültig), Sperre nach dem Hash frisch geprüft
- 2FA im laufenden Betrieb nur mit aktuellem Passwort einrichten
- Step-up über Microsoft nur mit `auth_time`
- Im Zwischenzustand (nur Passwort bekannt) keine Rechte-Auskunft; `/readyz` nennt die Version nicht über den Proxy; GCM nur mit vollen 16-Byte-Tags; Export-Passwort per asynchronem scrypt

**Identität und Freigaben**
- Mail-Adresse nur mit Domain des eigenen Tenants (siehe oben)
- Freigabe-Feld: optional „Freigeben dürfen nur Mitglieder dieser Gruppen“ (z. B. Führungskräfte), geprüft beim Eintragen und Entscheiden
- Freigebende Person höchstens dreimal wechseln, die Frist verlängert sich dabei nicht

**Verwaltung**
- Gespeichertes Zammad-Token geht nie an eine geänderte Adresse (auch nicht beim Import; Vorschau zeigt Adresswechsel)
- Vier-Augen-Prinzip: Name, Beschreibung, Sichtbarkeit und Aktiv-Status eines Formulars gelten erst nach der Freigabe; abschalten nur durch globale Admins
- Zammad-Adressen mit `?`/`#` abgelehnt; optional `TICKET_URL_ALLOWED_HOSTS` und `TICKET_URL_BLOCKED_CIDRS`; `ALLOW_PRIVATE_TICKET_URLS` im Docker-Stack wieder einstellbar
- SVG-Logos per Allowlist bereinigt; Tag „freigegeben“ reserviert; Personensuche nur für Microsoft-Konten ab drei Zeichen; Organisations-Tickets nur lesen
- Audit: Verbindungstest, Vorlagen und Veröffentlichen per Import

**Daten und Betrieb**
- Keine Doppel-Tickets nach Verbindungsabbruch oder „Erneut senden“
- Benachrichtigungen verschlüsselt; Titel und Fehlertexte nach der Aufbewahrungsfrist gelöscht; Abbruchgrund nicht mehr im Audit-Log
- Löschen eines Ticketsystems entfernt auch gespeicherte Anhänge
- Sicherungen mit Rechten 0600, nur die letzten drei Sicherungen vor Updates
- Update-Dienst ohne Docker: systemd-Härtung, keine Paketinstallation beim Update; Installation zeigt den Fingerabdruck des Release-Schlüssels
- Node.js-Download: Signatur der Prüfsummen mit den Schlüsseln der Node.js-Releaser geprüft (`NODE_SKIP_SIGNATURE=1` als Notausgang)
- Migrationen 006–008
- Tests: 37 neue, insgesamt 280

## 1.8.1 – 28.10.2026

- **Sicherheit (Installation ohne Docker):** Der Update-Dienst läuft als root und setzte den Besitzer der Datenbank- und Backup-Dateien im Datenverzeichnis des Dienstbenutzers – dabei folgte er symbolischen Links. Wer bereits Code als Dienstbenutzer ausführen konnte, hätte so Systemdateien übernehmen können. Jetzt werden Dateien ohne Linkverfolgung geöffnet und nur echte Dateien mit genau einem Link übereignet; liegt dort ein Link, bricht der Update-Dienst ab. Betrifft nur 1.8.0 (Version 1.8.0 wurde nicht als Release veröffentlicht)
- Tests: 1 neuer, insgesamt 243

## 1.8.0 – 28.10.2026

- **Updates aus der Verwaltung auch ohne Docker:** `deploy/native/install.sh` richtet den Dienst `zammad-service-portal-updater` ein. Er prüft die signierten Release-Tags, sichert die Datenbank, checkt die neue Version aus und führt `install.sh --ja` aus; bei einem Fehler setzt er Datenbank und Code automatisch zurück. Danach startet er sich selbst mit dem neuen Code neu. Abschalten mit `UPDATER_ENABLED=false` in `portal.env`. Installationen vor 1.8.0: einmal den Installationsbefehl erneut ausführen
- Seite **Updates**: passender Hinweis je Installationsart; zeigt nicht mehr „aktuell“, wenn noch nie geprüft wurde oder im Repository noch keine veröffentlichte Version liegt
- **Lizenz:** MIT (`LICENSE`), Haftungsausschluss im README, `THIRD-PARTY-NOTICES.md` mit fremden Bestandteilen und Markenhinweis
- Tests: 3 neue, insgesamt 242

## 1.7.0 – 28.10.2026

- **Logogröße einstellbar** unter **Stil, Farben und Logo** (und **Anmeldeseite**): Höhe in der Navigationsleiste (20–72 px, Standard 28) und auf der Farbfläche (24–200 px, Standard 44), mit Vorschau
- **Eigene Links in der Navigationsleiste:** bis zu sechs (z. B. Intranet, Wissensdatenbank, IT-Hotline), erlaubt sind https, http, mailto und tel. Bis zu zwei direkt in der Leiste, mehr im Menü **Links**; Web-Links öffnen in neuem Tab
- Navigationsleiste: Einträge brechen nicht mehr um, bei Platzmangel lässt sich die Leiste waagrecht wischen
- Tests: 1 neuer, insgesamt 239

## 1.6.3 – 28.10.2026

- Fehlermeldung bei nicht freigegebenen Zammad-Objekten (Editor und „Aus Datei übernehmen“) sagt jetzt, wo man sie freigibt

## 1.6.2 – 28.10.2026

- **Formulare und Vorlagen exportieren:** **In Datei exportieren** unter **Formulare** und unter **Vorlagen** lädt alle Formulare (veröffentlichte Version) und Vorlagen des Ticketsystems als JSON herunter – im Format, das **Aus Datei übernehmen …** liest. So lassen sie sich zwischen Ticketsystemen und Portalen übertragen, ohne gleich alles zu ersetzen
- **Vorlagen aus Datei übernehmen** auch auf der Seite **Vorlagen** (nur Vorlagen, Recht „Vorlagen bearbeiten“ genügt)
- Ladekreis neu: runder Ring mit abgerundetem Bogen in der Farbe des Ticketsystems statt des kantigen Rahmen-Segments (sah beim Drehen wie ein Strich aus); auch beim ersten Laden der Seite
- Tests: 2 neue, insgesamt 238

## 1.6.1 – 28.10.2026

- **Formulare aus Datei übernehmen:** In der Verwaltung unter **Formulare** → **Aus Datei übernehmen …** eine JSON-Datei mit Formularen (und optional Vorlagen) einspielen. Gleiches Kürzel bekommt eine neue Version, neue Kürzel werden angelegt, gelöscht wird nichts. Vorschau mit „neu / neue Version / unverändert“, auf Wunsch direkt veröffentlichen (mit Vier-Augen-Prinzip: zur Freigabe). Jede Definition wird wie im Editor geprüft
- Demo: „Störung melden“ fragt bei „Sonstiges“ nach, was genau betroffen ist
- Intern: Datenbank-Transaktionen lassen sich verschachteln
- Tests: 4 neue, insgesamt 236

## 1.6.0 – 28.10.2026

- **Export und Import** in der Verwaltung (nur globale Admins): alle Ticketsysteme mit Verbindung, erlaubten Gruppen, freigegebenen Zammad-Objekten, Formularen mit allen Versionen, Vorlagen, Übersichten, Stil, Farben und Logos als eine JSON-Datei – und in einem anderen Portal genauso wieder einspielen
- Zammad-API-Tokens optional mit Export-Passwort (scrypt + AES-256-GCM); ohne Passwort enthält die Datei keine Geheimnisse
- Import ersetzt alles: Vorschau zeigt, was ersetzt, neu angelegt und gelöscht wird; danach Bestätigung und frische Anmeldung. Gleiche Kürzel behalten ihre interne ID (Rollen-Zuordnungen und alte Anfragen bleiben). Ganz oder gar nicht in einer Transaktion; Ticketsysteme mit offenen Anfragen werden nicht gelöscht
- Jede Datei wird wie eine Eingabe in der Verwaltung geprüft (SSRF-Schutz, Formulare, Logos, Stil)
- Tests: 8 neue (Export mit/ohne Tokens, Vorschau, Ersetzen, Rundreise, unsichere Inhalte, Rechte und Step-up), insgesamt 232

## 1.5.2 – 28.10.2026

- **Anfragen in der Verwaltung abbrechen:** Unter **Zustellung** gibt es bei fehlgeschlagenen, wartenden und auf eine Freigabe wartenden Anfragen **Abbrechen** – mit freiwilligem Grund. Inhalt und Anhänge werden gelöscht, nichts geht an Zammad, „Erneut senden“ ist danach nicht mehr möglich. Eine offene Freigabe endet mit. Anfragende und freigebende Person werden im Portal benachrichtigt; Eintrag im Audit-Log (`request.cancelled`). Nur mit dem Recht „Ticketsystem verwalten“ für das System; Anfragen, die gerade zugestellt werden, nicht
- Neuer Status „Abgebrochen“ (Migration 005), Filter in **Zustellung**
- Tests: 4 neue, insgesamt 224

## 1.5.1 – 28.10.2026

- Behoben: **„Meine Tickets“ blieb leer**, wenn das Konto in Zammad zugleich Agent ist (z. B. Mitarbeitende der IT). Das Portal holte alle für das Konto sichtbaren Tickets – älteste zuerst, höchstens 500 – und filterte danach; die eigenen neuen Tickets lagen dahinter. Jetzt fragt es Zammad gezielt nach den Tickets des Kunden, neueste zuerst. Die Abfrage läuft ohne Suchbegriff direkt über die Datenbank von Zammad und hängt nicht von Elasticsearch ab. Ältere Zammad-Versionen ohne diese Abfrage nutzen automatisch den bisherigen Weg
- Sicherheit: „Tickets der eigenen Organisation anzeigen“ prüft jetzt die Organisation des Kunden. Vorher zeigte die Einstellung im Modus „Kundenfeld“ (Agenten-Token) jedes Ticket, das der API-Benutzer sehen kann, wenn man die Ticket-ID kannte, und bei Agent-Kunden auch deren Agenten-Tickets
- Tests: 4 neue (Agent als Kunde mit 600 fremden Tickets, gezielte Abfrage ohne Suchindex, Organisationen in beiden Modi, ältere Zammad-Versionen), insgesamt 220

## 1.5.0 – 28.10.2026

**Freigabe durch Vorgesetzte**

- Neuer Feldtyp **„Freigabe durch Vorgesetzte(n)“** im Formular-Editor, z. B. für Hardware oder kostenpflichtige Software. Mit „Nur anzeigen, wenn …“ auch bedingt (etwa nur bei „Ja, Lizenz nötig“). Eins pro Formular; sichtbar immer Pflicht
- Die anfragende Person trägt die freigebende Person selbst ein – mit Vorschlägen aus den Personen, die sich schon angemeldet haben. Die eigene Adresse geht nicht. Optional pro Feld: nur Personen, die das Portal schon kennt
- Die Anfrage wird wie jede andere geprüft und verschlüsselt gespeichert, geht aber **erst nach der Freigabe** an Zammad. Im Ticket stehen Name, Adresse, Zeitpunkt und Hinweis der freigebenden Person, dazu der Tag `freigegeben`
- Neue Seite **Freigaben** (Offen/Erledigt): Inhalt und Anhänge ansehen, **Freigeben** (Hinweis freiwillig) oder **Ablehnen** (Begründung Pflicht)
- **Meine Anfragen** zeigt, bei wem eine Anfrage liegt und bis wann; Anfragen lassen sich **zurückziehen** oder an eine **andere Person** geben
- Fristen: einmalige Erinnerung nach `APPROVAL_REMIND_DAYS` (Standard 3), Ablauf nach `APPROVAL_EXPIRE_DAYS` (Standard 14). Bei Ablehnung, Rückzug oder Ablauf werden Inhalt und Anhänge sofort gelöscht
- **Benachrichtigungen im Portal:** Glocke mit Zähler in der Navigation, „Freigaben“ mit Zahl offener Entscheidungen. Das Portal verschickt weiterhin keine E-Mails; weitere Kanäle (z. B. später E-Mail) lassen sich anhängen, ohne den Ablauf zu ändern
- Sicherheit: Freigaben, Anhänge und Entscheidungen nur für die eingetragene Person (sonst 404), keine Selbstfreigabe, lokale Konten mit der Adresse eines Microsoft-Kontos bekommen nichts, Entscheidung nur einmal und nur vor Fristende. Alles im Audit-Log (`approval.*`)
- Betrieb: wartende Freigaben zählen nicht als Zustellstau (`cli.ts status` zeigt sie getrennt), Filter in **Zustellung**, Zahl auf der Übersicht; Ticketsysteme mit offenen Freigaben lassen sich nicht löschen
- Datenbank-Migration 004 (neue Status, Tabellen `approvals` und `notifications`); bestehende Anfragen und Anhänge bleiben erhalten
- Demo: „Hardware anfordern“ mit Freigabe, „Software installieren“ mit bedingter Freigabe, Beispiel-Freigaben
- Doku: BEDIENUNG (neue Abschnitte und Screenshots 40–46), SICHERHEIT, ARCHITEKTUR, BETRIEB, GO-LIVE

Tests: 14 neue (Ablauf, Rechte, Fristen, Benachrichtigungen, Migration), insgesamt 216.

## 1.4.3 – 28.10.2026

- „Abbrechen“ im Anfrageformular ist jetzt eine Schaltfläche in gleicher Größe neben „Anfrage senden“ statt eines Links

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
