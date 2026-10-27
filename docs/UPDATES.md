# Updates

Neue Versionen werden als **signierte Git-Tags** (`vX.Y.Z`, siehe **Releases**) veröffentlicht. Der Update-Dienst auf der VM holt sie, prüft die Signatur, baut die Images **auf der VM** und startet das Portal neu. Dafür braucht es weder GitHub Actions noch eine Container-Registry.


> **Installation ohne Docker** (`deploy/native/install.sh`): Updates einfach mit demselben Befehl wie bei der Installation einspielen (`curl -fsSL https://raw.githubusercontent.com/Hundexe/Zammad-Service-Portal/main/setup.sh | sudo bash`). Die Update-Schaltfläche in der Verwaltung und der Update-Dienst gibt es nur in der Docker-Variante.

## So läuft ein Update aus der Oberfläche

1. Der Updater prüft alle 6 Stunden (oder nach **Jetzt nach Updates suchen**) die Tags im Repository.
2. Unter **Verwaltung → Updates** erscheint die neue Version mit Änderungsliste.
3. **Auf 1.1.0 aktualisieren** (frische Anmeldung erforderlich). Der Updater:
   1. prüft die **Signatur des Tags** gegen `deploy/allowed_signers`,
   2. sichert die Datenbank nach `/data/backups/vor-update-…sqlite`,
   3. checkt den Tag aus und baut das Image,
   4. startet `app` und `worker` neu (Datenbank-Migrationen laufen beim Start),
   5. wartet, bis `/readyz` die neue Version meldet (höchstens 3 Minuten).
4. Schlägt ein Schritt fehl, setzt der Updater **automatisch zurück**: alte Version auschecken, Datenbank aus dem Backup wiederherstellen, alte Version starten. Das Protokoll steht im Verlauf.

Das Portal ist während des Neustarts etwa eine Minute nicht erreichbar. Eingegangene Anfragen gehen nicht verloren – sie liegen in der Warteschlange.

## Einrichtung (einmalig)

### Auf der VM

Beim öffentlichen Repository (per `https://` geklont) ist dafür nichts weiter nötig. Bei einer privaten Kopie braucht der Updater den Deploy-Key aus der [Installation](INSTALLATION.md#3-code-holen) unter `deploy/secrets/deploy_key`.

```bash
cd /opt/zammad-service-portal/deploy
ssh-keyscan -t ed25519 github.com > known_hosts     # macht install.sh automatisch
grep -v '^#' release_signers > allowed_signers      # macht install.sh automatisch (offizieller Release-Schlüssel)
grep COMPOSE_PROFILES .env                          # muss "updater" enthalten
docker compose up -d
```

In `.env`:

| Variable | Bedeutung |
| --- | --- |
| `UPDATE_SOURCE=git` | Tags holen und auf der VM bauen (Standard) |
| `UPDATE_REQUIRE_SIGNED_TAGS=true` | nur signierte Tags installieren (dringend empfohlen) |
| `PORTAL_DIR` | absoluter Pfad des Repositorys – muss stimmen, sonst findet Compose die Dateien nicht |

### Wer Releases signiert

Die Release-Tags dieses Repositorys sind mit dem Projektschlüssel aus [`deploy/release_signers`](../deploy/release_signers) signiert. `install.sh` übernimmt ihn automatisch nach `deploy/allowed_signers`, wenn dort noch nichts steht. Prüfen von Hand:

```bash
git -c gpg.ssh.allowedSignersFile=deploy/release_signers verify-tag v1.3.0
```

Wer ein **eigenes Fork** betreibt und selbst Releases baut, erzeugt einen eigenen Schlüssel (unten) und trägt nur diesen in `deploy/allowed_signers` ein – dann installiert der Updater ausschließlich Versionen aus dem eigenen Fork.

### Signaturschlüssel für eigene Releases (auf dem Build-PC)

Git kann Tags mit einem SSH-Schlüssel signieren:

```bash
ssh-keygen -t ed25519 -C "release-signing" -f ~/.ssh/release_signing
git config --global gpg.format ssh
git config --global user.signingkey ~/.ssh/release_signing.pub
```

Den öffentlichen Schlüssel auf der VM in `deploy/allowed_signers` eintragen:

```
release@example.com ssh-ed25519 AAAAC3Nz… release-signing
```

Die E-Mail muss zur Git-Konfiguration (`user.email`) passen, mit der der Tag erstellt wird.

## Eine neue Version veröffentlichen (auf dem Build-PC)

```bash
# CHANGELOG.md ergänzen (## 1.3.0 – Datum), Version in package.json erhöhen, committen
bash tools/release.sh 1.3.0
```

`tools/release.sh` prüft Arbeitsstand, Version und Changelog, lässt Typprüfung, alle Tests und den Secret-Scan laufen, erstellt den **signierten** Tag, prüft die Signatur gegen `deploy/allowed_signers` und lädt Commit und Tag hoch. Ist die GitHub-CLI angemeldet, legt es auch das GitHub-Release mit dem Text aus dem Changelog an; sonst auf der Webseite unter **Releases → Draft a new release** den Tag auswählen.

Danach erscheint die Version spätestens nach 6 Stunden in der Oberfläche, sofort nach **Jetzt nach Updates suchen**.

> Welche Versionen es gibt, steht unter **Releases** bzw. `git tag -l 'v*'`. In dieser Anleitung steht `vX.Y.Z` für die gewünschte Version.

## Empfehlung für den Start: manuell aktualisieren

Der Updater kann Images bauen und Container starten – wer ihn übernimmt, hat weitgehende Rechte auf der VM. Für die ersten Monate empfiehlt sich deshalb: Profil `updater` **weglassen** (`COMPOSE_PROFILES=clamav` in `.env`), Updates von Hand nach dem folgenden Ablauf, vorher **VM-Snapshot**. Wer ein eigenes Fork pflegt, prüft die Änderungen dort (`git log`, `git diff vALT..vNEU`) und installiert nur eigene, signierte Tags – nie direkt `main`.

## Manuell aktualisieren (ohne Updater)

```bash
cd /opt/zammad-service-portal
git fetch --tags
git tag -l 'v*' | sort -V | tail -3                                   # verfügbare Versionen
git -c gpg.ssh.allowedSignersFile=deploy/allowed_signers verify-tag vX.Y.Z   # muss "Good signature" melden
cd deploy
docker compose exec app /nodejs/bin/node src/server/cli.ts backup --out /data/backups/vor-update.sqlite
docker compose exec app /nodejs/bin/node src/server/cli.ts backup:verify /data/backups/vor-update.sqlite
git checkout vX.Y.Z
sed -i 's/^APP_VERSION=.*/APP_VERSION=X.Y.Z/' .env
docker compose build && docker compose up -d
docker compose ps                                                      # app muss "healthy" sein
docker compose exec app /nodejs/bin/node src/server/cli.ts status      # Exit-Code 0 = alles in Ordnung
bash ../tools/check-hardening.sh                                       # Härtung unverändert?
```

Ohne Docker: `git -C /opt/zammad-service-portal fetch --tags && git -C /opt/zammad-service-portal checkout vX.Y.Z`, Signatur wie oben prüfen, `service-portal-cli backup`, dann `/opt/zammad-service-portal/deploy/native/install.sh`.

## Manuell zurückrollen

```bash
cd /opt/zammad-service-portal/deploy
docker compose stop app worker
git checkout vALT                                                      # vorher installierte Version
sed -i 's/^APP_VERSION=.*/APP_VERSION=ALT/' .env
docker compose build
# Datenbank vom Stand vor dem Update zurückholen (prüft die Datei, sichert den aktuellen Stand vorher):
docker compose run --rm --no-deps app restore /data/backups/vor-update.sqlite --yes
docker compose up -d
docker compose exec app /nodejs/bin/node src/server/cli.ts status
```

Der Rückweg ist nötig, weil neuere Versionen die Datenbank migrieren können; eine ältere Version startet nicht mit einer Datenbank aus der Zukunft (`backup:verify` meldet das). Ohne Docker: Dienste stoppen, alten Tag auschecken, `service-portal-cli restore DATEI --yes`, `install.sh` erneut ausführen.

## Alternative: signierte Images aus der Registry

Wer nicht auf der VM bauen möchte: `UPDATE_SOURCE=registry` und `REGISTRY_IMAGE=ghcr.io/hundexe/zammad-service-portal`. Die Images entstehen dann mit dem Workflow **Release-Images** (nur auf Knopfdruck) und werden schlüssellos mit cosign signiert. Der Updater prüft die Signatur mit `cosign verify` gegen die Identität des Workflows. Für ein privates Repository braucht die VM ein Token mit `read:packages` (`REGISTRY_USER`, `REGISTRY_TOKEN_FILE`).

## Sicherheit des Updaters

- Der Updater hat **keinen** offenen Port. Er liest nur Aufträge aus der Datenbank, die ausschließlich Benutzer mit dem Recht `update.install` nach frischer Anmeldung anlegen können, und nur für Versionen, die er selbst gefunden hat.
- Versionsangaben werden streng geprüft (`x.y.z`); Befehle werden ohne Shell ausgeführt.
- Docker spricht er nur über den Socket-Proxy an (kein `exec`, keine Secrets, kein Swarm). Das Bauen von Images ist dort erlaubt – wer den Updater übernimmt, hätte damit weitgehende Rechte auf der VM. Wer das nicht möchte, lässt das Profil `updater` weg und aktualisiert manuell.
