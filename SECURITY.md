# Sicherheitsrichtlinie

## Schwachstellen melden

Bitte Sicherheitsprobleme **nicht** als öffentliches Issue melden, sondern vertraulich über **GitHub → Security → Report a vulnerability** in diesem Repository (bei einer eigenen Installation zusätzlich an die zuständige IT). Hilfreich sind:

- betroffene Version (Verwaltung → Updates oder `git describe --tags`),
- Schritte zum Nachvollziehen,
- mögliche Auswirkung.

## Was Sie erwarten können

Das Portal ist ein **kleines Projekt** mit wenigen Maintainern und ohne zugesicherten Support. Wir bemühen uns,

- den Eingang nach Möglichkeit innerhalb von **fünf Arbeitstagen** zu bestätigen,
- bestätigte Lücken mit einer neuen Version und einem Hinweis im [CHANGELOG](CHANGELOG.md) bzw. einem GitHub Security Advisory zu schließen.

Feste Reaktionszeiten können wir nicht garantieren. Wer das Portal produktiv einsetzt, sollte deshalb

- einen **eigenen Fork** pflegen und Updates dort prüfen, bevor sie installiert werden,
- eine verantwortliche Person benennen, die Änderungen und Hinweise verfolgt,
- vor dem breiten Einsatz einen **unabhängigen Security-Check** machen lassen (siehe [docs/GO-LIVE.md](docs/GO-LIVE.md)).

## Unterstützte Versionen

Sicherheitskorrekturen gibt es nur für die jeweils neueste Version (signierte Tags unter **Releases**). Aktualisieren: [docs/UPDATES.md](docs/UPDATES.md).

## Bisher geprüft

- automatische Sicherheitstests (Anmeldung, Token-Prüfung, Zugriffskontrolle, Uploads, SSRF, Injection), siehe [docs/SICHERHEIT.md](docs/SICHERHEIT.md)
- projektinterner Penetrationstest: [docs/PENTEST.md](docs/PENTEST.md)
- zweiter projektinterner Sicherheitstest (28.10.2026) mit offenen Punkten: [docs/SICHERHEITSTEST-2026-10-28.md](docs/SICHERHEITSTEST-2026-10-28.md)
- externes Architektur- und Code-Review im Oktober 2026: [docs/REVIEW-2026-10.md](docs/REVIEW-2026-10.md)

Ein unabhängiger Penetrationstest durch Dritte steht noch aus.
