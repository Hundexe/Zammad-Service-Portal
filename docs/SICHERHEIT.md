# Sicherheit

Dieses Dokument beschreibt, wie das Portal geschützt ist, gegen welche Angriffe und wo Restrisiken liegen. Prüfmaßstab ist der **OWASP Application Security Verification Standard (ASVS) 4.0, Level 2**. Die Ergebnisse des Penetrationstests stehen in [PENTEST.md](PENTEST.md).

## Bedrohungsmodell (Kurzfassung)

| Angreifer | Ziel | wichtigste Gegenmaßnahmen |
| --- | --- | --- |
| Mitarbeitende ohne Admin-Rechte | fremde Tickets lesen, Rechte ausweiten | Rechteprüfung bei jeder Anfrage, Zammad prüft per `X-On-Behalf-Of` zusätzlich, fremde Tickets liefern „nicht gefunden“ |
| Admin eines Ticketsystems | anderes System verändern, sich mehr Rechte geben | Rechte gelten pro System; Rollen/Benutzer/Updates nur global; Step-up; Vier-Augen-Prinzip; Audit-Log |
| Angreifer im internen Netz | Konten übernehmen, Sitzungen stehlen | nur Entra-SSO mit MFA, lokale Konten mit Sperre und TOTP, HttpOnly/Secure/SameSite-Cookies, TLS 1.2+ |
| Bösartige Webseite im Browser eines Mitarbeitenden | Aktionen im Namen des Opfers (CSRF), Clickjacking | CSRF-Token, Herkunftsprüfung, nur JSON, `frame-ancestors 'none'` |
| Manipulierte Inhalte (Uploads, Ticket-Antworten) | Schadcode verteilen, XSS | Dateityp am Inhalt, Virenscan, Anhänge immer als Download, HTML aus Zammad nur als Text, strenge CSP |
| Kompromittierte Abhängigkeit | Code einschleusen | keine npm-Laufzeitpakete, distroless-Image, gepinnte Images, signierte Updates |
| Diebstahl der VM-Festplatte oder eines Backups | Zugangsdaten auslesen | Tokens, 2FA-Geheimnisse, Anfrageinhalte und Uploads mit AES-256-GCM verschlüsselt; Schlüssel getrennt |

## Maßnahmen im Überblick

### Anmeldung und Sitzungen (ASVS V2, V3)

- **Microsoft Entra ID** per OpenID Connect, Authorization Code Flow mit **PKCE**, `state` und `nonce`. Das ID-Token wird vollständig selbst geprüft: Signatur (nur RS256, Schlüssel aus dem JWKS), Aussteller, Zielgruppe, **erlaubte Tenants**, Ablauf, Nonce. `alg: none`, fremde Tenants, abgelaufene oder manipulierte Tokens werden abgelehnt (automatisch getestet).
- Tokens von Microsoft verlassen den Server nie; der Browser bekommt nur ein Sitzungscookie.
- **MFA** für Microsoft-Konten über bedingten Zugriff in Entra; für **lokale Admin-Konten ist TOTP Pflicht** (RFC 6238, Codes nicht wiederverwendbar). Normale lokale Benutzer ohne Verwaltungsrechte brauchen keine 2FA (sie können sie freiwillig einrichten). Die Pflicht wird bei **jeder Anfrage** geprüft, nicht nur beim Login.
- **Lokale Konten**: generierte Passwörter (20 Zeichen, ca. 115 Bit), Änderung bei der ersten Anmeldung erzwungen, Hash mit **scrypt** (N=2¹⁷, r=8, p=1, OWASP-Empfehlung), Ratenbegrenzung je IP, gleiche Antwort und gleiche Laufzeit für unbekannte Benutzer. **Kontosperre nach 5 Fehlversuchen**, wobei falsche Passwörter, falsche 2FA-Codes, falsche Bestätigungen (Step-up) und ein falsches aktuelles Passwort beim Passwortwechsel **gemeinsam** zählen. Die Sperre wächst: 15 min, 30 min, 1 h … bis 24 h (Standardwerte, einstellbar). Der Zähler wird erst nach einer **vollständig** erfolgreichen Anmeldung zurückgesetzt. Details: [Lokale Anmeldung im Detail](#lokale-anmeldung-im-detail).
- **Sitzungen** serverseitig; im Cookie nur eine Zufalls-ID (256 Bit), in der Datenbank nur deren Hash. Cookie: `__Host-`-Präfix, `HttpOnly`, `Secure`, `SameSite=Strict`. Neue ID bei jeder Anmeldung (Schutz vor Session-Fixation). Leerlauf-Timeout 30 Minuten, absolute Laufzeit 10 Stunden. Abmelden löscht die Sitzung serverseitig. Passwortwechsel beendet alle anderen Sitzungen. Deaktivierte Benutzer verlieren sofort den Zugriff.
- **Step-up:** Rollen, Benutzer, Ticketsystem-Zugangsdaten und Updates verlangen eine Anmeldung, die höchstens 10 Minuten alt ist.

### Zugriffskontrolle (ASVS V4)

- Alle Prüfungen laufen zentral in `src/server/server.ts`, bevor ein Handler aufgerufen wird: Anmeldung, Sitzungszustand, CSRF, Herkunft, Admin-Netz, Recht, Step-up.
- Rechte gelten **global oder pro Ticketsystem**. Rollen-, Benutzer-, Update- und Einstellungsverwaltung wirken nur global – ein System-Admin kann sich keine globalen Rechte geben.
- Die letzte Super-Admin-Zuordnung kann nicht entfernt werden; Admin-Rollen können nicht „allen“ zugeordnet werden.
- **Keine Rechteausweitung:** Niemand kann Rechte vergeben, entziehen oder übernehmen, die er nicht selbst hat. Wer „Rollen verwalten“ darf, kann sich deshalb nicht selbst zum Super-Admin machen und keine Rolle mit mehr Rechten bauen. Wer „Benutzer verwalten“ darf, kann kein Konto mit höheren Rechten anlegen und weder Passwort noch 2FA eines höher berechtigten Kontos zurücksetzen (sonst könnte er sich damit anmelden). Ein Konto mit Rolle anlegen erfordert zusätzlich „Rollen verwalten“.
- Ein automatischer Test ruft **jede** Route ohne Anmeldung (erwartet 401) und jede Admin-Route als normaler Benutzer (erwartet 403/404) auf. Neue Routen werden so automatisch mitgeprüft.
- Tickets: Das Portal fragt Zammad im Namen des angemeldeten Kunden; Zammad und das Portal prüfen die Kunden-ID. Fremde oder nicht existierende Tickets liefern dieselbe Antwort (404), damit sich Ticket-IDs nicht erraten lassen.
- **Vier-Augen-Prinzip** (optional pro System) für Formulare und Branding.
- Optional: Admin-Bereich nur aus bestimmten Netzen (`ADMIN_ALLOWED_CIDRS`).

### Eingaben und Ausgaben (ASVS V5)

- Jede Formulareingabe wird serverseitig gegen das veröffentlichte Formular geprüft: nur bekannte, sichtbare Felder, erlaubte Werte, Längen, Typen. Prüfmuster laufen nur über begrenzte Eingabelängen.
- **SQL:** ausschließlich vorbereitete Statements mit Parametern.
- **XSS:** Das Frontend setzt Texte nur als Textknoten (`innerHTML` wird nirgends verwendet); CSP `script-src 'self'` ohne `unsafe-inline`. Ins Ticket geschriebene Eingaben werden HTML-escaped. HTML aus Zammad wird serverseitig in reinen Text umgewandelt.
- **Vorlagen** kennen nur Platzhalter wie `{{feld}}` – keine Logik, kein Code, kein Zugriff auf Objekt-Interna.
- **JSON** ist der einzige angenommene Inhaltstyp (415 sonst); `__proto__`/`constructor` werden beim Parsen verworfen; Größenlimits je Route.
- **Offene Weiterleitungen** nach dem Login sind ausgeschlossen (nur relative Pfade).
- **SSRF:** Zammad-Adressen auf Loopback, Link-Local und Cloud-Metadaten (169.254.169.254) werden abgelehnt; Weiterleitungen werden nicht verfolgt.
- **CSV-Export** schützt vor Formel-Injection.

### Dateien (ASVS V12)

- Dateityp wird am **Inhalt** erkannt (Magic Bytes) und muss zur Endung passen; erlaubt sind PDF, Bilder, Office-Dokumente, Text/CSV. Programme, Skripte, HTML und SVG als Anhang werden abgelehnt.
- **Virenscan** mit ClamAV; ist der Scanner nicht erreichbar, werden Uploads abgelehnt (fail closed).
- Dateinamen werden bereinigt (Pfade, Steuerzeichen, Unicode-Richtungszeichen).
- Bis zur Zustellung liegen Dateien **verschlüsselt** auf der Platte und werden danach sofort gelöscht.
- Anhänge aus Zammad werden immer als Download mit `application/octet-stream` und Sandbox-CSP ausgeliefert.
- Logos: SVGs mit Skripten, Event-Handlern, externen Verweisen oder DTDs werden abgelehnt und zusätzlich mit `sandbox`-CSP ausgeliefert.

### Kryptografie und gespeicherte Daten (ASVS V6, V8)

- Hauptschlüssel `SECRET_KEY` (256 Bit) als Docker Secret; je Zweck ein eigener Schlüssel per HKDF.
- **AES-256-GCM** für Zammad-API-Tokens, TOTP-Geheimnisse, Anfrageinhalte, Uploads und den OIDC-Zwischenspeicher.
- Ein Test liest die Datenbankdatei direkt und prüft, dass Token und Inhalte nicht im Klartext vorkommen.
- **Datensparsamkeit:** Anfrageinhalte und Anhänge werden nach der Zustellung gelöscht, Metadaten nach einem Jahr.

### Protokollierung (ASVS V7)

- **Audit-Log** für alle Anmeldungen (auch fehlgeschlagene), Sperren, Step-ups und Änderungen mit Vorher/Nachher; Geheimnisse werden nie protokolliert.
- Nur anhängbar (Datenbank-Trigger) und mit **Hash-Kette**: jede nachträgliche Änderung in der Datei fällt bei „Integrität prüfen“ auf.
- Technische Logs als JSON, ohne Passwörter, Tokens oder Cookies (werden automatisch geschwärzt).

### HTTP und Transport (ASVS V9, V14)

- Nur **TLS 1.2 und 1.3**, nur AEAD-Chiffren mit Forward Secrecy (geprüft mit testssl.sh).
- Header: `Content-Security-Policy` (`default-src 'none'`), `Strict-Transport-Security` (2 Jahre), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy`, `Cross-Origin-Opener/Resource/Embedder-Policy`. Kein `Server`-Header.
- **Host-Prüfung** gegen DNS-Rebinding (fremder Host → 421); Caddy stellt für fremde Hostnamen gar kein Zertifikat aus.
- `X-Forwarded-For` wird nur vom festen Proxy-Container akzeptiert.
- Ratenbegrenzung je IP für alle API-Aufrufe, ändernde Aufrufe und Anmeldungen.
- API-Antworten werden weder zwischengespeichert (`no-store`) noch komprimiert (BREACH-Vorbeugung).

### Container und Betrieb

- App und Worker: **distroless**-Image ohne Shell und Paketmanager, Benutzer 65532, `read_only`, `cap_drop: ALL`, `no-new-privileges`, Speicher- und Prozesslimits.
- Netze getrennt: nur Caddy ist von außen erreichbar; ClamAV und die interne Kommunikation hängen in einem Netz ohne Internetzugang.
- Docker-Zugriff hat nur der Updater, und nur über einen **Socket-Proxy** ohne `exec`, Secrets oder Swarm.
- Updates nur aus **signierten Git-Tags** (bzw. mit cosign signierten Images), mit Backup und automatischem Rollback.

## Lokale Anmeldung im Detail

Lokale Konten sind für die Erstinstallation und als Notfallzugang gedacht. Der normale Weg ist Microsoft Entra ID.

**Ablauf.** Jede Stufe ist ein eigener Sitzungszustand auf dem Server. Solange eine Sitzung nicht `active` ist, beantwortet das Portal nur die Anmelde-Schnittstellen. Jede andere Route (Portal, Tickets, Verwaltung) antwortet mit 403. Das prüft die zentrale Pipeline in `src/server/server.ts`, nicht die Oberfläche.

```
Benutzername + Passwort
   │  falsch → Fehlversuch zählen (5 → Sperre)
   ▼
mfa_pending ──(nur wenn 2FA eingerichtet)── Code aus der App
   │                                          falsch → Fehlversuch zählen; bei Sperre endet die halbe Sitzung
   ▼                                          richtig → neue Sitzungs-ID, Zähler zurück
password_change ──(erzeugtes Passwort)── eigenes Passwort festlegen
   ▼
totp_setup ──(Admin ohne 2FA)── Authenticator einrichten
   ▼
active
```

**Was bei jeder Anfrage geprüft wird** (nicht nur beim Login):

| Prüfung | Folge |
| --- | --- |
| Sitzung existiert, ist nicht abgelaufen (Leerlauf, absolute Laufzeit) | sonst 401 |
| Konto existiert und ist nicht deaktiviert | sonst wird die Sitzung gelöscht |
| Lokale Anmeldung ist eingeschaltet (`LOCAL_LOGIN_ENABLED`) | sonst werden auch **bestehende** lokale Sitzungen gelöscht |
| Konto hat 2FA, aber die Sitzung keinen zweiten Faktor | Sitzung wird gelöscht (darf nie vorkommen, wird trotzdem nicht vertraut) |
| Lokales Konto hat Admin-Rechte, aber keine 2FA | Sitzung fällt auf „2FA einrichten“ zurück, z. B. wenn jemand während der Sitzung Admin-Rechte bekommt |
| Sitzungszustand ist `active` | sonst 403 auf allen Routen außer der Anmeldung |
| CSRF-Token und Herkunft bei ändernden Anfragen | sonst 403 |
| Recht für die Route (global oder pro Ticketsystem) | sonst 403 |
| Kritische Aktion: Anmeldung höchstens 10 Minuten alt | sonst Bestätigung mit Passwort (+ Code) |

**Angriffswege und warum sie nicht funktionieren** (alle automatisch getestet in `test/security-local-login.test.ts` und `test/security-auth.test.ts`):

| Angriff | Schutz |
| --- | --- |
| Passwort raten | Ratenbegrenzung je IP; Kontosperre nach 5 Fehlversuchen, jede weitere Sperre doppelt so lang (max. 24 h); während der Sperre wird das Passwort gar nicht erst geprüft |
| 2FA-Code raten (Passwort bekannt) | falsche Codes zählen zur selben Sperre; erneutes Anmelden mit richtigem Passwort setzt den Zähler **nicht** zurück; bei Sperre endet die halbe Sitzung |
| Code abfangen und wiederverwenden | jeder Code gilt nur einmal (letzter Zeitschritt wird gespeichert) |
| Herausfinden, welche Benutzernamen es gibt | gleiche Meldung und gleiche Laufzeit für unbekannte Namen, falsche Passwörter und gesperrte Konten |
| Halbe Anmeldung (nur Passwort) für API-Aufrufe nutzen | Zustand `mfa_pending` öffnet keine einzige Portal- oder Admin-Route |
| Erzeugtes Erstpasswort dauerhaft nutzen | Zustand `password_change` öffnet keine Route außer dem Passwortwechsel |
| Session-Fixation | bei Login und nach dem zweiten Faktor wird immer eine neue Sitzungs-ID erzeugt |
| Gestohlenes Sitzungscookie | `HttpOnly`, `Secure`, `SameSite=Strict`, `__Host-`; Leerlauf 30 min; Abmelden löscht serverseitig; kritische Aktionen verlangen eine frische Bestätigung, deren Fehlversuche ebenfalls zählen und nach 5 Versuchen die Sitzung beenden |
| 2FA-Pflicht für Admins umgehen, indem man sich vor der Rechtevergabe anmeldet | Pflicht wird bei jeder Anfrage geprüft |
| Lokale Anmeldung abschalten, aber offene Sitzungen bleiben | offene lokale Sitzungen enden sofort |
| Mit „Benutzer verwalten“ ein Super-Admin-Konto übernehmen (Passwort/2FA zurücksetzen) | nur bei Konten mit höchstens den eigenen Rechten |
| Mit „Rollen verwalten“ sich selbst hochstufen | nur Rollen bis zu den eigenen Rechten vergeben, ändern, entziehen |
| Lokales Konto mit der E-Mail-Adresse einer Kollegin, um ihre Tickets zu sehen | E-Mail-Adressen sind eindeutig; ein lokales Konto mit der Adresse eines Microsoft-Kontos bekommt keine Tickets und kann nichts senden |
| Login-CSRF (Opfer wird unbemerkt in ein fremdes Konto angemeldet) | Herkunftsprüfung, nur JSON |

**Was bewusst so bleibt:**

- Wer ein **erzeugtes Erstpasswort** abfängt, bevor die Person es benutzt, kann das Konto einrichten (inklusive 2FA). Deshalb das Passwort nur direkt und persönlich weitergeben und die erste Anmeldung zeitnah durchführen lassen. Im Audit-Log steht, wann das Passwort geändert und die 2FA eingerichtet wurde.
- Ein Angreifer kann ein Konto **absichtlich sperren**, indem er falsche Passwörter eingibt. Bestehende Sitzungen bleiben davon unberührt. Super-Admins können Konten in der Verwaltung oder per `cli user:unlock` entsperren. Notfallkonten sollten keinen erratbaren Benutzernamen wie `admin` haben.
- Legt jemand mit Benutzerverwaltungs-Rechten ein lokales Konto mit der E-Mail-Adresse einer Person an, **die sich noch nie per Microsoft angemeldet hat**, kann dieses Konto bis zu deren erster Anmeldung ihre Zammad-Tickets sehen. Das steht im Audit-Log. Abhilfe: Benutzerverwaltung nur an vertrauenswürdige Personen geben und lokale Konten nach der Einrichtung von Entra ID abschalten.
- Der Server kann nicht prüfen, ob ein Passwort in Datenlecks vorkommt (keine Internetverbindung nach außen gewünscht). Die Regeln verlangen deshalb lange Passwörter bzw. Passphrasen.

**Einstellbar:** Sperre (Anzahl, Dauer, Steigerung), 2FA-Pflicht für Admins bzw. alle lokalen Konten, Mindestlänge, Sitzungszeiten, Step-up-Fenster und Ratenbegrenzung stehen in `deploy/.env` (siehe [Betrieb](BETRIEB.md#einstellungen-ändern-deployenv)). Alle Werte haben Untergrenzen; außerhalb davon startet das Portal nicht.

**Empfehlung für den Betrieb:** Nach der Einrichtung von Entra ID `LOCAL_LOGIN_ENABLED=false` setzen und nur ein Notfallkonto mit 2FA aufbewahren. Für den Notfall wird die lokale Anmeldung kurz eingeschaltet.

## Restrisiken und Empfehlungen

| Thema | Einschätzung | Empfehlung |
| --- | --- | --- |
| Updater mit Docker-Rechten | Wer den Updater übernimmt, kontrolliert praktisch die VM. Er hat keinen offenen Port und nimmt nur Aufträge für vorhandene, signierte Tags an. | Profil `updater` nur aktivieren, wenn Updates per Klick gewünscht sind; sonst manuell aktualisieren (docs/UPDATES.md) |
| Super-Admins | haben bewusst alle Rechte | wenige Personen, Entra-Gruppe mit PIM/Zugriffsüberprüfung |
| Formular-Prüfmuster | Admins können reguläre Ausdrücke hinterlegen; Eingabelängen sind begrenzt | Prüfmuster nur durch vertrauenswürdige Admins (ist durch Rechte gegeben) |
| Hauptschlüssel | wer `secret_key` und die Datenbank hat, kann Tokens entschlüsseln | Schlüssel getrennt vom Backup im Tresor aufbewahren |
| Zammad-API-Token | hat `admin.user` (nötig für `X-On-Behalf-Of`) | eigener API-Benutzer nur mit den nötigen Rechten und Gruppen, Token regelmäßig erneuern |
| `node:sqlite` | in Node 24 noch als „experimentell“ markiert, aber stabil im Einsatz | bei Node-Updates Testsuite laufen lassen (passiert im CI) |
| Interne CA von Caddy | Clients müssen dem Stammzertifikat vertrauen | Firmen-CA verwenden |

## Sicherheitsprobleme melden

Siehe [SECURITY.md](../SECURITY.md).
