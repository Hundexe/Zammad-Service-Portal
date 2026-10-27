# Lasttest

Werkzeug: `tools/loadtest.ts`. Es startet Portal, Zammad-Simulator und Entra-Simulator **in einem Prozess** und spielt die Szenarien aus dem Review durch:

1. **Anmeldespitze** – alle Benutzer melden sich gleichzeitig über Microsoft an (kompletter OIDC-Ablauf mit Token-Prüfung).
2. **Ticketansichten** – alle rufen gleichzeitig „Meine Tickets“ ab (einmal frisch aus Zammad, einmal aus dem 30-Sekunden-Zwischenspeicher), die Hälfte öffnet ein Ticket.
3. **Gleichzeitige Anfragen** – N Benutzer schicken gleichzeitig ein Formular mit je 1 MB PDF-Anhang ab (Dateiprüfung, Verschlüsselung, Outbox).
4. **Zustellung** – der Worker stellt die Warteschlange an Zammad zu.

```bash
node tools/loadtest.ts                                    # 50 Benutzer, 20 Anfragen mit 1 MB
node tools/loadtest.ts --users 200 --submits 50 --upload-kb 5120 --json ergebnis.json
```

Exit-Code 1, wenn eine Anfrage fehlschlägt.

## Ergebnis vom 2026-10-27

Testrechner: 2 CPU-Kerne, 8 GB RAM, Node.js v22.22.0. Zeiten in Millisekunden (Median / 95 %). Rohdaten: [`lasttest-ergebnis.json`](lasttest-ergebnis.json) (50 Benutzer), [`lasttest-skalierung.json`](lasttest-skalierung.json) (alle Läufe).

| Benutzer | Anfragen gleichzeitig | Anmeldung | Ticketliste (frisch) | Ticketliste (Cache) | Ticket öffnen | Anfrage + 1 MB | Zustellung je Anfrage | Fehler | Speicher (MB) |
| ---: | ---: | --- | --- | ---: | --- | --- | ---: | ---: | ---: |
| 10 | 5 | 129 / 132 | 47 / 53 | 6 | 18 / 20 | 152 / 170 | 21 | 0 | 189 |
| 50 | 20 | 393 / 591 | 199 / 247 | 40 | 73 / 90 | 501 / 575 | 22 | 0 | 318 |
| 100 | 50 | 631 / 1025 | 606 / 680 | 98 | 129 / 148 | 1256 / 1493 | 18 | 0 | 449 |
| 200 | 50 | 981 / 1546 | 1488 / 1576 | 86 | 234 / 295 | 1265 / 1500 | 20 | 0 | 501 |

**Szenario aus dem Review (50 Logins, 50 Ticketansichten, 20 gleichzeitige Anfragen mit Upload): keine Fehler**, alle Antworten unter 0,6 Sekunden. Die 20 Anfragen waren nach 436 ms vollständig an Zammad zugestellt.

## Einordnung

- Gemessen ist das Portal **einschließlich** der simulierten Gegenstellen und der Testclients – alles teilt sich dieselben 2 Kerne. Auf einem eigenen Server liegen die Zeiten des Portals eher darunter; dafür antwortet ein echtes Zammad langsamer als der Simulator (typisch 50–300 ms je Aufruf).
- Die Zeit wächst mit der **Gleichzeitigkeit**, nicht mit der Zahl der Benutzer insgesamt: 200 Personen, die in derselben Sekunde ihre Tickets öffnen, warten im Median 1,5 Sekunden. Das ist der ungünstigste Fall (alle gleichzeitig, kein Zwischenspeicher).
- SQLite ist dabei kein Engpass: Schreibzugriffe (Sitzungen, Outbox, Audit) sind kurz; die meiste Zeit kosten Token-Prüfung, Base64/Verschlüsselung der Anhänge und die Aufrufe an Zammad.
- Speicher: Der gemessene Wert gilt für den **ganzen Testprozess** (Portal + Simulatoren + 200 Clients mit Anhängen im Speicher). Das Portal selbst hat im Docker-Stack 512 MB; wer regelmäßig sehr viele große Anhänge gleichzeitig erwartet, setzt `mem_limit` für `app` auf 1 GB oder senkt `UPLOAD_MAX_TOTAL_MB`.

## Ausfall und Neustart

Die Szenarien „Zammad zehn Minuten nicht erreichbar“ und „Neustart während gefüllter Outbox“ sind als automatische Tests umgesetzt (`test/review.test.ts`, Abschnitt „#11“):

| Szenario | Ergebnis |
| --- | --- |
| Wartung/Ausfall, dann Neustart mit neuer App-Instanz auf denselben Daten | Anfrage wird zugestellt, genau ein Ticket |
| Absturz mitten in der Zustellung (Status „sending“ hängt) | nach 5 Minuten erneut zugestellt, genau ein Ticket |
| Zammad legt das Ticket an, die Antwort geht verloren (Zeitüberschreitung) | beim nächsten Versuch wird das vorhandene Ticket erkannt – **kein Duplikat** |
| langer Ausfall | Wartezeit wächst 1 → 2 → 4 … Minuten bis höchstens 1 Stunde; nach 20 Versuchen (≈ 14 Stunden) „fehlgeschlagen“, Inhalt bleibt erhalten und lässt sich unter **Zustellung** erneut senden |

Bei einem Ausfall von zehn Minuten sind das 4 Versuche; die Anfrage kommt spätestens etwa 8 Minuten nach Ende des Ausfalls an.
