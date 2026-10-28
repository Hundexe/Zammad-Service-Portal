# Zammad Service-Portal

Self-Service-Portal für IT-Abteilungen mit einem oder mehreren Zammad-Systemen: Mitarbeitende melden sich mit ihrem Microsoft-Konto an, wählen das Ticketsystem, füllen ein passendes Formular aus und sehen ihre offenen Tickets. Das Portal legt Tickets **ausschließlich über die Zammad-API** an und liest sie dort. Es verschickt selbst keine E-Mails – Eingangsbestätigungen und Antworten kommen wie gewohnt aus Zammad.

**[▶ Demo im Browser ansehen](https://hundexe.github.io/Zammad-Service-Portal/)** – ohne Installation, mit Beispieldaten (Portal und Verwaltung zum Durchklicken).

**Aktuelle Version: 1.8.1** – [Änderungen](CHANGELOG.md), externes Architektur- und Sicherheits-Review: [was geändert wurde](docs/REVIEW-2026-10.md).

![Startseite des Portals im Stil „Glas“](docs/screenshots/31-stil-glas.png)

<img src="docs/screenshots/33-stil-fluent.png" width="32%" alt="Stil Fluent"> <img src="docs/screenshots/34-stil-material.png" width="32%" alt="Stil Material"> <img src="docs/screenshots/35-stil-kontrast.png" width="32%" alt="Stil Kontrast">

## Was das Portal kann

| Bereich | Funktionen |
| --- | --- |
| Anmeldung | Microsoft Entra ID (SSO, mehrere Tenants mit Vertrauensstellung), lokale Konten mit generiertem Passwort für Start und Notfall, Zwei-Faktor-Anmeldung (Authenticator-App) für lokale Admins |
| Mehrere Ticketsysteme | Beliebig viele Zammad-Instanzen; Benutzer wählen, wohin die Anfrage geht. Pro System eigene Formulare, Vorlagen, Übersichten, Farben und Logos |
| Formulare | Editor mit Drag-and-Drop, Live-Vorschau, Pflichtfeldern, Prüfmustern, Sichtbarkeitsregeln, Feldern nur für bestimmte Gruppen, Datei-Uploads, Versionierung und optionalem Vier-Augen-Prinzip |
| Freigabe durch Vorgesetzte | Formularfeld „Freigabe durch Vorgesetzte(n)“, z. B. für Hardware oder kostenpflichtige Software – auch nur unter Bedingungen. Die anfragende Person trägt die freigebende Person ein (mit Vorschlägen), die Anfrage wartet im Portal und geht erst nach der Freigabe ins Ticketsystem, mit Vermerk im Ticket. Ablehnen mit Begründung, Zurückziehen, andere Person wählen, Erinnerung und Ablauf nach Frist. Benachrichtigungen im Portal (Glocke) |
| Zammad-Objekte | Ticket-Attribute aus dem Zammad-Objekt-Manager (z. B. `sec_status` als tree_select) werden gezielt freigegeben – inklusive Auswahl der erlaubten Werte – und erscheinen als Auswahlfelder |
| Tickets | Ticket wird im Namen des Benutzers angelegt (`X-On-Behalf-Of` mit der Zammad-Kunden-ID), bekommt einen Portal-Tag, Gruppe, Priorität, Tags und freigegebene Attribute aus dem Formular – nur in **erlaubte Zammad-Gruppen**, Kernfelder wie Besitzer oder Status setzt nie ein Formular. Mitarbeitende sehen ihre Tickets in konfigurierbaren Übersichten, lesen den Verlauf ohne interne Notizen und ohne E-Mail-Adressen der Bearbeiter (auf Wunsch ganz ohne Namen) und können antworten |
| Verwaltung | Rollen und Rechte global oder pro Ticketsystem (Entra-Gruppen, App-Rollen, Personen), Benutzerverwaltung, Audit-Log mit Hash-Kette, Zustellungsübersicht (Anfragen erneut senden oder abbrechen), Export und Import aller Ticketsysteme in ein anderes Portal, Updates per Klick mit automatischem Rollback |
| Oberfläche | Pro Ticketsystem wählbarer **Stil** – Standard, Glas (Apple), Fluent (Microsoft), Material (Google), Kontrast – mit passenden Farben oder eigenen Farben (fertige Kombinationen oder frei wählbar); dunkles Design per Schalter, für Handy und Desktop, barrierearm (Tastatur, Screenreader, Kontrastprüfung) |
| Ausfallsicherheit | Anfragen landen verschlüsselt in einer Warteschlange und werden zugestellt, sobald Zammad erreichbar ist – auch nach Neustart oder Absturz, ohne doppelte Tickets |
| Betrieb | Docker-Compose-Stack oder direkt auf Debian/Ubuntu (systemd), Installation mit einem Befehl, nur intern erreichbar, Caddy mit TLS, ClamAV-Virenscan, verschlüsselte Ablage, keine npm-Laufzeitabhängigkeiten. Befehle für Status/Monitoring, Virenscanner-Test, Sicherung prüfen und wiederherstellen; Alarm bei jeder lokalen Anmeldung |

## Installation mit einem Befehl

Auf einem Linux-Server (Debian oder Ubuntu empfohlen):

```bash
curl -fsSL https://raw.githubusercontent.com/Hundexe/Zammad-Service-Portal/main/setup.sh | sudo bash
```

Das Skript fragt, wie das Portal laufen soll, und erledigt den Rest:

| Variante | Für wen | Was passiert |
| --- | --- | --- |
| **1) Docker** | Server mit oder ohne Docker | installiert Docker bei Bedarf, baut und startet den Compose-Stack |
| **2) Direkt auf Debian/Ubuntu** | ohne Docker | installiert Node.js, Caddy und optional ClamAV, richtet systemd-Dienste ein |
| **3) Nur ausprobieren** | zum Anschauen | startet eine Demo mit Beispieldaten, simuliertem Zammad und simuliertem Microsoft-Login; nichts wird dauerhaft eingerichtet |

Danach fragt es Hostname oder IP, Ports (Vorschlag eines freien Ports, falls 443/80 belegt sind), Virenscanner und optional die Microsoft-Anmeldung ab und legt den ersten Admin mit generiertem Passwort an. Ohne Menü: `… | sudo bash -s -- --docker` (bzw. `--debian`, `--demo`). Erneut ausführen aktualisiert das Portal; Einstellungen und Daten bleiben.

**Nur ansehen, ohne Server:** Die [Online-Demo](https://hundexe.github.io/Zammad-Service-Portal/) läuft komplett im Browser. Mit echtem Server im Hintergrund (simuliertes Zammad) geht es mit Node.js ≥ 22.18 auf dem eigenen Rechner:

```bash
git clone https://github.com/Hundexe/Zammad-Service-Portal.git && cd Zammad-Service-Portal && npm run demo
```

und dann <http://localhost:3000> öffnen („Mit Microsoft anmelden“ meldet ohne Passwort als Demo-Admin an).

Die ausführliche Anleitung mit Entra-App-Registrierung, Zammad-API-Benutzer und Zertifikaten steht in [docs/INSTALLATION.md](docs/INSTALLATION.md). Für den Betrieb eine feste Version verwenden: `… | sudo PORTAL_REF=vX.Y.Z bash` mit einem signierten Tag aus **Releases**.

## Vor dem Produktivbetrieb

Das Portal ist ein kleines Projekt. Für den Einsatz im Unternehmen empfehlen wir den Weg aus dem Review: eigene VM, einige Wochen mit wenigen IT-Benutzern, dann eine Abteilung, erst danach alle. Was vorher erledigt sein sollte – eigener Fork, nur ein lokales Notfallkonto, ClamAV verpflichtend, Admin-Bereich nur aus dem Admin-Netz, Zammad-API-Benutzer mit Minimalrechten, getestetes Restore, Egress-Firewall, Monitoring, unabhängiger Security-Check – steht mit Prüfanleitung in der **[Go-Live-Checkliste](docs/GO-LIVE.md)**.

## Betrieb auf einen Blick

```bash
cd /opt/zammad-service-portal/deploy
P="docker compose exec app /nodejs/bin/node src/server/cli.ts"   # ohne Docker: service-portal-cli
$P status                 # Warteschlange, Virenscanner, Audit-Log – Exit-Code 2 bei Problemen (fürs Monitoring)
$P scanner:test           # ClamAV mit EICAR-Testdatei prüfen
$P backup                 # Sicherung nach /data/backups/
$P backup:verify DATEI    # Sicherung prüfen (Integrität, Schema, passender Schlüssel)
$P restore DATEI --yes    # Sicherung zurückspielen (Portal vorher stoppen)
bash ../tools/check-hardening.sh   # Container-Härtung prüfen
```

Mehr dazu, inklusive Alarmregeln, Log-Weiterleitung und Egress-Firewall: [docs/BETRIEB.md](docs/BETRIEB.md).

## Dokumentation

| Dokument | Inhalt |
| --- | --- |
| [Installation](docs/INSTALLATION.md) | Ein Befehl oder Schritt für Schritt, mit Docker oder direkt auf Debian |
| [Bedienung](docs/BEDIENUNG.md) | Portal für Mitarbeitende und Verwaltung, mit Screenshots |
| [Architektur](docs/ARCHITEKTUR.md) | Aufbau, Datenfluss, Datenmodell, Zammad-Anbindung |
| [Sicherheit](docs/SICHERHEIT.md) | Schutzmaßnahmen, Bedrohungsmodell, Abgleich mit OWASP |
| [Penetrationstest](docs/PENTEST.md) | Vorgehen, Werkzeuge, Ergebnisse und behobene Funde |
| [Sicherheitstest 28.10.2026](docs/SICHERHEITSTEST-2026-10-28.md) | Zweiter Test mit Schwerpunkt auf den neuen Funktionen, offene Funde mit Issues |
| [Updates](docs/UPDATES.md) | Releases signieren, Updates aus der Oberfläche, Rollback |
| [Betrieb](docs/BETRIEB.md) | Sicherung, Wiederherstellung, Monitoring, Egress-Firewall, Härtung prüfen |
| [Go-Live](docs/GO-LIVE.md) | Checkliste mit Prüfanleitung vor dem Produktivbetrieb |
| [Lasttest](docs/LASTTEST.md) | Messwerte, Ausfall- und Neustart-Szenarien |
| [Review 2026-10](docs/REVIEW-2026-10.md) | Externes Review und was daraus geändert wurde |
| [Entwicklung](docs/ENTWICKLUNG.md) | Lokale Demo, Tests, Screenshots |

## Technik in einem Satz

TypeScript auf Node.js 24 ohne externe Laufzeitpakete (HTTP, Krypto, SQLite und TypeScript bringt Node mit), Frontend ohne Framework mit strenger Content-Security-Policy, Datenhaltung in SQLite. Das spart Angriffsfläche durch fremde Pakete und hält den Stack klein.

## Tests

```bash
npm test                        # 243 Tests: Funktionen, Sicherheit, Review-Punkte, Updater
npm run typecheck
node tools/loadtest.ts          # Lasttest: 50 Logins, 50 Ticketansichten, 20 Anfragen mit Anhang
bash tools/secret-scan.sh       # vor jeder Veröffentlichung: keine Geheimnisse im Repository
```

| Bereich | Tests |
| --- | ---: |
| Sicherheit: Anmeldung, Sitzungen, CSRF, Rechte, OIDC | 34 |
| Sicherheit: IDOR, Injection, Uploads, SSRF, Datenablage, Audit-Log | 30 |
| Sicherheit: lokale Anmeldung, Sperre, 2FA | 20 |
| Review: Token-Prüfung im Detail, Schlüsselwechsel, JWKS-Erneuerung und Höchstalter | 33 |
| Review: Zugriffe, Zammad-Felder und -Gruppen, Kundenzuordnung, SSRF-Schutz (inkl. IPv6 und TLS), Uploads, Backup/Restore, Zustellung, Step-up, Monitoring | 40 |
| Freigabe durch Vorgesetzte: Ablauf, Rechte (404 für Fremde, keine Selbstfreigabe), Fristen, Benachrichtigungen, Migration | 14 |
| Grundfunktionen, Ende-zu-Ende, Ticketliste, Verwaltung (inkl. Abbrechen, Export/Import, Formulare und Vorlagen aus Datei), Stile, Updater (Docker und ohne Docker) | 72 |

Die Tests starten Portal, Zammad- und Microsoft-Simulator im selben Prozess – es wird nichts weiter benötigt. Lasttest-Ergebnisse: [docs/LASTTEST.md](docs/LASTTEST.md).

## Versionen und Sicherheit

- Versionen erscheinen als **signierte Git-Tags** unter Releases; Änderungen stehen im [CHANGELOG](CHANGELOG.md). Veröffentlicht wird mit `tools/release.sh` (ohne GitHub Actions).
- Updates manuell oder per Klick aus der Verwaltung: [docs/UPDATES.md](docs/UPDATES.md).
- Sicherheitsprobleme bitte vertraulich melden: [SECURITY.md](SECURITY.md).

## Lizenz und Haftung

Das Portal steht unter der [MIT-Lizenz](LICENSE): Es darf frei genutzt, verändert und weitergegeben werden, auch in Unternehmen – der Copyright-Hinweis und der Lizenztext müssen dabei erhalten bleiben. Fremde Bestandteile (Schrift Inter) und Marken: [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

**Haftungsausschluss.** Die Software wird unentgeltlich und **ohne jede Gewähr** bereitgestellt („as is“, siehe Lizenz). Es gibt keine Zusage, dass sie fehlerfrei, sicher oder für einen bestimmten Zweck geeignet ist, und keinen Anspruch auf Support, Updates oder Fehlerbehebung. Wer das Portal betreibt, ist selbst verantwortlich für Prüfung vor dem Produktivbetrieb (siehe [GO-LIVE.md](docs/GO-LIVE.md)), Datensicherung, Updates, Datenschutz (DSGVO, ggf. Betriebsvereinbarung) und die Sicherheit der eigenen Umgebung. Soweit gesetzlich zulässig, ist die Haftung der Autoren ausgeschlossen; nach deutschem Recht bleibt sie bei unentgeltlicher Überlassung auf Vorsatz und grobe Fahrlässigkeit beschränkt sowie unberührt, wo eine Haftung zwingend ist (z. B. arglistig verschwiegene Mängel, Produkthaftungsgesetz).

Dieses Projekt ist kein offizielles Produkt der Zammad Foundation und steht in keiner Verbindung zu ihr oder zu Microsoft.
