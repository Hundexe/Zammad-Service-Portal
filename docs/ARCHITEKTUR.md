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

## Zammad-Anbindung

| Zweck | Endpunkt | Kopfzeile |
| --- | --- | --- |
| Verbindungstest | `GET /api/v1/users/me` | |
| Stammdaten | `GET /api/v1/groups`, `ticket_states`, `ticket_priorities`, `object_manager_attributes` | |
| Kunde finden/anlegen | `GET /api/v1/users/search`, `POST /api/v1/users` | |
| Ticket anlegen | `POST /api/v1/tickets` (inkl. Artikel, Anhänge, Tags, Attribute) | `X-On-Behalf-Of: <Kunden-ID>` |
| Eigene Tickets | `GET /api/v1/tickets?expand=true` | `X-On-Behalf-Of` |
| Ticketverlauf | `GET /api/v1/tickets/{id}`, `ticket_articles/by_ticket/{id}` | `X-On-Behalf-Of` |
| Anhang | `GET /api/v1/ticket_attachment/{t}/{a}/{id}` | `X-On-Behalf-Of` |
| Antwort | `POST /api/v1/ticket_articles` | `X-On-Behalf-Of` |

Mit `X-On-Behalf-Of` handelt Zammad als der Kunde selbst. Zammad entscheidet also, welche Tickets er sehen darf; das Portal prüft zusätzlich die Kunden-ID. Interne Notizen werden doppelt ausgefiltert. Alle Aufrufe laufen über einen fetch mit SSRF-Schutz (`src/server/net/guarded-fetch.ts`): die aufgelöste IP wird bei jedem Verbindungsaufbau geprüft, Weiterleitungen werden nicht verfolgt. Nur freigegebene Attribute und erlaubte Gruppen gelangen ins Ticket (Details: [SICHERHEIT.md](SICHERHEIT.md#zammad-was-das-portal-setzen-darf)). HTML aus Zammad wird im Portal nie als HTML angezeigt, sondern serverseitig in Text umgewandelt.

**Zammad-Objekte:** Ticket-Attribute aus dem Objekt-Manager werden über `object_manager_attributes` gelesen. Unterstützt werden `input`, `textarea`, `select`, `multiselect`, `tree_select`, `multi_tree_select`, `boolean`, `integer` und `date`. Baumwerte haben in Zammad die Form `Eltern::Kind` und werden im Portal als „Eltern › Kind“ angezeigt.

## Code-Aufbau

```
src/
  shared/          läuft in Browser und Server
    form.ts        Formular-Schema, Validierung, Sichtbarkeitsregeln
    template.ts    Platzhalter-Vorlagen ohne Code
    branding.ts    Farben, Kontrastprüfung (WCAG)
    permissions.ts Rechte
  server/
    main.ts, worker.ts, cli.ts   Einstiegspunkte
    server.ts      zentrale Prüfungen (Sitzung, CSRF, Herkunft, Rechte, Step-up)
    http/          Router, Header, statische Dateien
    auth/          Sitzungen, OIDC (Entra), TOTP
    services/      Audit, Rechte, Benutzer, Formulare, Anfragen, Dateien, Zammad-Stammdaten
    connectors/    Zammad-Anbindung
    routes/        API: auth, portal, admin
    db/            SQLite, Migrationen
  web/             Frontend (ohne Framework, ohne innerHTML)
updater/           Update-Dienst
tools/             Build, Demo, Zammad- und Entra-Simulator, Screenshots
test/              Tests (node:test)
deploy/            Docker Compose, Caddy, Installationsskript
```

## Datenmodell

| Tabelle | Inhalt |
| --- | --- |
| `users` | Entra- und lokale Konten; Passwort-Hash (scrypt), TOTP-Geheimnis (verschlüsselt) |
| `sessions` | nur SHA-256-Hash der Sitzungs-ID, CSRF-Token, Zustand, Anmeldezeit |
| `ticket_systems` | Zammad-Instanzen; API-Token verschlüsselt; freigegebene Attribute |
| `system_metadata` | Zwischenspeicher der Zammad-Stammdaten (15 Min.) |
| `forms`, `form_versions` | Formulare und ihre Versionen (Entwurf, Freigabe, veröffentlicht, archiviert) |
| `templates`, `overviews` | Textbausteine und Ticket-Übersichten je System |
| `branding_versions`, `assets` | Farben/Texte versioniert, Logos |
| `roles`, `role_assignments` | Rollen und deren Zuordnung zu Benutzern, Gruppen oder allen |
| `requests`, `request_files` | Outbox (Inhalt verschlüsselt, Dateien verschlüsselt auf der Platte) |
| `zammad_customers` | Zuordnung Benutzer → Kunden-ID je System |
| `audit_log` | nur anhängbar, Hash-Kette |
| `update_state`, `update_jobs` | Update-Status und Aufträge an den Updater |

Alle Geheimnisse werden mit AES-256-GCM verschlüsselt. Für jeden Zweck (Token, TOTP, Anfrage, Upload, OIDC) wird per HKDF ein eigener Schlüssel aus dem Hauptschlüssel `SECRET_KEY` abgeleitet.
