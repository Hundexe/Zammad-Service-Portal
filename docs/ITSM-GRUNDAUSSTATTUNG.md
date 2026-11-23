# ITSM-Grundausstattung für Zammad

Für einen schnellen Start legt das Portal in Zammad eine Grundkonfiguration nach bewährter ITSM-Praxis (angelehnt an ITIL) an: Ticketart, Priorität aus Auswirkung und Dringlichkeit, Status, SLAs mit Arbeitszeiten, automatische Nachrichten, automatisches Schließen, Eskalation und Übersichten.

Die Grundausstattung ist unabhängig von der Zammad-Zuordnung des Portals (siehe [ZAMMAD.md](ZAMMAD.md)) und für frische oder schlanke Zammad-Installationen gedacht. Wer schon eine eigene Struktur hat, nimmt nur einzelne Teile.

**Verwaltung → Ticketsysteme → ITSM-Grundausstattung** (Recht „Ticketsystem verwalten“):

1. Teile auswählen, Arbeitszeiten, SLA-Zeiten, Fristen und die Adresse für Eskalationsstufe 2 einstellen.
2. **Vorschau** zeigt jedes Element mit Stand: *wird angelegt*, *vorhanden* (gleicher Name) oder *übersprungen* (Ähnliches vorhanden oder Voraussetzung fehlt).
3. **In Zammad anlegen** (mit Bestätigung der Anmeldung).

Grundsätze:

- Es wird **nichts überschrieben oder gelöscht**. Ein Element mit gleichem Namen bleibt, wie es ist. Ein zweiter Lauf legt nichts doppelt an.
- **Überschneidungen:** Gibt es schon Felder mit gleicher Bedeutung (z. B. „Auswirkung“ oder „Ticketart“), legt das Portal keine zweiten an. Die Prioritätsmatrix wird dann übersprungen; für die Übersicht „Offene Störungen“ nutzt es die vorhandene Ticketart.
- Alle Namen sind neutral; Trigger und Automatisierungen beginnen mit „ITSM – “, Felder mit `itsm_`.
- Alles lässt sich danach in Zammad anpassen oder abschalten.

Auf der Kommandozeile (mit Standardwerten): `service-portal-cli zammad:baseline` zeigt die Vorschau, `--apply` legt an.

Der API-Benutzer braucht dafür die Admin-Rolle in Zammad ([Rechte](ZAMMAD.md#8-rechte-des-api-benutzers)).

## Teile im Einzelnen

### Ticketart

Auswahlfeld **Ticketart** (`itsm_ticketart`): Störung, Serviceanfrage, Änderung (Change), Problem, Frage. Grundlage für Übersichten, Berichte und SLAs je Art. Tipp: In Formularen des Portals als festen Wert setzen (Formular → Ticket → Zammad-Objekt freigeben und vorbelegen).

### Priorität aus Auswirkung und Dringlichkeit

Zwei Felder und vier Prioritäten:

- **Auswirkung** (`itsm_auswirkung`): eine Person, eine Gruppe/Abteilung, ganze Organisation
- **Dringlichkeit** (`itsm_dringlichkeit`): hoch (Arbeit nicht möglich), mittel (eingeschränkt), gering (kann warten)
- Prioritäten **P1 Kritisch, P2 Hoch, P3 Mittel, P4 Niedrig**

Neun Trigger („ITSM – Priorität …“) setzen die Priorität nach dieser Matrix, sobald beide Felder gesetzt sind oder sich ändern:

| Auswirkung ↓ / Dringlichkeit → | hoch | mittel | gering |
| --- | --- | --- | --- |
| Ganze Organisation | P1 | P2 | P3 |
| Gruppe / Abteilung | P2 | P3 | P4 |
| Eine Person | P3 | P4 | P4 |

Wer die Priorität von Hand ändern will, ändert Auswirkung oder Dringlichkeit – sonst setzt der Trigger sie bei der nächsten Änderung dieser Felder zurück.

### Status

| Status | Typ | SLA |
| --- | --- | --- |
| In Bearbeitung | offen | läuft |
| Warten auf Rückmeldung | offen | angehalten |
| Warten auf Dritte | offen | angehalten |
| Gelöst | geschlossen | Lösungszeit erfüllt |

„Gelöst“ ist für den Kunden das Ende; ohne Antwort wird es nach einigen Tagen „geschlossen“ (siehe unten). Antwortet der Kunde, öffnet ein Trigger das Ticket wieder.

### SLAs mit Arbeitszeiten

Ein Kalender (Standard „IT-Servicezeiten“, Mo–Fr 08:00–17:00, Europe/Berlin) und je Priorität eine SLA. Standardzeiten in Arbeitszeit:

| Priorität | Reaktion | Lösung |
| --- | --- | --- |
| P1 Kritisch | 30 Minuten | 4 Stunden |
| P2 Hoch | 1 Stunde | 8 Stunden |
| P3 Mittel | 4 Stunden | 24 Stunden |
| P4 Niedrig | 8 Stunden | 40 Stunden |

Feiertage danach im Kalender in Zammad pflegen (Einstellungen → Kalender). Die Status „Warten auf …“ halten die SLA an.

### Automatische Nachrichten

| Trigger | Wann | An |
| --- | --- | --- |
| ITSM – Eingangsbestätigung | neues Ticket von einem Kunden (E-Mail, Telefon, Web/Portal) | Kunde |
| ITSM – Antwort der IT per E-Mail | öffentliche Notiz eines Agenten (z. B. aus dem Portal-Verlauf sichtbar) | Kunde, mit dem Text der Antwort |
| ITSM – Mitteilung bei „Gelöst“ | Status wechselt auf „Gelöst“ | Kunde – mit dem Hinweis, dass eine Antwort das Ticket wieder öffnet |
| ITSM – Antwort des Kunden öffnet wieder | Kunde antwortet auf „Warten …“ oder „Gelöst“ | Status „In Bearbeitung“ |

Die Texte sind schlicht gehalten und enthalten auf Wunsch einen Link ins Portal. Antworten der IT per E-Mail-Artikel verschickt Zammad ohnehin – der zweite Trigger ist für öffentliche Notizen gedacht. Wer das nicht möchte, schaltet ihn in Zammad ab.

### Automatisch schließen

Automatisierungen (stündlich):

| Automatisierung | Bedingung | Wirkung |
| --- | --- | --- |
| ITSM – Gelöst nach Frist schließen | „Gelöst“ seit 5 Tagen unverändert | geschlossen |
| ITSM – Erinnerung bei Warten auf Rückmeldung | „Warten auf Rückmeldung“, letzte Antwort der IT vor 3 Tagen, noch nicht erinnert | E-Mail an den Kunden, Tag `erinnert` |
| ITSM – Ohne Rückmeldung schließen | „Warten auf Rückmeldung“, letzte Antwort der IT vor 10 Tagen | E-Mail an den Kunden, geschlossen |

Antwortet der Kunde, entfernt der Trigger „Antwort des Kunden öffnet wieder“ den Tag `erinnert`.

### Eskalation

| Regel | Wann | Wirkung |
| --- | --- | --- |
| ITSM – Eskalation Stufe 1 (Trigger, zeitgesteuert) | eine SLA-Zeit ist abgelaufen | Tag `eskaliert`, E-Mail an Besitzer und Agenten der Gruppe |
| ITSM – Eskalation Stufe 2 (Automatisierung) | seit 4 Stunden eskaliert | E-Mail an die eingestellte Adresse (z. B. Teamleitung), Tag `eskaliert-stufe-2` |
| ITSM – Eskalation zurücksetzen | öffentliche Antwort eines Agenten | beide Tags entfernt |

Die Adresse für Stufe 2 muss ein Benutzer in Zammad sein. Ohne Adresse entfällt Stufe 2.

### Übersichten

Für die Rolle Agent: **Neu und in Bearbeitung**, **Meine offenen Tickets**, **Warten**, **Gelöst**, **Eskaliert**, **Offene Störungen** (Ticketart = Störung) und – wenn die Freigaben des Portals eingerichtet sind – **Wartet auf Freigabe**.

## Zusammenspiel mit dem Portal

- Anfragen aus dem Portal sind Kunden-Tickets: Eingangsbestätigung, Antworten und Schließen laufen wie bei E-Mail-Tickets.
- Anfragen mit Freigabe warten im Status „wartet auf Freigabe“ – nicht in „Neu und in Bearbeitung“ und ohne SLA. Nach der Freigabe stehen sie auf „new“ und laufen in die SLA.
- Für Störungen aus dem Portal lässt sich in der [Zammad-Zuordnung](ZAMMAD.md#2-zammad-zuordnung-an-die-eigene-struktur-anpassen) `itsm_ticketart=stoerung` als zusätzlicher Wert eintragen – dann erscheinen sie in „Offene Störungen“ und bekommen die SLA ihrer Priorität.
