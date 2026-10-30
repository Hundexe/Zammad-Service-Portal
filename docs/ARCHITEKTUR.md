# Architektur

## Überblick

```
                         internes Netz
 Browser ──HTTPS 443──▶ ┌──────────────── Docker-Host (Proxmox-VM) ─────────────────┐
                        │  caddy  ── edge ──▶  app  ── backend (intern) ──▶ clamav   │
                        │  TLS, Header          │  ▲                                 │
                        │                       │  │ SQLite (Volume portal-data)     │
                        │                worker ┘  │                                 │
                        │                   │      │                                 │
                        │  updater ── updater-Netz (intern) ──▶ socket-proxy ─▶ Docker│
                        └───────────────────┼──────┼─────────────────────────────────┘
                                   egress   ▼      ▼
                         Microsoft Entra ID / Graph      Zammad (eine oder mehrere)
```

| Container | Aufgabe | Netze | Besonderheiten |
| --- | --- | --- | --- |
| `caddy` | TLS, Sicherheits-Header, Weiterleitung an die App | edge | einziger veröffentlichter Port (443, 80 → 443) |
| `app` | Weboberfläche und API | edge, backend, egress | distroless, ohne root, nur lesbares Dateisystem |
| `worker` | stellt Anfragen an Zammad zu, räumt auf | backend, egress | gleiches Image wie `app` |
| `clamav` | Virenscan der Uploads | backend, clamav-update | optional (Profil `clamav`) |
| `updater` | Updates aus der Oberfläche | updater, backend, egress | kein offener Port; optional (Profil `updater`) |
| `socket-proxy` | eingeschränkter Zugang zur Docker-API | updater (intern) | kein `exec`, keine Secrets, kein Swarm |

## Warum ohne Fremdpakete?

Das Portal nutzt zur Laufzeit **nur Node.js selbst**:

| Bedarf | gelöst mit |
| --- | --- |
| HTTP-Server, Router | `node:http`, eigener kleiner Router (`src/server/http/core.ts`) |
| Datenbank | `node:sqlite` (in Node eingebaut) |
| Passwort-Hashes, Verschlüsselung, TOTP, JWT-Prüfung | `node:crypto` (scrypt, AES-256-GCM, HMAC, RSA) |
| TypeScript | Node führt `.ts` direkt aus; das Frontend wird mit dem eingebauten `stripTypeScriptTypes` gebaut |
| QR-Code für die 2FA-Einrichtung | eigener Generator (`src/server/qr.ts`), gegen OpenCV-Decoder getestet |

Vorteile: keine Lieferkettenangriffe über npm-Pakete, keine Abhängigkeits-Updates, kleines und gut prüfbares Image. Entwicklerwerkzeuge (`typescript`, `@types/node`) werden nur für die Typprüfung gebraucht.

## Ablauf einer Anfrage

```
Benutzer          Portal (app)                       Worker                     Zammad
   │ Formular ausfüllen │                                 │                           │
   │───────────────────▶│ prüfen (Schema, Rechte,          │                           │
   │                    │ Dateityp, Virenscan)             │                           │
   │                    │ verschlüsselt speichern (Outbox) │                           │
   │◀── „Gesendet“ ─────│                                  │                           │
   │                    │                                  │ Kunde suchen/anlegen ────▶│
   │                    │                                  │ Ticket im Namen des Kunden▶│ Trigger: Eingangsmail
   │                    │                                  │ (Tag, Gruppe, Attribute)  │
   │                    │                                  │ Inhalt + Anhänge löschen  │
   │ Meine Tickets ────▶│ Tickets im Namen des Kunden ────────────────────────────────▶│
   │◀── Liste/Verlauf ──│ (Zammad prüft Rechte, Portal prüft zusätzlich)               │
```

- Ist Zammad nicht erreichbar oder im Wartungsmodus, bleibt die Anfrage in der Warteschlange. Der Worker versucht es mit wachsenden Abständen erneut (30 s … 1 h, bis zu 20 Versuche).
- Nach der Zustellung werden Formularinhalt und Anhänge sofort aus dem Portal gelöscht. Titel und Ticketnummer bleiben für „Meine Anfragen“; nach einem Jahr wird auch das gelöscht.

### Mit Freigabe durch Vorgesetzte

Enthält das Formular ein sichtbares Feld „Freigabe durch Vorgesetzte(n)“, schiebt sich ein Schritt dazwischen:

```
Anfragende Person        Portal                                   Freigebende Person        Worker → Zammad
   │ Formular + Adresse ─▶│ prüfen wie oben, Ticket fertig bauen,     │                          │
   │                      │ verschlüsselt speichern                   │                          │
   │                      │ Status awaiting_approval ─ Benachrichtigung ▶ Glocke, „Freigaben“    │
   │◀ „Wartet auf Freigabe“│                                          │                          │
   │                      │◀──────────────────────── Freigeben ───────│                          │
   │                      │ Vermerk + Tag „freigegeben“ ins Ticket,   │                          │
   │                      │ Status queued ───────────────────────────────────────────────────────▶│ zustellen wie oben
   │◀─ Benachrichtigung ──│                                           │                          │
   │                      │◀──────────────────────── Ablehnen ────────│  (Begründung Pflicht)    │
   │◀─ Benachrichtigung ──│ Status rejected, Inhalt + Anhänge löschen │                          │
```

- Zustände von `requests`: `awaiting_approval` → `queued` → `sending` → `delivered` / `failed`, oder `awaiting_approval` → `rejected` / `withdrawn` (anfragende Person zieht zurück) / `expired` (Frist `APPROVAL_EXPIRE_DAYS`). Aus `failed`, `queued` und `awaiting_approval` kann die Verwaltung eine Anfrage abbrechen (`cancelled`). Der Worker fasst nur `queued` an.
- Der Worker prüft stündlich die Fristen: einmalige Erinnerung nach `APPROVAL_REMIND_DAYS`, Ablauf nach `APPROVAL_EXPIRE_DAYS`.
- Benachrichtigungen (`src/server/services/notifications.ts`) landen in der Tabelle `notifications` und erscheinen an der Glocke. Ziel ist ein Konto oder – für Personen, die sich vielleicht noch nie angemeldet haben – eine E-Mail-Adresse. Weitere Kanäle hängen sich über `registerChannel()` an; heute gibt es nur den Posteingang im Portal.

## Zammad-Anbindung

| Zweck | Endpunkt | Kopfzeile |
| --- | --- | --- |
| Verbindungstest | `GET /api/v1/users/me` | |
| Stammdaten | `GET /api/v1/groups`, `ticket_states`, `ticket_priorities`, `object_manager_attributes` | |
| Kunde finden/anlegen | `GET /api/v1/users/search`, `POST /api/v1/users` | |
| Ticket anlegen | `POST /api/v1/tickets` (inkl. Artikel, Anhänge, Tags, Attribute) | `X-On-Behalf-Of: <Kunden-ID>` |
| Eigene Tickets | `GET /api/v1/tickets/search?condition[ticket.customer_id]…&sort_by=updated_at&order_by=desc` (ohne Suchbegriff: direkt in der Datenbank, unabhängig von Elasticsearch); mit Organisations-Tickets zusätzlich `ticket.organization_id`. Ältere Zammad-Versionen: `GET /api/v1/tickets?expand=true` | `X-On-Behalf-Of` |
| Organisation des Kunden | `GET /api/v1/users/{id}` (nur mit „Tickets der eigenen Organisation anzeigen“) | |
| Ticketverlauf | `GET /api/v1/tickets/{id}`, `ticket_articles/by_ticket/{id}` | `X-On-Behalf-Of` |
| Anhang | `GET /api/v1/ticket_attachment/{t}/{a}/{id}` | `X-On-Behalf-Of` |
| Antwort | `POST /api/v1/ticket_articles` | `X-On-Behalf-Of` |

Mit `X-On-Behalf-Of` handelt Zammad als der Kunde selbst. Zammad entscheidet also, welche Tickets er sehen darf; das Portal zeigt davon nur eigene Tickets (bzw. die der eigenen Organisation). Das ist wichtig, wenn ein Kunde in Zammad zugleich Agent ist: Was er dort als Agent sieht, erscheint im Portal nicht. Interne Notizen werden doppelt ausgefiltert. Alle Aufrufe laufen über einen fetch mit SSRF-Schutz (`src/server/net/guarded-fetch.ts`): die aufgelöste IP wird bei jedem Verbindungsaufbau geprüft, Weiterleitungen werden nicht verfolgt. Nur freigegebene Attribute und erlaubte Gruppen gelangen ins Ticket (Details: [SICHERHEIT.md](SICHERHEIT.md#zammad-was-das-portal-setzen-darf)). HTML aus Zammad wird im Portal nie als HTML angezeigt, sondern serverseitig in Text umgewandelt.

**Zammad-Objekte:** Ticket-Attribute aus dem Objekt-Manager werden über `object_manager_attributes` gelesen. Unterstützt werden `input`, `textarea`, `select`, `multiselect`, `tree_select`, `multi_tree_select`, `boolean`, `integer` und `date`. Baumwerte haben in Zammad die Form `Eltern::Kind` und werden im Portal als „Eltern › Kind“ angezeigt.

## Gestaltung und Stile

Die Oberfläche hängt an CSS-Variablen in `src/web/styles.css` (Farben, Flächen, Rundungen, Schriften). Das Branding des gewählten Ticketsystems setzt zwei Dinge:

- die vier Farben als Variablen am `<html>` (`--brand`, `--brand-accent`, `--band`, `--band-text`);
- den Stil als Attribut `data-style` (`standard`, `glas`, `fluent`, `material`, `kontrast`).

Jeder Stil besteht aus zwei Teilen:

1. **Variablen** für hell und dunkel, unter `[data-style="…"]`. Sie erben wie gewohnt.
2. **Bauteil-Regeln** in einem `@scope ([data-style="…"]) to ([data-style]:not([data-style="…"]))`. Dadurch kann die Stil-Auswahl in der Verwaltung jede Vorschau in ihrem eigenen Stil zeigen, mitten in einer Seite mit anderem Stil.

Browser ohne `@scope` zeigen Farben, Rundungen und Schriften des Stils mit Standard-Bauteilen. Alles bleibt CSP-konform: keine Inline-Stile im HTML, Werte nur per CSSOM.

## Code-Aufbau

```
src/
  shared/          läuft in Browser und Server
    form.ts        Formular-Schema, Validierung, Sichtbarkeitsregeln
    template.ts    Platzhalter-Vorlagen ohne Code
    branding.ts    Stile, Farben, fertige Farbkombinationen, Kontrastprüfung (WCAG)
    permissions.ts Rechte
  server/
    main.ts, worker.ts, cli.ts   Einstiegspunkte
    server.ts      zentrale Prüfungen (Sitzung, CSRF, Herkunft, Rechte, Step-up)
    http/          Router, Header, statische Dateien
    auth/          Sitzungen, OIDC (Entra), TOTP
    services/      Audit, Rechte, Benutzer, Formulare, Anfragen, Freigaben, Benachrichtigungen, Dateien, Zammad-Stammdaten
    connectors/    Zammad-Anbindung
    routes/        API: auth, portal, admin, itsm, pwa
    db/            SQLite, Migrationen
  web/             Frontend (ohne Framework, ohne innerHTML)
updater/           Update-Dienst
tools/             Build, Demo, Zammad- und Entra-Simulator, Screenshots
test/              Tests (node:test)
deploy/            Docker Compose, Caddy, Installationsskript
```

## Status und Störungen

Zammad bleibt das führende System für Tickets. Das Portal ergänzt eine Schicht davor: Services, Störungen, Wartungen und Probleme liegen im Portal (je Ticketsystem), Tickets nur in Zammad. Die Verbindung entsteht über **Tags**: Das führende Ticket einer Störung und Tickets, die während einer Störung aus einem zugeordneten Formular entstehen, tragen `inc-0003`; mit einem Problem verknüpfte Tickets `prb-0001`. Der Zustand eines Services ergibt sich bei jedem Abruf aus offenen Störungen, laufenden Wartungen und einem optionalen Zustand von Hand (der schlimmste gewinnt). „Ich bin auch betroffen“ speichert nur die Zuordnung Person ↔ Störung; Updates gehen als Benachrichtigung an diese Personen. Alle Funktionen sind über `settings.features` schaltbar (`src/shared/itsm.ts`, `src/server/services/itsm.ts`, `src/server/routes/itsm.ts`).

## Portal als App

Das Portal ist eine Progressive Web App. `GET /api/app/manifest` liefert das Web-App-Manifest aus der globalen Gestaltung (Name, Farbe der Farbfläche, Kurzbefehle), `GET /api/app/icon/<datei>` die App-Symbole. Die Symbole zeichnet der Server selbst – ohne Bildbibliothek: Kantenglättung über vorzeichenbehaftete Abstände, PNG über `zlib` (`src/server/services/pwa.ts`); sie werden je Farbe zwischengespeichert. Der Service Worker `src/web/sw.js` trägt die Build-Kennung, damit Browser nach jedem Update die neue Fassung übernehmen, und speichert bewusst nichts zwischen. `GET /api/admin/settings/app` liefert den fertigen Wert für die Richtlinie `WebAppInstallForceList` (Intune). Schalter: `installApp` in `settings.features`. Anleitung: [APP.md](APP.md).

## Datenmodell

| Tabelle | Inhalt |
| --- | --- |
| `users` | Entra- und lokale Konten; Passwort-Hash (scrypt), TOTP-Geheimnis (verschlüsselt) |
| `sessions` | nur SHA-256-Hash der Sitzungs-ID, CSRF-Token, Zustand, Anmeldezeit |
| `ticket_systems` | Zammad-Instanzen; API-Token verschlüsselt; freigegebene Attribute |
| `system_metadata` | Zwischenspeicher der Zammad-Stammdaten (15 Min.) |
| `forms`, `form_versions` | Formulare und ihre Versionen (Entwurf, Freigabe, veröffentlicht, archiviert) |
| `templates`, `overviews` | Textbausteine und Ticket-Übersichten je System |
| `branding_versions`, `assets` | Stil, Farben und Texte versioniert, Logos |
| `roles`, `role_assignments` | Rollen und deren Zuordnung zu Benutzern, Gruppen oder allen |
| `requests`, `request_files` | Outbox (Inhalt verschlüsselt, Dateien verschlüsselt auf der Platte) |
| `approvals` | Freigabe je Anfrage: Adresse der freigebenden Person, Status, Frist; Ansicht für die freigebende Person und Hinweis verschlüsselt |
| `notifications` | Benachrichtigungen im Portal (an Konto oder E-Mail-Adresse), gelesen-Zeitpunkt; Löschung nach 90 Tagen |
| `zammad_customers` | Zuordnung Benutzer → Kunden-ID je System |
| `settings` | u. a. `features`: eingeschaltete Funktionen und Standorte |
| `services` | IT-Services je System, optional Zustand von Hand |
| `incidents`, `incident_services`, `incident_updates`, `incident_affected` | Störungen (Nummer, Auswirkung, Stand, Zeitraum, führendes Zammad-Ticket), Updates und wer sich als betroffen gemeldet hat |
| `maintenances`, `maintenance_services` | geplante Wartungen |
| `problems`, `problem_tickets` | Probleme mit Ursache und Workaround; verknüpfte Zammad-Tickets (in Zammad zusätzlich als Tag `prb-…`) |
| `audit_log` | nur anhängbar, Hash-Kette |
| `update_state`, `update_jobs` | Update-Status und Aufträge an den Updater |

Alle Geheimnisse werden mit AES-256-GCM verschlüsselt. Für jeden Zweck (Token, TOTP, Anfrage, Freigabe, Upload, OIDC) wird per HKDF ein eigener Schlüssel aus dem Hauptschlüssel `SECRET_KEY` abgeleitet.
