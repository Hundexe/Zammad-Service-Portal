# Zammad Service-Portal

Self-Service-Portal für IT-Abteilungen mit einem oder mehreren Zammad-Systemen: Mitarbeitende melden sich mit ihrem Microsoft-Konto an, wählen das Ticketsystem, füllen ein passendes Formular aus und sehen ihre offenen Tickets. Das Portal legt Tickets **ausschließlich über die Zammad-API** an und liest sie dort. Es verschickt selbst keine E-Mails – Eingangsbestätigungen und Antworten kommen wie gewohnt aus Zammad.

![Startseite des Portals](docs/screenshots/02-portal-start.png)

## Was das Portal kann

| Bereich | Funktionen |
| --- | --- |
| Anmeldung | Microsoft Entra ID (SSO, mehrere Tenants mit Vertrauensstellung), lokale Konten mit generiertem Passwort für Start und Notfall, Zwei-Faktor-Anmeldung (Authenticator-App) für lokale Admins |
| Mehrere Ticketsysteme | Beliebig viele Zammad-Instanzen; Benutzer wählen, wohin die Anfrage geht. Pro System eigene Formulare, Vorlagen, Übersichten, Farben und Logos |
| Formulare | Editor mit Drag-and-Drop, Live-Vorschau, Pflichtfeldern, Prüfmustern, Sichtbarkeitsregeln, Feldern nur für bestimmte Gruppen, Datei-Uploads, Versionierung und optionalem Vier-Augen-Prinzip |
| Zammad-Objekte | Ticket-Attribute aus dem Zammad-Objekt-Manager (z. B. `sec_status` als tree_select) werden gezielt freigegeben – inklusive Auswahl der erlaubten Werte – und erscheinen als Auswahlfelder |
| Tickets | Ticket wird im Namen des Benutzers angelegt (`X-On-Behalf-Of`), bekommt einen Portal-Tag, Gruppe, Priorität, Tags und Attribute aus dem Formular. Mitarbeitende sehen ihre Tickets in konfigurierbaren Übersichten, lesen den Verlauf ohne interne Notizen und können antworten |
| Verwaltung | Rollen und Rechte global oder pro Ticketsystem (Entra-Gruppen, App-Rollen, Personen), Benutzerverwaltung, Audit-Log mit Hash-Kette, Zustellungsübersicht, Updates per Klick mit automatischem Rollback |
| Oberfläche | Ruhiges, helles Design mit großer Farbfläche je Ticketsystem, dunkles Design per Schalter, für Handy und Desktop, barrierearm (Tastatur, Screenreader, Kontrastprüfung) |
| Betrieb | Docker-Compose-Stack, nur intern erreichbar, Caddy mit TLS, ClamAV-Virenscan, verschlüsselte Ablage, keine npm-Laufzeitabhängigkeiten |

## Schnellstart (Proxmox-VM mit Docker)

```bash
sudo mkdir -p /opt/zammad-service-portal && sudo chown "$USER" /opt/zammad-service-portal
git clone https://github.com/Hundexe/Zammad-Service-Portal.git /opt/zammad-service-portal
cd /opt/zammad-service-portal/deploy
./install.sh      # fragt Hostname/IP, Ports, Virenscanner, Microsoft-Anmeldung ab, baut, startet
                  # und legt den ersten Admin (und auf Wunsch einen Testbenutzer) mit generiertem Passwort an
```

Die vollständige Anleitung mit Entra-App-Registrierung, Zammad-API-Benutzer und Zertifikaten steht in [docs/INSTALLATION.md](docs/INSTALLATION.md).

## Dokumentation

| Dokument | Inhalt |
| --- | --- |
| [Installation](docs/INSTALLATION.md) | Schritt für Schritt von der VM bis zum ersten Ticket |
| [Bedienung](docs/BEDIENUNG.md) | Portal für Mitarbeitende und Verwaltung, mit Screenshots |
| [Architektur](docs/ARCHITEKTUR.md) | Aufbau, Datenfluss, Datenmodell, Zammad-Anbindung |
| [Sicherheit](docs/SICHERHEIT.md) | Schutzmaßnahmen, Bedrohungsmodell, Abgleich mit OWASP |
| [Penetrationstest](docs/PENTEST.md) | Vorgehen, Werkzeuge, Ergebnisse und behobene Funde |
| [Updates](docs/UPDATES.md) | Releases signieren, Updates aus der Oberfläche, Rollback |
| [Betrieb](docs/BETRIEB.md) | Sicherung, Wiederherstellung, Logs, Störungen beheben |
| [Entwicklung](docs/ENTWICKLUNG.md) | Lokale Demo, Tests, Screenshots |

## Technik in einem Satz

TypeScript auf Node.js 24 ohne externe Laufzeitpakete (HTTP, Krypto, SQLite und TypeScript bringt Node mit), Frontend ohne Framework mit strenger Content-Security-Policy, Datenhaltung in SQLite. Das spart Angriffsfläche durch fremde Pakete und hält den Stack klein.

## Tests

```bash
npm test             # 127 Tests: Funktionen, Sicherheit, Updater
npm run typecheck
```
