# Go-Live-Checkliste

Diese Liste gehört zum Review vom Oktober 2026 ([REVIEW-2026-10.md](REVIEW-2026-10.md)). Jeder Punkt hat eine Prüfanleitung. Abhaken, Datum und Namen dazuschreiben, Liste ablegen.

Empfohlener Weg: eigene VM → 4 Wochen mit 5–10 IT-Benutzern → Pilot mit einer Abteilung → alle.

## Pflicht

| ✓ | Punkt | So prüfen |
| --- | --- | --- |
| ☐ | **Eigener Fork / interner Spiegel**, verantwortliche Person benannt | Repository intern gespiegelt, Name im Betriebshandbuch |
| ☐ | **Fester, geprüfter Stand**: signierter Release-Tag | `git describe --tags` auf dem Server zeigt `vX.Y.Z`; `git -c gpg.ssh.allowedSignersFile=deploy/allowed_signers verify-tag vX.Y.Z` meldet „Good signature“ |
| ☐ | **Entra-ID-Anmeldung** funktioniert, Admin-Rechte nur über eine eigene Entra-Gruppe mit wenigen Mitgliedern, MFA/Conditional Access in Entra | Anmelden als normaler Benutzer und als Admin; Verwaltung → Rollen: Zuordnungen nur über Gruppen-IDs, keine über Name/Mail |
| ☐ | **Nur ein lokales Notfallkonto** mit 2FA, Zugangsdaten im Tresor | `cli.ts user:list` zeigt genau ein lokales Konto mit `totp_enabled=1`; danach `LOCAL_LOGIN_ENABLED=false` (für den Notfall kurz einschalten) |
| ☐ | **Alarm bei lokaler Anmeldung** | Notfallkonto testweise anmelden → Alarm kommt an (Log-Ereignis `"alert":true`, siehe [BETRIEB.md](BETRIEB.md#überwachung-und-alarme)) |
| ☐ | **ClamAV verpflichtend** | `.env`: `CLAMAV_REQUIRED=true`, `COMPOSE_PROFILES` enthält `clamav`; `cli.ts scanner:test` → Exit-Code 0 („EICAR erkannt“) |
| ☐ | **Upload ohne Scanner wird abgelehnt** | `docker compose stop clamav`, Formular mit Anhang absenden → Meldung „Virenscanner nicht erreichbar“; danach `start clamav` |
| ☐ | **Portal nur im internen Netz** | von außen (Mobilfunk) nicht erreichbar; `BIND_ADDRESS` bzw. Firewall |
| ☐ | **Verwaltung nur aus dem Admin-Netz** | `ADMIN_ALLOWED_CIDRS` gesetzt; aus dem Client-Netz liefert `/api/admin/overview` 403 |
| ☐ | **Zammad-API-Benutzer mit Minimalrechten** | nur die Rechte aus [INSTALLATION.md](INSTALLATION.md#5-zammad-api-benutzer-und-token), nur Portal-Gruppen; im Portal **Erlaubte Zammad-Gruppen** gesetzt (Übersicht zeigt keine Warnung) |
| ☐ | **Interne Notizen nicht sichtbar** – mit echten Daten | Testticket mit interner Notiz und internem Anhang anlegen → im Portal weder Text noch Anhang; Datei-URL des internen Anhangs von Hand aufrufen → 404 |
| ☐ | **Fremde Tickets und Anhänge nicht abrufbar** | Benutzer A öffnet Ticket von B per URL (`/tickets/<system>/<id>`) → „nicht gefunden“; ebenso Anhang-URL |
| ☐ | **Organisations-Tickets** wie gewollt | Einstellung „Tickets der eigenen Organisation anzeigen“ bewusst gesetzt; Kollege derselben Organisation sieht nur dann fremde Tickets |
| ☐ | **Backup und Restore getestet** | Restore-Probe nach [BETRIEB.md](BETRIEB.md#restore-probe-alle-3-monate), Datum notiert |
| ☐ | **Outbox übersteht Neustart und Zammad-Ausfall** | Zammad-Adresse kurz auf einen nicht erreichbaren Host stellen (oder Zammad stoppen), Anfrage absenden, `docker compose restart app worker`, Zammad wieder erreichbar → Ticket kommt genau einmal an |
| ☐ | **Updater zunächst aus** | `COMPOSE_PROFILES=clamav` (ohne `updater`); Updates nach [UPDATES.md](UPDATES.md#manuell-aktualisieren-ohne-updater) |
| ☐ | **Egress-Firewall** | Regeln nach [BETRIEB.md](BETRIEB.md#ausgehende-verbindungen-begrenzen-egress-firewall); Test: `docker compose exec app /nodejs/bin/node -e "fetch('https://example.org').then(r=>console.log(r.status))"` schlägt fehl, Zammad-Verbindungstest klappt |
| ☐ | **Container-Härtung** | `bash tools/check-hardening.sh` → „Härtung: wie erwartet.“ |
| ☐ | **Zentrales Logging und Monitoring** | Logs kommen im SIEM/Log-System an; `/readyz` und `cli.ts status` im Monitoring |
| ☐ | **Unabhängiger Security-Check** | kurzer Web-Pentest durch eine Person, die nicht am Projekt mitgearbeitet hat; Ergebnis abgelegt. Hilfe: [PENTEST.md](PENTEST.md) |

## Sehr sinnvoll

| ✓ | Punkt | So prüfen | automatisch getestet |
| --- | --- | --- | --- |
| ☐ | Lasttest mit 20–50 parallelen Benutzern | `node tools/loadtest.ts` auf dem Server bzw. echter Pilot zu Spitzenzeiten | ja, [LASTTEST.md](LASTTEST.md) |
| ☐ | große und schädliche Uploads | 30-MB-Datei, EICAR, umbenannte `.exe` als `.pdf` → abgelehnt | ja (security-app) |
| ☐ | abgelaufenes Entra-Token | Anmeldung mit verstellter Uhrzeit des Clients ändert nichts; Token-Prüfung | ja (review-oidc) |
| ☐ | entferntes Entra-Gruppenmitglied | Admin aus der Gruppe nehmen → nach Bestätigung/neuer Anmeldung keine Admin-Rechte | ja (review #12) |
| ☐ | geänderter Name und Mailadresse | in Entra ändern, neu anmelden → alte Tickets weiter sichtbar, kein zweiter Kunde in Zammad | ja (review #5) |
| ☐ | Test nach Zammad-Update | nach jedem Zammad-Update: Verbindungstest, Testanfrage, Ticketansicht, interne Notiz | – |
| ☐ | manueller Rollback geübt | [UPDATES.md](UPDATES.md#manuell-zurückrollen) einmal auf der Test-VM durchspielen | – |
| ☐ | Exit-Strategie | Formulare sind in Zammad nachbaubar; Tickets liegen ohnehin in Zammad – das Portal lässt sich jederzeit abschalten | – |

## Nach dem Go-Live

- monatlich: `cli.ts audit:verify`, Admin-Zuordnungen und lokale Konten prüfen
- vierteljährlich: Restore-Probe, Zammad-Token erneuern, Rechte des API-Benutzers prüfen
- bei jedem Update: Änderungen im Fork ansehen, signierten Tag prüfen, vorher Snapshot und `backup`, danach `status` und `check-hardening.sh`
