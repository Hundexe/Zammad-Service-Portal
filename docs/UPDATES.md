# Updates

Neue Versionen werden als **signierte Git-Tags** (`vX.Y.Z`, siehe **Releases**) veröffentlicht. Der Update-Dienst auf der VM holt sie, prüft die Signatur, baut die Images **auf der VM** und startet das Portal neu. Dafür braucht es weder GitHub Actions noch eine Container-Registry.


> **Installation ohne Docker** (`deploy/native/install.sh`): Ab 1.8.0 gibt es den Update-Dienst auch dort – siehe [Installation ohne Docker](#installation-ohne-docker). Alternativ weiterhin den Installationsbefehl erneut ausführen.

> **Voraussetzung: signierte Release-Tags.** Der Update-Dienst installiert nur Versionen, die als signierter Tag `vX.Y.Z` im Repository liegen (`git verify-tag` gegen `allowed_signers`). Gibt es im Repository keine solchen Tags, zeigt die Verwaltung keine neue Version an und der Update-Dienst tut nichts – das ist so gewollt. Dann entweder Releases wie unten beschrieben mit `tools/release.sh` signieren und den Tag pushen, oder bis dahin manuell aktualisieren ([unten](#manuell-aktualisieren-ohne-updater)).

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

Die Release-Tags dieses Repositorys sind mit dem Projektschlüssel aus [`deploy/release_signers`](../deploy/release_signers) signiert (ed25519, Fingerabdruck **`SHA256:ddbtjFbMXjsaYtgyYjLPXZJMNgCOIWZIfWCok+RGZX8`**). Der Schlüssel wird bei der ersten Installation übernommen und danach nicht mehr aus dem Repository überschrieben – die Integrität hängt also am ersten Bezug: den Fingerabdruck, den die Installation anzeigt, mit diesem Wert vergleichen (am besten über einen zweiten Weg, z. B. die Release-Seite). `install.sh` übernimmt ihn automatisch nach `deploy/allowed_signers`, wenn dort noch nichts steht. Prüfen von Hand:

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

## Installation ohne Docker

`deploy/native/install.sh` richtet den systemd-Dienst `zammad-service-portal-updater` ein (läuft als root, hat keinen offenen Port). root braucht er nur für `git`, `systemctl` und `install.sh`; die Datenbank (Aufträge, Status, Sicherung, Wiederherstellung) öffnet ein Helfer-Prozess mit den Rechten des Dienstbenutzers (`updater/db-agent.ts`). Er arbeitet wie der Docker-Updater, nur ohne Images:

1. prüft alle 6 Stunden (oder nach **Jetzt nach Updates suchen**) die Tags `vX.Y.Z` im Repository,
2. prüft die **Signatur des Tags** gegen `/etc/zammad-service-portal/allowed_signers` (beim ersten Lauf aus `deploy/release_signers` übernommen),
3. sichert die Datenbank nach `/var/lib/zammad-service-portal/backups/vor-update-…sqlite`,
4. checkt den Tag aus und führt `deploy/native/install.sh --ja` aus (Oberfläche bauen, Web und Worker neu starten, Benutzer bleiben unverändert),
5. wartet, bis `http://127.0.0.1:3000/readyz` die neue Version meldet,
6. setzt bei einem Fehler **automatisch zurück** (Dienste stoppen, Datenbank wiederherstellen, alten Stand auschecken, `install.sh` erneut).

Danach startet sich der Update-Dienst selbst mit dem neuen Code neu.

**Installationen vor 1.8.0** haben den Dienst noch nicht – einmal den Installationsbefehl ausführen, danach geht es über die Verwaltung:

```bash
curl -fsSL https://raw.githubusercontent.com/Hundexe/Zammad-Service-Portal/main/setup.sh | sudo bash
systemctl status zammad-service-portal-updater        # läuft er?
journalctl -u zammad-service-portal-updater -n 50     # was hat er zuletzt getan?
```

| Einstellung in `portal.env` | Bedeutung |
| --- | --- |
| `UPDATER_ENABLED=false` | Update-Dienst abschalten (danach `install.sh` erneut ausführen) |
| `UPDATE_ALLOWED_SIGNERS` | Datei mit erlaubten Signaturschlüsseln (Standard `/etc/zammad-service-portal/allowed_signers`) |
| `UPDATE_REQUIRE_SIGNED_TAGS=false` | Signatur nicht prüfen – nicht empfohlen |
| `CHECK_INTERVAL_HOURS` | Prüfabstand (Standard 6) |

Solange im Repository **kein signierter Tag** liegt, zeigt die Seite „noch keine veröffentlichte Version“ – siehe nächster Abschnitt.

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

## Nur benachrichtigen (ohne Update-Dienst)

Wer den Update-Dienst nicht betreiben will, aber wissen möchte, wann es eine neue Version gibt: `UPDATE_NOTIFY=true` in `.env` bzw. `portal.env` (der Installer fragt das ab, wenn man den Update-Dienst ablehnt). Dann prüft der Worker – **ohne** besondere Rechte – alle 6 Stunden (oder sofort mit „Jetzt nach Updates suchen“), welche Versions-Tags es im Repository gibt. Die Verwaltung zeigt unter **Updates** neue Versionen und die Befehle für das [manuelle Update](#manuell-aktualisieren-ohne-updater) an. Installieren lässt sich darüber nichts: Die Liste installierbarer Versionen pflegt allein der Update-Dienst nach Prüfung der Signatur.

| Einstellung | Standard | Bedeutung |
| --- | --- | --- |
| `UPDATE_NOTIFY` | `false` | nur benachrichtigen |
| `UPDATE_NOTIFY_URL` | GitHub-API, Tags dieses Repositorys | eigene Quelle (z. B. ein Fork); nur `https://` |

Läuft der Update-Dienst, prüft er selbst (mit Signatur) – die Benachrichtigung hält sich dann heraus.

## Sicherheit des Updaters

> **Kurz und ehrlich:** Der Update-Dienst ist **root-gleichwertig** – mit Docker über den Socket-Proxy (siehe unten), ohne Docker läuft er ohnehin als root. Wer ihn betreibt, vertraut damit jedem, der einen gültig signierten Release-Tag erzeugen kann: Ein signierter Tag darf auf dem Server Code als root ausführen. Der Signaturschlüssel gehört deshalb offline bzw. auf einen Hardware-Schlüssel, und `allowed_signers` sollte nur die Schlüssel enthalten, denen ihr dieses Vertrauen gebt. Wer das nicht will: Update-Dienst weglassen und [nur benachrichtigen](#nur-benachrichtigen-ohne-update-dienst) – Updates dann von Hand nach Prüfung.

- Der Updater hat **keinen** offenen Port. Er liest nur Aufträge aus der Datenbank, die ausschließlich Benutzer mit dem Recht `update.install` nach frischer Anmeldung anlegen können, und nur für Versionen, die er selbst gefunden hat.
- Versionsangaben werden streng geprüft (`x.y.z`); Befehle werden ohne Shell ausgeführt.
- Docker spricht er nur über den Socket-Proxy an. Der Proxy lässt nur die Teile der Docker-API durch, die `docker compose build/pull/up/stop` braucht:

  | Bereich | erlaubt | Warum |
  | --- | --- | --- |
  | Container, Start/Stop/Neustart | ja | `app` und `worker` neu erstellen und starten |
  | Images | ja | neues Image bauen bzw. laden |
  | Build | ja bei `UPDATE_SOURCE=git`, sonst mit `UPDATER_ALLOW_BUILD=0` abschaltbar | auf der VM bauen |
  | Netzwerke, Volumes | ja (nur weil Compose sie prüft) | `up` kontrolliert die vorhandenen Netze und das Datenvolume |
  | `exec`, Secrets, Swarm, Plugins, Anmeldedaten, System | **nein** | – |

- **Restrisiko, ehrlich benannt:** Die Docker-API lässt sich an dieser Stelle nicht feiner begrenzen – ein Socket-Proxy kann nur ganze Bereiche erlauben, nicht den Inhalt eines Aufrufs prüfen. Wer den Updater-Container selbst übernimmt, könnte über die erlaubten Aufrufe einen Container mit Zugriff auf das Dateisystem der VM starten und hätte damit **root-Rechte auf der VM**. Der Updater ist deshalb so klein wie möglich gehalten: kein offener Port, keine Shell, feste Befehle, nur signierte Versionen.
- **Wie man das Risiko verkleinert:**
  1. Am sichersten: Profil `updater` weglassen und manuell aktualisieren (Go-Live-Empfehlung für den Start).
  2. Mit Updater: fertige, signierte Images aus der Registry nutzen (`UPDATE_SOURCE=registry`) und `UPDATER_ALLOW_BUILD=0` setzen – dann fällt das Bauen über die API weg.
  3. Die Docker-VM nur für das Portal nutzen, damit „root auf der VM“ nichts anderes betrifft.
- Ohne Docker gibt es keinen Socket-Proxy; dort läuft der Update-Dienst als systemd-Dienst **als root** (er muss Pakete bauen und Dienste neu starten; siehe [Installation ohne Docker](#installation-ohne-docker)). Abschalten mit `UPDATER_ENABLED=false` in `portal.env` und `install.sh` erneut ausführen – oder bei der Installation „nein“ wählen.
