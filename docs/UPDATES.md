# Updates

Neue Versionen werden als **signierte Git-Tags** (`v1.1.0`) veröffentlicht. Der Update-Dienst auf der VM holt sie, prüft die Signatur, baut die Images **auf der VM** und startet das Portal neu. Dafür braucht es weder GitHub Actions noch eine Container-Registry.


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
cp allowed_signers.example allowed_signers
nano allowed_signers                                # öffentliche Signaturschlüssel eintragen (siehe unten)
grep COMPOSE_PROFILES .env                          # muss "updater" enthalten
docker compose up -d
```

In `.env`:

| Variable | Bedeutung |
| --- | --- |
| `UPDATE_SOURCE=git` | Tags holen und auf der VM bauen (Standard) |
| `UPDATE_REQUIRE_SIGNED_TAGS=true` | nur signierte Tags installieren (dringend empfohlen) |
| `PORTAL_DIR` | absoluter Pfad des Repositorys – muss stimmen, sonst findet Compose die Dateien nicht |

### Signaturschlüssel für Releases (auf dem Build-PC)

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
npm test                                 # alles grün?
# CHANGELOG.md ergänzen (## 1.1.0 – Datum), Version in package.json erhöhen
git commit -am "Version 1.1.0"
git tag -s v1.1.0 -m "Version 1.1.0"     # -s = signiert
git push && git push origin v1.1.0
```

Danach erscheint die Version spätestens nach 6 Stunden in der Oberfläche, sofort nach **Jetzt nach Updates suchen**.

## Manuell aktualisieren (ohne Updater)

```bash
cd /opt/zammad-service-portal
git fetch --tags
git -c gpg.ssh.allowedSignersFile=deploy/allowed_signers verify-tag v1.1.0
cd deploy
docker compose exec app /nodejs/bin/node src/server/cli.ts backup
git checkout v1.1.0
sed -i 's/^APP_VERSION=.*/APP_VERSION=1.1.0/' .env
docker compose build && docker compose up -d
docker compose ps        # app muss "healthy" sein
```

## Manuell zurückrollen

```bash
cd /opt/zammad-service-portal/deploy
docker compose stop app worker
git checkout v1.0.0
sed -i 's/^APP_VERSION=.*/APP_VERSION=1.0.0/' .env
# Datenbank aus dem Backup vor dem Update zurückholen (Dateiname aus dem Update-Protokoll):
docker run --rm -v service-portal_portal-data:/data alpine:3.20 sh -c \
  'cp /data/backups/vor-update-1.0.0-auf-1.1.0-*.sqlite /data/portal.sqlite && rm -f /data/portal.sqlite-wal /data/portal.sqlite-shm && chown 65532:65532 /data/portal.sqlite'
docker compose build && docker compose up -d
```

## Alternative: signierte Images aus der Registry

Wer nicht auf der VM bauen möchte: `UPDATE_SOURCE=registry` und `REGISTRY_IMAGE=ghcr.io/hundexe/zammad-service-portal`. Die Images entstehen dann mit dem Workflow **Release-Images** (nur auf Knopfdruck) und werden schlüssellos mit cosign signiert. Der Updater prüft die Signatur mit `cosign verify` gegen die Identität des Workflows. Für ein privates Repository braucht die VM ein Token mit `read:packages` (`REGISTRY_USER`, `REGISTRY_TOKEN_FILE`).

## Sicherheit des Updaters

- Der Updater hat **keinen** offenen Port. Er liest nur Aufträge aus der Datenbank, die ausschließlich Benutzer mit dem Recht `update.install` nach frischer Anmeldung anlegen können, und nur für Versionen, die er selbst gefunden hat.
- Versionsangaben werden streng geprüft (`x.y.z`); Befehle werden ohne Shell ausgeführt.
- Docker spricht er nur über den Socket-Proxy an (kein `exec`, keine Secrets, kein Swarm). Das Bauen von Images ist dort erlaubt – wer den Updater übernimmt, hätte damit weitgehende Rechte auf der VM. Wer das nicht möchte, lässt das Profil `updater` weg und aktualisiert manuell.
