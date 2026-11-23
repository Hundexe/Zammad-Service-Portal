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

### Mit Freigabe durch Vorgesetzte (ab 2.0 im Ticket)

Enthält das Formular ein sichtbares Feld „Freigabe durch Vorgesetzte(n)“, entsteht das Ticket trotzdem sofort – nur in einem eigenen Status:

```
Anfragende Person        Portal / Worker                          Zammad                      Freigebende Person
   │ Formular + Adresse ─▶│ prüfen wie oben, Outbox                │                              │
   │                      │ Ticket anlegen (als API-Benutzer) ────▶│ „wartet auf Freigabe“        │
   │                      │                                        │ portal_freigabe = ausstehend │
   │                      │ E-Mail-Artikel an die Adresse ────────▶│──── E-Mail mit Link ────────▶│
   │                      │ Hinweis an der Glocke ───────────────────────────────────────────────▶│
   │                      │◀──────────── Freigeben / Ablehnen im Portal (live am Ticket geprüft) ─│
   │                      │ Attribute, Status, Tag, Notiz ────────▶│ „new“ bzw. „closed“          │
   │◀ E-Mail und Glocke ──│ E-Mail-Artikel an die anfragende Person▶│                              │
```

- `requests` ist nur noch die Outbox: `queued` → `sending` → `delivered` / `failed` (Abbruch durch die Verwaltung: `cancelled`). Nach der Zustellung wird auch der Titel im Portal neutralisiert; „Meine Anfragen“ liest Titel, Status und Freigabe live aus Zammad (eine Suche je Ticketsystem).
- Der Worker prüft alle fünf Minuten die wartenden Freigaben in Zammad: einmalige Erinnerung nach `APPROVAL_REMIND_DAYS`, Ablauf nach `APPROVAL_EXPIRE_DAYS`, in Zammad geschlossene Tickets gelten als abgebrochen.
- Benachrichtigungen (`src/server/services/notifications.ts`) landen in der Tabelle `notifications` und erscheinen an der Glocke. Ziel ist ein Konto oder eine E-Mail-Adresse. E-Mails verschickt Zammad aus dem Ticket.
- Die Abbildung in Zammad (Feldnamen, Status, Gruppen, Tags) ist je Ticketsystem einstellbar: [ZAMMAD.md](ZAMMAD.md).

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
| Freigaben, Störungen, Wartungen, Probleme lesen | `GET /api/v1/tickets/search?condition[ticket.portal_…]…` (ohne Suchbegriff, direkt in der Datenbank) | |
| Ticket des API-Benutzers anlegen bzw. ändern | `POST /api/v1/tickets` (mit Status), `PUT /api/v1/tickets/{id}` (Status, Attribute) | |
| Notizen und E-Mails | `POST /api/v1/ticket_articles` (`type: note` bzw. `email`) | |
| Tags | `POST /api/v1/tags/add`, `DELETE /api/v1/tags/remove`, `GET /api/v1/tags` | |
| Verknüpfungen | `GET /api/v1/links`, `POST /api/v1/links/add`, `DELETE /api/v1/links/remove` | |
| Einrichtung | `POST /api/v1/groups`, `ticket_states`, `object_manager_attributes` (+ `…_execute_migrations`), `core_workflows` | |
| ITSM-Grundausstattung | `ticket_priorities`, `calendars`, `slas`, `triggers`, `jobs`, `overviews`, `roles` | |

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

Ab 2.0 sind Störungen, Wartungen und Probleme Tickets in Zammad, erkennbar am Attribut „Portal: Art“ (`src/server/services/itsm.ts`). Was im Portal steht, sind Attribute des Tickets; Updates sind öffentliche Notizen mit der Phase als Betreff. „Ich bin auch betroffen“ legt ein Ticket der Person an (Attribut „Portal: betroffen von Störung“, Zammad-Verknüpfung als Kind). Probleme verknüpfen Tickets über Zammad-Verknüpfungen und „Portal: bekanntes Problem“. Im Portal liegen nur noch die Services (Name, Beschreibung, Schlüssel = Auswahlwert in „Portal: Services“). Die Status-Seite liest Zammad mit 30 Sekunden Zwischenspeicher je Ticketsystem und Art; bei Ausfall gilt der letzte Stand. Der Worker schließt alle fünf Minuten Tickets der Betroffenen behobener Störungen (auch wenn sie in Zammad geschlossen wurden) und beendete Wartungen; erledigte Schritte merkt er sich in `zammad_done`. Die Einrichtung in Zammad (Gruppen, Status, Felder, Auswahlwerte, Core Workflows) übernimmt `src/server/services/zammad-setup.ts`, die ITSM-Grundausstattung `src/server/services/zammad-baseline.ts`.

## Portal als App

Das Portal ist eine Progressive Web App. `GET /api/app/manifest` liefert das Web-App-Manifest aus der globalen Gestaltung (Name, Farbe der Farbfläche, Kurzbefehle), `GET /api/app/icon/<datei>` die App-Symbole. Die Symbole zeichnet der Server selbst – ohne Bildbibliothek: Kantenglättung über vorzeichenbehaftete Abstände, PNG über `zlib` (`src/server/services/pwa.ts`); sie werden je Farbe zwischengespeichert. Der Service Worker `src/web/sw.js` trägt die Build-Kennung, damit Browser nach jedem Update die neue Fassung übernehmen, und speichert bewusst nichts zwischen. `GET /api/admin/settings/app` liefert den fertigen Wert für die Richtlinie `WebAppInstallForceList` (Intune). Schalter: `installApp` in `settings.features`. Anleitung: [APP.md](APP.md).

## Datenmodell

| Tabelle | Inhalt |
| --- | --- |
| `users` | Entra- und lokale Konten; Passwort-Hash (scrypt), TOTP-Geheimnis (verschlüsselt) |
| `sessions` | nur SHA-256-Hash der Sitzungs-ID, CSRF-Token, Zustand, Anmeldezeit |
| `ticket_systems` | Zammad-Instanzen; API-Token verschlüsselt; freigegebene Attribute; Zammad-Zuordnung (JSON) |
| `system_metadata` | Zwischenspeicher der Zammad-Stammdaten (15 Min.) |
| `forms`, `form_versions` | Formulare und ihre Versionen (Entwurf, Freigabe, veröffentlicht, archiviert) |
| `templates`, `overviews` | Textbausteine und Ticket-Übersichten je System |
| `branding_versions`, `assets` | Stil, Farben und Texte versioniert, Logos |
| `roles`, `role_assignments` | Rollen und deren Zuordnung zu Benutzern, Gruppen oder allen |
| `requests`, `request_files` | Outbox (Inhalt verschlüsselt, Dateien verschlüsselt auf der Platte); nach der Zustellung nur noch Zeiger aufs Ticket |
| `notifications` | Benachrichtigungen im Portal (an Konto oder E-Mail-Adresse), gelesen-Zeitpunkt; Löschung nach 90 Tagen |
| `zammad_customers` | Zuordnung Benutzer → Kunden-ID je System |
| `settings` | u. a. `features`: eingeschaltete Funktionen und Standorte |
| `services` | IT-Services je System mit Schlüssel (`zkey`) für Zammad |
| `zammad_done` | erledigte Schritte in Zammad (Tickets der Betroffenen geschlossen, Erinnerung verschickt) |
| `approvals`, `incidents`, `incident_*`, `maintenances`, `maintenance_services`, `problems`, `problem_tickets` | Daten aus 1.x, nur noch für die Übernahme nach Zammad (`zammad:migrate`); `legacy_migrated` merkt sich, was übernommen ist |
| `audit_log` | nur anhängbar, Hash-Kette |
| `update_state`, `update_jobs` | Update-Status und Aufträge an den Updater |

Alle Geheimnisse werden mit AES-256-GCM verschlüsselt. Für jeden Zweck (Token, TOTP, Anfrage, Freigabe, Upload, OIDC) wird per HKDF ein eigener Schlüssel aus dem Hauptschlüssel `SECRET_KEY` abgeleitet.
