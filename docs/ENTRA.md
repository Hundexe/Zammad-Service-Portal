# Anmeldung mit Microsoft (Entra ID) einrichten

Diese Anleitung führt Schritt für Schritt durch alles, was in Microsoft Entra ID (früher Azure AD) nötig ist, damit sich die Mitarbeitenden mit ihrem Microsoft-Konto am Service-Portal anmelden (Single Sign-on). Danach wird das Portal eingerichtet und die Anmeldung getestet.

Platzhalter in dieser Anleitung – bitte durch eigene Werte ersetzen:

| Platzhalter | Bedeutung |
| --- | --- |
| `serviceportal.firma.intern` | Adresse, unter der das Portal im Browser aufgerufen wird |
| `<TENANT-ID>` | Verzeichnis-ID des Tenants, in dem die App registriert wird |
| `<TENANT-ID-2>` | nur bei zwei Tenants: Verzeichnis-ID des zweiten Tenants |
| `<CLIENT-ID>` | Anwendungs-ID der App-Registrierung |

Die Bezeichnungen im Entra Admin Center ändern sich gelegentlich ein wenig. Gemeint ist immer das Admin Center unter **https://entra.microsoft.com** in deutscher Sprache.

---

## Inhalt

1. [Was das Portal von Microsoft braucht – kurz erklärt](#1-was-das-portal-von-microsoft-braucht--kurz-erklärt)
2. [Voraussetzungen](#2-voraussetzungen)
3. [Ein oder zwei Tenants? Den richtigen Kontotyp wählen](#3-ein-oder-zwei-tenants-den-richtigen-kontotyp-wählen)
4. [App registrieren](#4-app-registrieren)
5. [Authentifizierung: Umleitungs-URIs](#5-authentifizierung-umleitungs-uris)
6. [Zugangsdaten: Client-Secret oder Zertifikat](#6-zugangsdaten-client-secret-oder-zertifikat)
7. [API-Berechtigungen](#7-api-berechtigungen)
8. [Tokenkonfiguration: Gruppen und auth_time](#8-tokenkonfiguration-gruppen-und-auth_time)
9. [Optional: App-Rollen](#9-optional-app-rollen)
10. [Unternehmensanwendung: wer darf sich anmelden](#10-unternehmensanwendung-wer-darf-sich-anmelden)
11. [Bedingter Zugriff (MFA)](#11-bedingter-zugriff-mfa)
12. [Nur bei zwei Tenants: zweiten Tenant anbinden](#12-nur-bei-zwei-tenants-zweiten-tenant-anbinden)
13. [Portal einrichten](#13-portal-einrichten)
14. [Rechte im Portal an Entra-Gruppen vergeben](#14-rechte-im-portal-an-entra-gruppen-vergeben)
15. [Anmeldung testen](#15-anmeldung-testen)
16. [Laufender Betrieb: Secret erneuern, Gruppen, Abmeldung](#16-laufender-betrieb)
17. [Fehler und Lösungen](#17-fehler-und-lösungen)
18. [Checkliste](#18-checkliste)

---

## 1. Was das Portal von Microsoft braucht – kurz erklärt

Das Portal nutzt den Standard **OpenID Connect** mit dem **Autorisierungscode-Fluss mit PKCE**:

1. Wer auf **Mit Microsoft anmelden** klickt, wird zu `login.microsoftonline.com` geschickt und meldet sich dort an (inklusive MFA nach euren Regeln).
2. Microsoft schickt den Browser mit einem einmaligen Code zurück an `https://serviceportal.firma.intern/api/auth/entra/callback`.
3. Der **Portal-Server** tauscht den Code bei Microsoft gegen ein ID-Token und ein Zugriffstoken. Dafür weist er sich mit dem **Client-Secret** oder einem **Zertifikat** aus.
4. Das Portal prüft das ID-Token vollständig: Signatur, Aussteller, Empfänger, **Tenant**, Gültigkeit und Einmalwert. Danach liest es mit dem Zugriffstoken über Microsoft Graph:
   - **Abteilung und E-Mail-Adresse** (`/me`);
   - die **verifizierten Domains** des Tenants (`/organization`). Damit stellt das Portal sicher, dass niemand eine fremde E-Mail-Adresse mitbringt; an dieser Adresse hängen Zammad-Tickets und Freigaben.

Das Portal braucht **nur delegierte Berechtigungen**, also nur im Namen der angemeldeten Person. Es braucht **keine** Anwendungsberechtigungen und kein Lesen anderer Benutzer oder des ganzen Verzeichnisses. Es speichert keine Tokens von Microsoft und bekommt kein Refresh-Token.

Microsoft muss den Portal-Server **nicht** erreichen können: Die Rückleitung läuft über den Browser. Ein rein interner Name wie `serviceportal.firma.intern` funktioniert also. Der Portal-Server selbst muss aber nach außen dürfen:

| Ziel (Port 443) | Wofür |
| --- | --- |
| `login.microsoftonline.com` | Anmeldung, Code gegen Token tauschen, Signaturschlüssel |
| `graph.microsoft.com` | Abteilung, E-Mail, verifizierte Domains |

---

## 2. Voraussetzungen

- **Rolle in Entra:**
  - Zum Registrieren der App genügt **Anwendungsentwickler**; zum Erteilen der Administratorzustimmung braucht es **Cloudanwendungsadministrator**, **Anwendungsadministrator** oder **Globaler Administrator**.
  - Für Richtlinien des bedingten Zugriffs: **Administrator für bedingten Zugriff**.
- **Lizenz:**
  - Ohne zusätzliche Lizenz: App-Registrierung, Zuweisung **einzelner Benutzer** und Gruppen im Token.
  - **Gruppen** einer App zuweisen (Schritt 10) und **bedingter Zugriff** (Schritt 11) brauchen **Microsoft Entra ID P1** (z. B. in Microsoft 365 Business Premium oder E3/E5 enthalten).
  - Ohne P1 geht es auch, siehe die Hinweise in den Schritten 8 und 10.
- **Adresse des Portals:**
  - Die endgültige Adresse sollte feststehen, am besten ein DNS-Name.
  - Die Umleitungs-URI muss mit `https://` beginnen; sie muss im Browser der Mitarbeitenden ohne Zertifikatswarnung aufgehen (bei der internen Caddy-CA: Stammzertifikat verteilen, siehe [Betrieb](BETRIEB.md#zertifikat-der-internen-caddy-ca-verteilen)).
  - Bei der Installation ohne Docker zeigt das Installationsskript die passende Umleitungs-URI an.
- **Ein lokales Notfallkonto** im Portal mit Super-Admin-Rechten (legt die Installation an). Damit lassen sich Rechte vergeben, bevor sich die erste Person mit Microsoft angemeldet hat, und es bleibt der Weg hinein, falls Microsoft einmal nicht erreichbar ist.

---

## 3. Ein oder zwei Tenants? Den richtigen Kontotyp wählen

| Situation | Kontotyp bei der Registrierung | `ENTRA_ALLOWED_TENANTS` |
| --- | --- | --- |
| Alle Mitarbeitenden sind in **einem** Tenant | **Nur Konten in diesem Organisationsverzeichnis** (einzelner Mandant) | `<TENANT-ID>` (oder leer lassen) |
| Zwei Firmen, die Benutzer des zweiten Tenants sind als **B2B-Gäste** im ersten Tenant angelegt (z. B. über mandantenübergreifende Synchronisierung) | **Nur Konten in diesem Organisationsverzeichnis** | nur `<TENANT-ID>` |
| Zwei Firmen, jede Person meldet sich mit **ihrem eigenen** Tenant an | **Konten in einem beliebigen Organisationsverzeichnis** (mehrinstanzenfähig) | `<TENANT-ID>,<TENANT-ID-2>` |

Gut zu wissen:

- Das Portal lässt **nur die eingetragenen Tenants** herein – auch bei einer mehrinstanzenfähigen App. Fremde Tenants werden immer abgelehnt.
- Bei **B2B-Gästen** stehen im Token nur Gruppen aus dem Tenant der App; die Gruppen aus dem Heimat-Tenant der Gäste sieht das Portal nicht. Gäste deshalb in Gruppen des App-Tenants aufnehmen.
- Bei **eigenem Tenant je Firma** hat jede Gruppe eine Objekt-ID in *ihrem* Tenant. Im Portal werden dann die Gruppen beider Tenants eingetragen (Schritt 14).

---

## 4. App registrieren

1. **https://entra.microsoft.com** öffnen und mit einem Admin-Konto des Tenants anmelden, in dem die App liegen soll (bei zwei Tenants: der „Haupt“-Tenant).
2. Links **Anwendungen → App-Registrierungen** → oben **Neue Registrierung**.
3. Ausfüllen:
   - **Name:** `Service-Portal` (sehen die Mitarbeitenden bei der Anmeldung und in „Meine Apps“)
   - **Unterstützte Kontotypen:** wie in Schritt 3 gewählt
   - **Umleitungs-URI:** Plattform **Web**, Adresse `https://serviceportal.firma.intern/api/auth/entra/callback`
     - genau so: mit `https://`, ohne abschließenden Schrägstrich, Pfad `/api/auth/entra/callback`
     - läuft das Portal auf einem anderen Port als 443, gehört er dazu: `https://serviceportal.firma.intern:8443/api/auth/entra/callback`
4. **Registrieren**.
5. Auf der Seite **Übersicht** zwei Werte notieren:
   - **Anwendungs-ID (Client)** → wird `ENTRA_CLIENT_ID`
   - **Verzeichnis-ID (Mandant)** → wird `ENTRA_TENANT_ID`

> Plattform **Web** ist wichtig. „Single-Page-Anwendung“ oder „Mobilgerät und Desktop“ funktionieren nicht, weil der Portal-Server den Code mit einem Secret oder Zertifikat einlöst.

---

## 5. Authentifizierung: Umleitungs-URIs

Links in der App-Registrierung **Authentifizierung**:

1. Unter **Web → Umleitungs-URIs** steht die Adresse aus Schritt 4. Zusätzlich **URI hinzufügen**: `https://serviceportal.firma.intern/` (Startseite, mit Schrägstrich). Dorthin schickt Microsoft nach dem **Abmelden** zurück; ohne diesen Eintrag bleibt man nach dem Abmelden auf einer Microsoft-Seite stehen.
2. Wird das Portal unter mehreren Adressen aufgerufen (z. B. Name und IP), muss **jede** Adresse als eigene Umleitungs-URI eingetragen werden. Besser: nur eine Adresse verwenden, die auch in `PUBLIC_URL` steht – das Portal lehnt Aufrufe unter anderen Namen ohnehin ab.
3. **Front-Channel-Abmelde-URL:** leer lassen.
4. **Implizite Gewährung und Hybridflows:** **keinen** Haken setzen (weder Zugriffstokens noch ID-Tokens). Das Portal nutzt den sicheren Code-Fluss.
5. **Öffentliche Clientflows zulassen:** **Nein**.
6. **Speichern**.

---

## 6. Zugangsdaten: Client-Secret oder Zertifikat

Der Portal-Server weist sich bei Microsoft aus. Es gibt zwei Wege – **einer** genügt.

### Variante A: Client-Secret (einfach)

1. Links **Zertifikate & Geheimnisse** → Reiter **Geheime Clientschlüssel** → **Neuer geheimer Clientschlüssel**.
2. Beschreibung `Service-Portal`, Ablauf **12 Monate** (höchstens 24).
3. **Hinzufügen** – dann sofort die Spalte **Wert** kopieren (nicht die „Geheimnis-ID“). Der Wert wird **nur jetzt** angezeigt.
4. Ablaufdatum in den Kalender eintragen, mit Erinnerung vier Wochen vorher (siehe [Schritt 16](#16-laufender-betrieb)).

Wohin der Wert gehört, steht in [Schritt 13](#13-portal-einrichten). Der Wert gehört nicht in E-Mails, Tickets oder Chats.

### Variante B: Zertifikat (sicherer, empfohlen für den Dauerbetrieb)

Kein Geheimnis, das abgeschrieben werden kann: Der private Schlüssel bleibt auf dem Portal-Server, bei Microsoft liegt nur das öffentliche Zertifikat.

Auf dem Portal-Server (Docker: im Ordner `deploy`, ohne Docker: in `/etc/zammad-service-portal`):

```bash
openssl req -x509 -newkey rsa:3072 -nodes -days 730 -subj "/CN=Service-Portal" \
  -keyout secrets/entra_cert.key -out entra_cert.crt
# Fingerabdruck für ENTRA_CERT_THUMBPRINT (SHA-256, Base64url):
openssl x509 -in entra_cert.crt -outform DER | openssl dgst -sha256 -binary | openssl base64 | tr '+/' '-_' | tr -d '='
```

1. In der App-Registrierung **Zertifikate & Geheimnisse** → Reiter **Zertifikate** → **Zertifikat hochladen** → `entra_cert.crt`.
2. Im Portal `ENTRA_CERT_PRIVATE_KEY_FILE` und `ENTRA_CERT_THUMBPRINT` setzen (Schritt 13). Das Client-Secret kann dann leer bleiben bzw. gelöscht werden.
3. Ablauf nach 2 Jahren vormerken.

> Der Fingerabdruck, den Entra in der Liste anzeigt, ist SHA-1 in Hex. Das Portal erwartet den SHA-256-Wert aus dem Befehl oben.

---

## 7. API-Berechtigungen

Links **API-Berechtigungen**. Standardmäßig steht dort schon `User.Read`.

Benötigt werden genau diese **delegierten** Berechtigungen von **Microsoft Graph**:

| Berechtigung | Typ | Wofür |
| --- | --- | --- |
| `openid` | Delegiert | Anmeldung (OpenID Connect) |
| `profile` | Delegiert | Name der Person im Token |
| `email` | Delegiert | E-Mail-Adresse im Token |
| `User.Read` | Delegiert | eigene Abteilung und E-Mail lesen (`/me`), verifizierte Domains des eigenen Tenants (`/organization`) |

So hinzufügen:

1. **Berechtigung hinzufügen** → **Microsoft Graph** → **Delegierte Berechtigungen**.
2. Unter **OpenId-Berechtigungen** `openid`, `profile`, `email` anhaken; `User.Read` ist schon da (unter **User**).
3. **Berechtigungen hinzufügen**.
4. **Administratorzustimmung für \<Tenant\> erteilen** → **Ja**. In der Spalte *Status* steht danach bei allen vier ein grüner Haken „Gewährt für …“.

**Nicht** hinzufügen:

- **keine Anwendungsberechtigungen**;
- kein `User.Read.All`, `Directory.Read.All`, `GroupMember.Read.All` o. Ä.;
- kein `offline_access` – das Portal braucht kein Refresh-Token.

Die Gruppen kommen über das Token (Schritt 8), nicht über Graph.

> Die Administratorzustimmung erspart den Mitarbeitenden die Frage „Diese App möchte …“ und ist nötig, wenn in eurem Tenant Benutzer keinen Apps zustimmen dürfen (Standard in vielen Unternehmen).

---

## 8. Tokenkonfiguration: Gruppen und auth_time

Links **Tokenkonfiguration**.

### 8.1 Gruppen im Token

Über Gruppen steuert ihr im Portal, wer welche Ticketsysteme und Formulare sieht und wer Verwaltungsrechte hat.

1. **Gruppenanspruch hinzufügen**.
2. Gruppentyp wählen:
   - **Der Anwendung zugewiesene Gruppen** – **empfohlen**. Im Token stehen nur die Gruppen, die in Schritt 10 der App zugewiesen werden, und das Token bleibt klein. Braucht Entra ID P1 (weil Gruppen der App zugewiesen werden).
   - Ohne P1: **Sicherheitsgruppen**. Dann stehen alle Sicherheitsgruppen der Person im Token. **Achtung:** Ab etwa 200 Gruppen pro Person lässt Microsoft die Gruppen im Token weg („Gruppenüberschreitung“). Das Portal behandelt die Person dann so, als hätte sie **keine** Gruppen; sie sieht nur, was für alle freigegeben ist.
3. Unter **ID** die Option **Gruppen-ID** auswählen (nicht `sAMAccountName` oder Gruppenname). Das Portal arbeitet mit den **Objekt-IDs** der Gruppen.
4. **Hinzufügen**.

### 8.2 Optionaler Anspruch `auth_time` (wichtig)

Vor kritischen Aktionen in der Verwaltung (z. B. Rollen ändern, Updates einspielen) verlangt das Portal eine **erneute Anmeldung** („Step-up“). Ob die Person sich wirklich gerade eben neu angemeldet hat, belegt nur der Anspruch `auth_time` im ID-Token.

1. **Optionalen Anspruch hinzufügen**.
2. Tokentyp **ID**.
3. **`auth_time`** anhaken → **Hinzufügen**.
4. Falls Entra fragt, ob die Microsoft-Graph-Berechtigung `profile`/`email` aktiviert werden soll: zustimmen (sind ohnehin aus Schritt 7 vorhanden).

Ohne `auth_time` lehnt das Portal die Bestätigung für Microsoft-Konten ab („Claim auth_time fehlt“). Normale Anmeldung und Anfragen funktionieren trotzdem, nur kritische Verwaltungsaktionen nicht.

Optional, aber praktisch: ebenfalls im ID-Token **`email`** als optionalen Anspruch hinzufügen. Das Portal holt die Adresse sonst aus Microsoft Graph oder aus dem Anmeldenamen.

---

## 9. Optional: App-Rollen

Statt (oder zusätzlich zu) Gruppen lassen sich **App-Rollen** nutzen. Sie gelten nur für diese App und sind im Portal leichter lesbar als Gruppen-IDs.

1. Links **App-Rollen** → **App-Rolle erstellen**.
2. Zum Beispiel:

   | Anzeigename | Zulässige Mitgliedstypen | Wert | Beschreibung |
   | --- | --- | --- | --- |
   | Portal-Administration | Benutzer/Gruppen | `Portal.Admin` | Verwaltet das Service-Portal |
   | Portal-Formulare | Benutzer/Gruppen | `Portal.Formulare` | Bearbeitet Formulare |

3. **Diese App-Rolle aktivieren?** angehakt → **Anwenden**.
4. Die Rollen werden in Schritt 10 Personen oder Gruppen zugewiesen.

Im Portal heißen sie dann `approle:Portal.Admin`, `approle:Portal.Formulare` und werden in [Schritt 14](#14-rechte-im-portal-an-entra-gruppen-vergeben) wie eine Gruppe eingetragen.

---

## 10. Unternehmensanwendung: wer darf sich anmelden

Zu jeder App-Registrierung gehört eine **Unternehmensanwendung** mit demselben Namen. Dort legt ihr fest, **wer** sich überhaupt anmelden darf.

1. Links **Anwendungen → Unternehmensanwendungen** → **Service-Portal** öffnen.
2. **Eigenschaften:**
   - **Aktiviert für Benutzeranmeldung?** **Ja**
   - **Zuweisung erforderlich?** **Ja** – sonst kann sich jedes Konto des Tenants anmelden.
   - **Für Benutzer sichtbar?** nach Wunsch (erscheint dann in „Meine Apps“ / Microsoft 365-Startseite)
   - Optional: **Logo** hochladen
   - **Speichern**
3. **Benutzer und Gruppen** → **Benutzer/Gruppe hinzufügen**:
   - die Gruppen (oder Personen) auswählen, die das Portal nutzen dürfen, z. B. „Alle Mitarbeitenden“ und „IT“;
   - falls App-Rollen angelegt sind: **Rolle auswählen**;
   - **Zuweisen**.

Ohne P1 lassen sich hier nur **einzelne Benutzer** zuweisen. Alternativ „Zuweisung erforderlich“ auf **Nein** lassen – dann dürfen alle Konten des Tenants hinein, und ihr steuert die Sichtbarkeit nur im Portal.

> Die Gruppen, die hier zugewiesen werden, sind dieselben, die bei „Der Anwendung zugewiesene Gruppen“ (Schritt 8) im Token landen. Jede Gruppe, die im Portal Rechte bekommen soll, muss also hier zugewiesen sein.

Verschachtelte Gruppen: Zuweisungen gelten nur für **direkte** Mitglieder der zugewiesenen Gruppe.

---

## 11. Bedingter Zugriff (MFA)

Das Portal verlässt sich bei Microsoft-Konten auf die Mehrfaktor-Anmeldung von Microsoft und fragt selbst keinen zweiten Faktor ab. Deshalb sollte für die App eine Richtlinie gelten.

1. **Schutz → Bedingter Zugriff → Richtlinien → Neue Richtlinie**.
2. Name: `Service-Portal – MFA`.
3. **Benutzer:** einschließen „Alle Benutzer“ (oder die Gruppen aus Schritt 10); ausschließen: Notfall-/Break-Glass-Konten.
4. **Zielressourcen → Ressourcen (früher Cloud-Apps) → Ressourcen auswählen → Service-Portal**.
5. **Gewähren → Zugriff gewähren → Mehrstufige Authentifizierung erforderlich** (optional zusätzlich „Gerät muss als konform markiert sein“).
6. Erst **Nur Bericht**, nach einem Test **Ein**.

Gibt es bereits eine Richtlinie „MFA für alle Apps“, deckt die das Portal mit ab.

---

## 12. Nur bei zwei Tenants: zweiten Tenant anbinden

Nur nötig, wenn ihr in Schritt 3 **mehrinstanzenfähig** gewählt habt.

1. Ein Admin des **zweiten** Tenants ruft im Browser auf:

   ```
   https://login.microsoftonline.com/<TENANT-ID-2>/adminconsent?client_id=<CLIENT-ID>
   ```

   meldet sich mit seinem Admin-Konto an und stimmt zu. Danach gibt es im zweiten Tenant eine Unternehmensanwendung „Service-Portal“.
   Die Weiterleitung danach landet auf der Umleitungs-URI des Portals und zeigt dort eventuell einen Fehler. Das ist normal: Die Zustimmung ist trotzdem erteilt.
2. Im zweiten Tenant für diese Unternehmensanwendung die Schritte **10** (Zuweisung erforderlich, Gruppen zuweisen) und **11** (bedingter Zugriff) wiederholen.
3. Gruppenanspruch und `auth_time` (Schritt 8) werden in der **App-Registrierung** im ersten Tenant eingestellt und gelten für beide.
4. Im Portal beide Tenant-IDs eintragen: `ENTRA_ALLOWED_TENANTS=<TENANT-ID>,<TENANT-ID-2>`.

**E-Mail-Domains:** Das Portal übernimmt nur E-Mail-Adressen aus Domains, die im jeweiligen Tenant **verifiziert** sind. Es liest sie selbst über Graph (`/organization`, Recht `User.Read`). Wer das fest vorgeben will (oder wenn Graph nicht erreichbar ist), setzt:

```
ENTRA_TENANT_DOMAINS=<TENANT-ID>=firma-a.de,firma-a.com;<TENANT-ID-2>=firma-b.de
```

Bei **einem** Tenant ist das nicht nötig.

---

## 13. Portal einrichten

### Mit Docker

In `deploy/.env`:

```bash
ENTRA_TENANT_ID=<TENANT-ID>
ENTRA_CLIENT_ID=<CLIENT-ID>
# nur bei zwei Tenants (sonst leer lassen):
ENTRA_ALLOWED_TENANTS=<TENANT-ID>,<TENANT-ID-2>
```

Client-Secret (Variante A) in die Datei schreiben – ohne Zeilenumbruch am Ende:

```bash
cd deploy
printf '%s' 'HIER-DEN-WERT-EINFÜGEN' > secrets/entra_client_secret
chmod 600 secrets/entra_client_secret
history -c   # Wert aus dem Shell-Verlauf entfernen
```

Zertifikat (Variante B): `secrets/entra_cert.key` liegt schon aus Schritt 6. In `docker-compose.yml` beim Dienst `app` das Secret `entra_cert_key` ergänzen und in `.env` setzen:

```bash
ENTRA_CERT_PRIVATE_KEY_FILE=/run/secrets/entra_cert_key
ENTRA_CERT_THUMBPRINT=<SHA-256-Fingerabdruck aus Schritt 6>
```

Übernehmen: `docker compose up -d`.

### Ohne Docker (native Installation)

Am einfachsten über das Installationsskript, das die Werte abfragt:

```bash
sudo /opt/zammad-service-portal/deploy/native/install.sh
# „Einstellungen ändern?“ → j, „Microsoft-Anmeldung jetzt einrichten?“ → j
# Tenant-ID, Client-ID, erlaubte Tenants und das Client-Secret (unsichtbare Eingabe) angeben
```

Oder von Hand in `/etc/zammad-service-portal/portal.env` die drei `ENTRA_*`-Werte wie oben setzen und das Secret ablegen:

```bash
sudo sh -c "printf '%s' 'HIER-DEN-WERT-EINFÜGEN' > /etc/zammad-service-portal/secrets/entra_client_secret"
sudo chown zsp:zsp /etc/zammad-service-portal/secrets/entra_client_secret
sudo chmod 400 /etc/zammad-service-portal/secrets/entra_client_secret
sudo systemctl restart zammad-service-portal zammad-service-portal-worker
```

Zertifikat ohne Docker: Schlüssel nach `/etc/zammad-service-portal/secrets/entra_cert.key` (Besitzer `zsp`, Rechte 400) und in `portal.env`:

```bash
ENTRA_CERT_PRIVATE_KEY_FILE=/etc/zammad-service-portal/secrets/entra_cert.key
ENTRA_CERT_THUMBPRINT=<SHA-256-Fingerabdruck>
```

### Weitere Einstellungen (optional)

| Einstellung | Standard | Bedeutung |
| --- | --- | --- |
| `ENTRA_ALLOWED_TENANTS` | Tenant der App | Tenants, deren Benutzer sich anmelden dürfen |
| `ENTRA_TENANT_DOMAINS` | aus Graph | erlaubte E-Mail-Domains je Tenant (Schritt 12) |
| `ENTRA_JWKS_MAX_STALE_HOURS` | 72 | so lange arbeitet das Portal mit den zuletzt geladenen Signaturschlüsseln von Microsoft weiter, wenn Microsoft nicht erreichbar ist |
| `LOCAL_LOGIN_ENABLED` | `true` | lokale Anmeldung (Notfallkonto) anbieten; mit Microsoft-Anmeldung steht sie eingeklappt unter „Mit lokalem Konto anmelden“ |
| `STEPUP_MINUTES` | 10 | wie lange eine Bestätigung für kritische Aktionen gilt |

Sobald `ENTRA_TENANT_ID` und `ENTRA_CLIENT_ID` gesetzt sind, zeigt die Anmeldeseite **Mit Microsoft anmelden**. Fehlt das Secret bzw. Zertifikat, startet das Portal nicht und sagt im Log, was fehlt.

---

## 14. Rechte im Portal an Entra-Gruppen vergeben

Das Portal hat eigene Rollen (Super-Admin, Ziel-Admin, Formular-Editor, …, siehe [Bedienung → Rollen und Rechte](BEDIENUNG.md#rollen-und-rechte)). Sie werden **Entra-Gruppen** zugeordnet.

1. **Objekt-ID der Gruppe** holen: Entra Admin Center → **Gruppen → Alle Gruppen** → Gruppe öffnen → **Objekt-ID** kopieren (Format `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`).
2. Mit dem **lokalen Notfallkonto** am Portal anmelden → **Verwaltung → Rollen und Rechte → Zuordnen**:
   - **Rolle:** z. B. `Super-Admin`
   - **Wem:** `Entra-Gruppe`
   - **Gruppe oder Person:** die Objekt-ID (oder `approle:Portal.Admin` für eine App-Rolle)
   - **Ticketsystem:** „alle“ oder ein bestimmtes
3. Sichtbarkeit steuern: Bei jedem Ticketsystem (**Verbindung → Sichtbar für Entra-Gruppen**) und jedem Formular lassen sich Gruppen-IDs eintragen, eine pro Zeile. Leer = alle angemeldeten Personen.

Bei zwei Tenants mit eigener Anmeldung: Die gleichnamige Gruppe hat in jedem Tenant eine **andere** Objekt-ID – beide eintragen.

Rechte aus Gruppen greifen bei der **nächsten Anmeldung** (das Token wird bei jeder Anmeldung neu gelesen). Siehe [Betrieb → Wann Rechteänderungen greifen](BETRIEB.md#wann-rechteänderungen-greifen).

---

## 15. Anmeldung testen

1. Privates Browserfenster öffnen, `https://serviceportal.firma.intern` aufrufen → **Mit Microsoft anmelden**.
2. Mit einem Konto anmelden, das in Schritt 10 zugewiesen wurde. Erwartet: MFA nach euren Regeln, danach die Startseite des Portals.
3. Oben rechts auf den Namen → **Mein Konto**: Name, E-Mail-Adresse und Abteilung müssen stimmen.
4. Mit einem **nicht zugewiesenen** Konto testen: Microsoft muss die Anmeldung ablehnen (AADSTS50105).
5. Mit einem Konto aus der Admin-Gruppe: **Verwaltung** muss erscheinen. Eine kritische Aktion (z. B. eine Rolle zuordnen) auslösen → das Portal fordert eine erneute Microsoft-Anmeldung an und führt die Aktion danach aus. Klappt das nicht, fehlt meist `auth_time` (Schritt 8.2).
6. **Abmelden** → man landet über Microsoft wieder auf der Startseite des Portals (sonst fehlt die zweite Umleitungs-URI aus Schritt 5).
7. In Entra unter **Überwachung → Anmeldeprotokolle**, Filter Anwendung „Service-Portal“: die Anmeldungen müssen mit Status „Erfolg“ und, je nach Richtlinie, „Mehrstufige Authentifizierung“ erscheinen.

Im Portal-Log stehen Anmeldungen und Ablehnungen mit Grund:

```bash
docker compose logs app | grep -i microsoft          # mit Docker
journalctl -u zammad-service-portal | grep -i microsoft   # ohne Docker
```

---

## 16. Laufender Betrieb

**Client-Secret erneuern** (spätestens vor Ablauf):

1. In der App-Registrierung ein **neues** Secret anlegen (das alte bleibt vorerst gültig).
2. Neuen Wert wie in Schritt 13 in die Secret-Datei schreiben und das Portal neu starten (Docker: `docker compose up -d --force-recreate app`, ohne Docker: `systemctl restart zammad-service-portal`).
3. Anmeldung testen, dann das **alte** Secret in Entra löschen.

Läuft das Secret ab, ist die Microsoft-Anmeldung gesperrt (AADSTS7000222). Das lokale Notfallkonto funktioniert weiter.

**Zertifikat erneuern:** neues Zertifikat erzeugen und hochladen (beide dürfen parallel gültig sein), Fingerabdruck und Schlüsseldatei im Portal tauschen, neu starten, altes Zertifikat in Entra löschen.

**Neue Gruppe soll Rechte bekommen:** Gruppe in Schritt 10 der App zuweisen (sonst steht sie nicht im Token) und im Portal unter **Rollen und Rechte** zuordnen.

**Person verlässt das Unternehmen:** Konto in Entra sperren genügt; eine neue Anmeldung ist dann nicht mehr möglich. Laufende Portal-Sitzungen enden spätestens nach `SESSION_MAX_HOURS` (Standard 10 Stunden). Sofort beenden: **Verwaltung → Benutzer → Deaktivieren** (beendet alle Sitzungen der Person).

**Abmeldung:** „Abmelden“ im Portal beendet die Portal-Sitzung und meldet auch bei Microsoft ab.

---

## 17. Fehler und Lösungen

Fehler mit **AADSTS…** zeigt Microsoft auf der eigenen Anmeldeseite. Die genaue Ursache steht in Entra unter **Überwachung → Anmeldeprotokolle**.

| Meldung | Ursache | Lösung |
| --- | --- | --- |
| **AADSTS50011** – Umleitungs-URI stimmt nicht | Adresse in der App-Registrierung weicht ab (http statt https, Port, Schrägstrich, anderer Name) | Schritt 4/5: exakt `https://<PUBLIC_URL>/api/auth/entra/callback` eintragen; `PUBLIC_URL` im Portal prüfen |
| **AADSTS50105** – Benutzer ist der Anwendung nicht zugewiesen | „Zuweisung erforderlich“ ist an, die Person ist nicht (direkt) in einer zugewiesenen Gruppe | Schritt 10: Person oder Gruppe zuweisen |
| **AADSTS65001** / **AADSTS90094** – Zustimmung erforderlich | Administratorzustimmung fehlt | Schritt 7: **Administratorzustimmung erteilen**; bei zwei Tenants Schritt 12 |
| **AADSTS700016** – Anwendung im Verzeichnis nicht gefunden | falsche Client-ID, oder Person aus einem Tenant ohne Zustimmung | `ENTRA_CLIENT_ID` prüfen; zweiter Tenant: Schritt 12 |
| **AADSTS50020** – Benutzerkonto aus anderem Identitätsanbieter | Single-Tenant-App, Person gehört zu einem anderen Tenant und ist dort kein Gast | Gast einladen oder mehrinstanzenfähig (Schritt 3, 12) |
| **AADSTS7000215** – Ungültiger geheimer Clientschlüssel | Secret falsch kopiert (ID statt Wert, Zeilenumbruch, Leerzeichen) | Schritt 6/13: **Wert** mit `printf '%s'` speichern |
| **AADSTS7000222** – Secret abgelaufen | Ablaufdatum erreicht | Schritt 16: neues Secret |
| **AADSTS53003** – Durch bedingten Zugriff blockiert | Richtlinie verlangt z. B. konformes Gerät | Anmeldeprotokoll → Reiter „Bedingter Zugriff“ zeigt die Richtlinie |
| Portal: zurück auf der Anmeldeseite mit „Die Anmeldung bei Microsoft hat nicht geklappt“ | Grund steht im Portal-Log | Log ansehen (Schritt 15), häufig eine der folgenden Zeilen |
| Log: **Tenant nicht erlaubt** | Tenant der Person fehlt in `ENTRA_ALLOWED_TENANTS` | Tenant-ID ergänzen |
| Log: **Claim auth_time fehlt** | optionaler Anspruch fehlt | Schritt 8.2 |
| Log: **Verifizierte Domains des Tenants nicht abrufbar** | `User.Read`/Zustimmung fehlt oder `graph.microsoft.com` gesperrt | Schritt 7; Firewall (Schritt 1); oder `ENTRA_TENANT_DOMAINS` setzen |
| Person hat **keine E-Mail-Adresse** im Portal / sieht keine Tickets | Domain ihrer Adresse ist im Tenant nicht verifiziert, oder kein Postfach | Domain in Entra verifizieren bzw. `ENTRA_TENANT_DOMAINS`; die Adresse muss zur Adresse des Kunden in Zammad passen |
| Person sieht Ticketsysteme/Verwaltung nicht, obwohl in der Gruppe | Gruppe nicht der App zugewiesen (bei „Der Anwendung zugewiesene Gruppen“), Gruppenüberschreitung, oder noch nicht neu angemeldet | Schritt 8/10; abmelden und neu anmelden |
| Nach dem Abmelden bleibt man bei Microsoft stehen | Startseite fehlt als Umleitungs-URI | Schritt 5, Punkt 1 |
| Portal startet nicht: „Für Entra ID wird ENTRA_CLIENT_SECRET_FILE … benötigt“ | Client-ID gesetzt, aber kein Secret/Zertifikat | Schritt 13 |
| Log: „Signaturschlüssel von Microsoft nicht erneuerbar“ bzw. „… zu alt – Microsoft-Anmeldung gesperrt“ | Portal erreicht `login.microsoftonline.com` seit über 24 Stunden nicht | Firewall/Proxy prüfen |

---

## 18. Checkliste

| ☐ | Was | Wo |
| --- | --- | --- |
| ☐ | App registriert, Plattform **Web** | App-Registrierungen |
| ☐ | Umleitungs-URIs: `…/api/auth/entra/callback` **und** `…/` | Authentifizierung |
| ☐ | Keine impliziten Flows, keine öffentlichen Clientflows | Authentifizierung |
| ☐ | Client-Secret **oder** Zertifikat, Ablauf im Kalender | Zertifikate & Geheimnisse |
| ☐ | Delegiert: `openid`, `profile`, `email`, `User.Read` – **Administratorzustimmung erteilt** | API-Berechtigungen |
| ☐ | Keine Anwendungsberechtigungen | API-Berechtigungen |
| ☐ | Gruppenanspruch: der Anwendung zugewiesene Gruppen, als **Gruppen-ID** | Tokenkonfiguration |
| ☐ | Optionaler Anspruch **`auth_time`** im ID-Token | Tokenkonfiguration |
| ☐ | „Zuweisung erforderlich“ = Ja, Gruppen zugewiesen | Unternehmensanwendungen |
| ☐ | Richtlinie bedingter Zugriff mit MFA | Schutz → Bedingter Zugriff |
| ☐ | Nur zwei Tenants: Administratorzustimmung im zweiten Tenant, dort Zuweisung und MFA | zweiter Tenant |
| ☐ | `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, ggf. `ENTRA_ALLOWED_TENANTS`, Secret-Datei | Portal |
| ☐ | Ausgehend 443 zu `login.microsoftonline.com` und `graph.microsoft.com` | Firewall |
| ☐ | Rollen im Portal an Gruppen-IDs vergeben, Notfallkonto bleibt | Portal → Rollen und Rechte |
| ☐ | Test: Anmeldung, nicht zugewiesenes Konto, Step-up, Abmeldung, Anmeldeprotokoll | Schritt 15 |
