# Entwicklung

## Voraussetzungen

- Node.js ≥ 22.18 (empfohlen 24), sonst nichts – zur Laufzeit gibt es keine npm-Pakete.
- Für die Typprüfung: `npm install` (lädt nur `typescript` und `@types/node`).
- Für Screenshots: Playwright mit Chromium (`npm install -g playwright && npx playwright install chromium`).
- Für die Demo hinter TLS: [Caddy](https://caddyserver.com/download).

## Demo starten

```bash
npm run build                 # Frontend nach dist/web
npm run demo                  # Portal + 2 Zammad-Simulatoren + Entra-Simulator, Beispieldaten
```

| Adresse | Was |
| --- | --- |
| `http://127.0.0.1:3000` | Portal direkt |
| `https://portal.localhost:8443` | Portal hinter Caddy (`sh tools/demo-restart.sh` startet beides) |
| `http://127.0.0.1:3101`, `:3102` | Zammad-Simulatoren „Zentrale IT“ und „IT Nord“ (Token `test-token`) |
| `http://127.0.0.1:3103` | Entra-Simulator (meldet ohne Rückfrage als Alex Berger an) |

Lokaler Admin der Demo: `admin` / `Demo-Admin-Passwort-2026!`, TOTP-Schlüssel `JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP` (jede Authenticator-App). Diese Zugangsdaten gibt es nur in der Demo.

`DEMO_ENV=production` startet die Demo mit allen Produktionsprüfungen (Host-Header, Virenscan-Pflicht). Die Demo nutzt einen simulierten Virenscanner, der den EICAR-Testvirus erkennt.

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
| `test/security-auth.test.ts` | Anmeldung, Sitzungen, CSRF, Rechte, OIDC-Manipulationen |
| `test/security-app.test.ts` | IDOR, Injection, Uploads, SSRF, Pfade, Datenablage, Audit-Log |
| `test/updater.test.ts` | Updater mit simuliertem Git/Docker inkl. Rollback |

Die Tests starten das Portal, den Zammad- und den Entra-Simulator im selben Prozess; es wird nichts weiter benötigt.

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
