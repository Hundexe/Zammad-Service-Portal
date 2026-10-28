# Entwicklung

## Voraussetzungen

- Node.js ≥ 22.18 (empfohlen 24), sonst nichts – zur Laufzeit gibt es keine npm-Pakete.
- Für die Typprüfung: `npm install` (lädt nur `typescript` und `@types/node`).
- Für Screenshots: Playwright mit Chromium (`npm install -g playwright && npx playwright install chromium`).
- Für die Demo hinter TLS: [Caddy](https://caddyserver.com/download).

## Demo starten

```bash
npm run demo                  # baut die Oberfläche und startet Portal + 2 Zammad-Simulatoren + Entra-Simulator
```

| Adresse | Was |
| --- | --- |
| `http://localhost:3000` | Portal direkt („Mit Microsoft anmelden“ meldet ohne Passwort als Alex Berger an) |
| `https://portal.localhost:8443` | Portal hinter Caddy mit TLS (`sh tools/demo-restart.sh` startet beides; für Screenshots und Pentest) |
| `http://127.0.0.1:3101`, `:3102` | Zammad-Simulatoren „Zentrale IT“ und „IT Nord“ (Token `test-token`) |
| `http://127.0.0.1:3103` | Entra-Simulator (meldet ohne Rückfrage als Alex Berger an) |

Lokaler Admin der Demo: `admin` / `Demo-Admin-Passwort-2026!`, TOTP-Schlüssel `JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP` (jede Authenticator-App). Diese Zugangsdaten gibt es nur in der Demo.

`DEMO_ENV=production` startet die Demo mit allen Produktionsprüfungen (Host-Header, Virenscan-Pflicht). Die Demo nutzt einen simulierten Virenscanner, der den EICAR-Testvirus erkennt.

## Online-Demo (GitHub Pages)

Die Demo unter https://hundexe.github.io/Zammad-Service-Portal/ ist eine statische Seite ohne Server:

```bash
node tools/build-pages.ts      # nach dist/pages: Oberfläche + aufgezeichnete API-Antworten
sh tools/publish-pages.sh      # baut und veröffentlicht im Branch gh-pages
```

`build-pages.ts` startet die lokale Demo, klickt mit Playwright alle Seiten von Portal und Verwaltung durch und zeichnet jede API-Antwort auf (`demo-data.json`). In der Pages-Version erkennt die Oberfläche das `<meta name="zsp-demo">`, nutzt Hash-Adressen (`#/s/…`) und fragt statt des Servers den Simulator `src/web/demo/backend.ts`. Ändernde Aktionen wirken nur im geöffneten Tab. Einmalig auf GitHub aktivieren: **Settings → Pages → Deploy from a branch → `gh-pages` / `(root)`**. Für öffentliche Repositories ist das kostenlos.

## Tests

```bash
npm test                 # alle Tests
npm run test:security    # nur Sicherheitstests
npm run typecheck
node --test test/flow.test.ts     # einzelne Datei
```

| Datei | Inhalt |
| --- | --- |
| `test/unit.test.ts` | Krypto, TOTP (RFC-6238-Vektoren), Vorlagen, Validierung, Branding, Dateierkennung, Proxy-Vertrauen |
| `test/flow.test.ts` | Ende-zu-Ende: Anmeldung, Formular → Ticket, Meine Tickets, Antworten, Ausfall von Zammad |
| `test/admin.test.ts` | Verwaltung über die API |
| `test/formimport.test.ts` | Formulare aus Datei übernehmen: Vorschau, neue Version, unverändert, Fehler, Rechte |
| `test/transfer.test.ts` | Export und Import zwischen zwei Portalen: Tokens, Vorschau, Ersetzen, Rundreise, unsichere Inhalte, Rechte |
| `test/cancel.test.ts` | Verwaltung: Anfragen abbrechen (fehlgeschlagen, wartend, bei Freigabe), Rechte |
| `test/ticketlist.test.ts` | „Meine Tickets“: Agent als Kunde, gezielte Abfrage ohne Suchindex, Organisationen, ältere Zammad-Versionen |
| `test/security-auth.test.ts` | Anmeldung, Sitzungen, CSRF, Rechte, OIDC-Manipulationen |
| `test/security-app.test.ts` | IDOR, Injection, Uploads, SSRF, Pfade, Datenablage, Audit-Log |
| `test/security-local-login.test.ts` | lokale Anmeldung: Sperre, 2FA-Pflicht, Rechteausweitung |
| `test/updater.test.ts` | Updater mit simuliertem Git/Docker inkl. Rollback |
| `test/review-oidc.test.ts` | Review 2026-10, #2: Einzelprüfungen des ID-Tokens mit selbst signierten Tokens |
| `test/approvals.test.ts` | Freigabe durch Vorgesetzte: Ablauf, Rechte, Fristen, Benachrichtigungen, Migration 004 |
| `test/review.test.ts` | Review 2026-10, #3–#13: IDOR, Zammad-Felder und -Gruppen, Kundenzuordnung, SSRF-Guard, Uploads, Backup/Restore, Outbox, Step-up, Monitoring |

Die Tests starten das Portal, den Zammad- und den Entra-Simulator im selben Prozess; es wird nichts weiter benötigt.

Weitere Werkzeuge:

```bash
node tools/loadtest.ts                 # Lasttest (docs/LASTTEST.md)
bash tools/check-hardening.sh          # Container-Härtung prüfen
bash tools/secret-scan.sh dist/pages   # vor jeder Veröffentlichung: keine Geheimnisse
bash tools/release.sh X.Y.Z            # signiertes Release (docs/UPDATES.md)
```

## Screenshots

```bash
sh tools/demo-restart.sh && node tools/screenshots.ts     # schreibt docs/screenshots/*.png
```

## Neue API-Route – Checkliste

1. Route in `src/server/routes/*.ts` mit passenden Optionen anlegen: `auth`, `permission` (bei System-Routen mit `:systemId`), `stepup` für kritische Aktionen, `adminNet` für die Verwaltung, `bodyLimit`.
2. Eingaben mit den Hilfsfunktionen (`str`, `int`, `stringList` …) prüfen; nie ungeprüfte Objekte speichern.
3. Änderungen mit `audit()` protokollieren (Geheimnisse ausblenden, `diff()` hilft).
4. Der Test „jede geschützte Route antwortet mit 401“ prüft neue Routen automatisch; Rechte-Tests ergänzen.
5. Im Frontend Texte nur über `h()` setzen – nie `innerHTML`.

## Konventionen

- TypeScript ohne Build-Schritt auf dem Server: nur Syntax, die sich entfernen lässt (keine `enum`, keine Parameter-Properties), Importe mit `.ts`-Endung.
- Oberfläche und Dokumentation auf Deutsch, Sie-Form im Portal.
- Commits klein halten; vor jedem Release `npm test`.
