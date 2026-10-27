# Bedienung

- [Für Mitarbeitende](#für-mitarbeitende)
- [Für die Verwaltung](#für-die-verwaltung)

---

## Für Mitarbeitende

### Anmelden

Portal öffnen und **Mit Microsoft anmelden** wählen. Es gilt dasselbe Konto wie für Outlook und Teams. Ein eigenes Passwort für das Portal gibt es nicht.

![Anmeldung](screenshots/01-anmeldung.png)

### Anfrage stellen

1. In der großen Farbfläche unter **Anfrage geht an** das Ticketsystem wählen. Farbe und Logo zeigen, wohin die Anfrage geht. Wer nur ein Ticketsystem nutzen darf, sieht keine Auswahl.
2. Formular wählen, z. B. **Störung melden** oder **Hardware anfordern**.

   ![Startseite](screenshots/02-portal-start.png)

   Beim zweiten Ticketsystem wechseln Farben und Formulare:

   ![Zweites Ticketsystem](screenshots/03-portal-start-zweites-system.png)

3. Formular ausfüllen. Pflichtfelder sind mit * markiert. Manche Felder erscheinen erst, wenn sie gebraucht werden (z. B. „Welches Programm?“ nur bei „Programm“).

   ![Formular](screenshots/04-formular-ausgefuellt.png)

   Fehlt etwas, markiert das Portal die Felder direkt:

   ![Prüfung](screenshots/05-formular-pruefung.png)

4. **Anfrage senden.** Die Eingangsbestätigung mit Ticketnummer kommt per E-Mail von Zammad.

   ![Gesendet](screenshots/06-anfrage-gesendet.png)

**Dateien:** Screenshots, PDFs, Office-Dokumente oder Textdateien lassen sich anhängen (je Formular festgelegt, meist bis 10 MB). Jede Datei wird auf Viren geprüft. Programme, Skripte und HTML-Dateien werden abgelehnt.

### Meine Tickets

Unter **Meine Tickets** stehen alle eigenen Tickets, sortiert nach letzter Änderung, mit Reitern wie „Offene Tickets“ und „Erledigt“. Was noch nicht an Zammad übermittelt wurde, steht oben unter „Noch nicht übermittelt“.

![Meine Tickets](screenshots/07-meine-tickets.png)

Ein Klick öffnet den Verlauf mit allen Antworten der IT. Interne Notizen der IT sind nicht sichtbar. Unten lässt sich antworten, auch mit Anhang. Eine Antwort auf ein erledigtes Ticket öffnet es in der Regel wieder.

![Ticketverlauf](screenshots/08-ticket-verlauf.png)

### Auf dem Handy

Das Portal passt sich an kleine Bildschirme an.

<img src="screenshots/09-mobil-start.png" width="300" alt="Startseite auf dem Handy"> <img src="screenshots/09b-mobil-formular.png" width="300" alt="Formular auf dem Handy">

### Helles und dunkles Design

Das Mond-Symbol oben rechts schaltet auf das dunkle Design um, die Sonne zurück auf hell. Ohne eigene Wahl folgt das Portal der Einstellung von Windows, macOS oder dem Handy. Die Wahl wird nur im eigenen Browser gespeichert.

<img src="screenshots/25-dunkel-start.png" width="600" alt="Startseite im dunklen Design"> <img src="screenshots/26-dunkel-verwaltung.png" width="600" alt="Verwaltung im dunklen Design">

### Konto

Unter dem Namen oben rechts: **Meine Anfragen** (alles, was über das Portal gesendet wurde), **Konto und Sicherheit** und **Abmelden**.

![Konto](screenshots/22-konto.png)

---

## Für die Verwaltung

Die Verwaltung erreichen alle mit einer Admin-Rolle über das Menü oben rechts → **Verwaltung**. Links steht oben das Ticketsystem, das gerade bearbeitet wird, darunter die globalen Bereiche.

### Übersicht

Zeigt offene Aufgaben (z. B. Sicherheitshinweise zur Konfiguration), Zahlen zur Zustellung und Versionen, die auf Freigabe warten.

![Übersicht](screenshots/10-admin-uebersicht.png)

### Ticketsysteme und Verbindung

**Alle Ticketsysteme → Ticketsystem hinzufügen** verbindet eine Zammad-Instanz. Auf der Seite **Verbindung** des Systems stehen:

| Einstellung | Bedeutung |
| --- | --- |
| Zammad-Adresse, API-Token | Zugang; das Token wird verschlüsselt gespeichert und nie wieder angezeigt |
| Tickets anlegen | „Im Namen des Kunden“ (empfohlen): Zammad prüft selbst, welche Tickets ein Kunde sehen darf |
| Standard-Gruppe | Zammad-Gruppe, wenn das Formular keine vorgibt |
| Tag für Portal-Tickets | wird an jedes Ticket gehängt, z. B. für den Trigger der Eingangsbestätigung |
| Status | Aktiv / Wartung (Anfragen werden gesammelt und später zugestellt) / Deaktiviert |
| Sichtbar für Entra-Gruppen | leer = für alle; sonst nur für Mitglieder dieser Gruppen |
| Erlaubte Zammad-Gruppen | nur in diese Gruppen legt das Portal Tickets; Formulare mit anderen Gruppen lassen sich nicht speichern (leer = keine Einschränkung, die Übersicht warnt dann) |
| Namen der Bearbeiter ausblenden | Antworten erscheinen im Portal mit dem Namen des Ticketsystems statt mit dem Namen der Person; E-Mail-Adressen werden nie angezeigt |
| Vier-Augen-Prinzip | Formulare und Branding gehen erst nach Freigabe durch eine zweite Person live |

![Verbindung](screenshots/11-admin-verbindung.png)

![Erlaubte Zammad-Gruppen](screenshots/11b-admin-erlaubte-gruppen.png)

### Zammad-Objekte freigeben

Hier stehen die Ticket-Attribute aus dem Zammad-Objekt-Manager. Ein Häkchen gibt das Attribut für Formulare frei. Bei Auswahlfeldern lässt sich festlegen, welche Werte die Mitarbeitenden wählen dürfen – im Beispiel vom `sec_status` nur die Hardware-Werte. „Alle Werte freigeben“ übernimmt auch Werte, die später in Zammad hinzukommen.

![Zammad-Objekte](screenshots/12-admin-zammad-objekte.png)

Nicht unterstützte Typen (z. B. Benutzerauswahl) sind ausgegraut. Fehlt die Liste ganz, braucht der API-Benutzer in Zammad das Recht `admin.object`.

### Formulare

**Formulare** listet alle Formulare mit Status. **Kopieren …** übernimmt ein Formular als Entwurf in ein anderes Ticketsystem.

![Formulare](screenshots/13-admin-formulare.png)

Der Editor hat vier Reiter:

**Felder** – links die Felder (per Ziehen oder mit den Pfeilen sortieren), in der Mitte die Eigenschaften des gewählten Feldes, rechts die Live-Vorschau.

![Formular-Editor](screenshots/14-admin-formular-editor.png)

| Eigenschaft | Zweck |
| --- | --- |
| Feldtyp | Text, Mehrzeiliger Text, E-Mail, Zahl, Datum, Kästchen, Auswahl, Mehrfachauswahl, Datei, Hinweistext oder ein freigegebenes **Zammad-Objekt** |
| Feld-ID | Name für Vorlagen, z. B. `{{betreff}}` |
| Pflichtfeld, Platzhalter, Standardwert | Standardwert auch aus dem Profil (Name, E-Mail, Abteilung) |
| Prüfmuster | regulärer Ausdruck, z. B. `\d{4}` für Kostenstellen |
| Nur anzeigen, wenn … | Feld erscheint abhängig von einem anderen Feld |
| Nur für bestimmte Gruppen | Feld nur für Mitglieder bestimmter Entra-Gruppen |
| Übernahme ins Ticket | nur Tickettext, als Tag, bestimmt Gruppe oder Priorität, in ein Zammad-Feld schreiben, oder gar nicht |

**Ticket** – wie das Ticket entsteht: Gruppe, Priorität, zusätzliche Tags, Titel- und Textvorlage, Text nach dem Absenden. `{{alle_felder}}` fügt eine Tabelle mit allen ausgefüllten Feldern ein. Eingaben werden immer sicher maskiert, Vorlagen können keinen Code ausführen.

![Ticket-Einstellungen](screenshots/15-admin-formular-ticket.png)

**Allgemein** – Name, Kategorie (gruppiert die Formulare im Portal), Beschreibung, Sichtbarkeit.

**Versionen** – jede Veröffentlichung ist eine Version. Ältere Versionen lassen sich als neuer Entwurf wiederherstellen. Mit Vier-Augen-Prinzip steht hier **Freigeben/Ablehnen** für die zweite Person.

Ablauf: **Entwurf speichern** → **Veröffentlichen** (bzw. **Zur Freigabe senden**). Bis zur Veröffentlichung sehen Mitarbeitende die alte Version.

### Vorlagen und Übersichten

**Vorlagen** sind Textbausteine für Titel, Tickettext und den Text nach dem Absenden. Im Formular-Editor lassen sie sich mit einem Klick übernehmen.

**Übersichten** sind die Reiter unter „Meine Tickets“: Name, welche Tickets (offen, erledigt, alle), Spalten und Sortierung.

### Stil, Farben und Logo

**Stil.** Jedes Ticketsystem kann sein eigenes Erscheinungsbild haben. Wer zwischen zwei Systemen wechselt, sieht sofort, wohin die Anfrage geht. Zur Wahl stehen:

| Stil | Wirkung |
| --- | --- |
| **Standard** | ruhig und hell, große Farbfläche, runde Formen |
| **Glas** | durchscheinende Flächen mit Unschärfe über einem weichen Farbverlauf aus den Farben des Systems – im Stil von Apple |
| **Fluent** | sachlich, kleine Rundungen, Akzentlinien unter Reitern und in der Seitenleiste, Segoe-Schrift unter Windows – im Stil von Microsoft |
| **Material** | getönte Flächen, kräftige Rundungen, runde Symbole, getönte Schaltflächen – im Stil von Google |
| **Kontrast** | schwarze Linien, hoher Kontrast, unterstrichene Links, deutliche Fokus-Rahmen – besonders gut lesbar |

Jeder Stil funktioniert im hellen und im dunklen Design. Die Vorschau im Auswahlfeld zeigt jeden Stil mit den aktuellen Farben.

**Farben.** Unter *Farben* gibt es zwei Möglichkeiten:

- **Farben des Stils:** Jeder Stil bringt eigene, aufeinander abgestimmte Farben mit, die die Kontrastregeln erfüllen. Man muss also nichts einstellen.
- **Eigene Farben:**
  - Ein Klick auf eine fertige Kombination übernimmt deren Farben, zur Wahl stehen Ozean, Wald, Abendrot, Beere, Graphit, Sonne, Minze und Lavendel.
  - Die vier Farben lassen sich auch einzeln wählen.
  - Beim Wechsel auf die Farben des Stils bleiben die eigenen gespeichert.

<img src="screenshots/30-stil-auswahl.png" width="900" alt="Auswahl des Stils mit Vorschau">

<img src="screenshots/31-stil-glas.png" width="440" alt="Stil Glas"> <img src="screenshots/32-stil-glas-dunkel.png" width="440" alt="Stil Glas, dunkel">
<img src="screenshots/33-stil-fluent.png" width="440" alt="Stil Fluent"> <img src="screenshots/34-stil-material.png" width="440" alt="Stil Material">
<img src="screenshots/35-stil-kontrast.png" width="440" alt="Stil Kontrast"> <img src="screenshots/02-portal-start.png" width="440" alt="Stil Standard">

**Weitere Angaben** pro Ticketsystem: Anzeigename, Farbe der großen Farbfläche (Startseite) und der Schrift darauf, Primärfarbe (Schaltflächen, Links, Symbole) und Akzentfarbe, Logo auf der Farbfläche (wird im dunklen Design auch in der Navigationsleiste verwendet; ist die Farbfläche hell, zum Beispiel bei Material, erscheint dort das Logo für helle Flächen), Logo für die helle Navigationsleiste, Favicon, Begrüßung, Fußzeile, Links zu Impressum und Datenschutz. Die Vorschau rechts zeigt das Ergebnis, die Kontrastprüfung warnt bei schlecht lesbaren Kombinationen (WCAG AA). Logos: PNG, JPEG, WebP oder SVG bis 1 MB; SVGs mit Skripten oder externen Verweisen werden abgelehnt.

![Farben und Logo](screenshots/16-admin-branding.png)

Die Anmeldeseite (vor der Wahl eines Ticketsystems) hat ein eigenes Erscheinungsbild unter **Anmeldeseite**, mit derselben Stil- und Farbauswahl. Die Verwaltung selbst bleibt im Standard-Stil, weil sie alle Ticketsysteme gemeinsam betreut.

### Rollen und Rechte

Rechte werden über **Rollen** vergeben, die einer **Entra-Gruppe**, einer **Person** oder **allen** zugeordnet werden – entweder für **alle Ticketsysteme** oder für **eines**.

![Rollen](screenshots/17-admin-rollen.png)

| Eingebaute Rolle | Rechte |
| --- | --- |
| Super-Admin | alles |
| Ziel-Admin | ein Ticketsystem komplett verwalten (Verbindung, Objekte, Formulare inkl. Freigabe, Vorlagen, Übersichten, Branding, Audit-Log) |
| Formular-Editor | Formulare und Vorlagen bearbeiten, nicht veröffentlichen |
| Branding-Editor | Farben, Logos, Texte |
| Objekt-Freigabe | Zammad-Objekte freigeben |
| Auditor | Audit-Log und Update-Status lesen |
| Benutzer | Portal nutzen (standardmäßig allen zugeordnet) |

Eigene Rollen lassen sich aus Einzelrechten zusammenstellen. Rollenverwaltung, Benutzerverwaltung, Updates und globale Einstellungen wirken nur bei einer Zuordnung für **alle** Ticketsysteme. Die letzte Super-Admin-Zuordnung kann nicht entfernt werden.

### Benutzer

Listet lokale Konten und alle Microsoft-Benutzer, die sich schon angemeldet haben. **Lokalen Benutzer anlegen** erzeugt ein Passwort mit 20 Zeichen, das genau einmal angezeigt wird und bei der ersten Anmeldung geändert werden muss.

![Benutzer angelegt](screenshots/18-admin-benutzer-angelegt.png)

**Neues Passwort** setzt ein neues generiertes Passwort (optional auch die Authenticator-App zurück) und beendet alle Sitzungen des Kontos. Gesperrte Konten (nach 5 Fehlversuchen für 15 Minuten) lassen sich hier entsperren.

### Bestätigung kritischer Aktionen

Für Rollen, Benutzer, Ticketsystem-Zugangsdaten und Updates verlangt das Portal eine frische Anmeldung, wenn die letzte länger als 10 Minuten zurückliegt: bei lokalen Konten Passwort + Code, bei Microsoft-Konten eine erneute Microsoft-Anmeldung.

![Bestätigung](screenshots/18a-admin-bestaetigung.png)

### Zustellung

Alle Anfragen auf dem Weg nach Zammad. Fehlgeschlagene Anfragen (z. B. weil eine Gruppe in Zammad umbenannt wurde) lassen sich nach der Korrektur **erneut senden**.

![Zustellung](screenshots/21-admin-zustellung.png)

### Audit-Log

Jede Anmeldung und jede Änderung mit Person, Zeit, IP und Vorher/Nachher. Einträge können nicht geändert oder gelöscht werden; **Integrität prüfen** erkennt Manipulationen direkt in der Datenbank. Export als CSV.

![Audit-Log](screenshots/19-admin-audit.png)

### Updates

Zeigt die installierte und die verfügbaren Versionen. **Auf x.y.z aktualisieren** startet das Update: Signatur prüfen, Datenbank sichern, neue Version bauen und starten. Startet sie nicht sauber, wird automatisch zurückgerollt. Details: [Updates](UPDATES.md).

![Updates](screenshots/20-admin-updates.png)
