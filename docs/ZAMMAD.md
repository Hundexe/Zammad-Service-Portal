# Zammad als einzige Datenquelle

Ab Version 2.0 liegt alles, was Mitarbeitende und IT im Portal sehen, im Ticketsystem. Das Portal ist die Oberfläche dafür und hält selbst nur noch, was es zum Arbeiten braucht (Konten, Formulare, Gestaltung, Services, Hinweise an der Glocke).

| Was | Wo in Zammad |
| --- | --- |
| Anfrage mit Freigabe durch Vorgesetzte | Ticket im Status **wartet auf Freigabe**, Felder „Portal: Freigabe“, „Freigabe durch“, „Freigabe bis“ |
| Entscheidung (freigegeben, abgelehnt, zurückgezogen, abgelaufen) | Feld „Portal: Freigabe“, Status, Tag, öffentliche Notiz, E-Mail an die anfragende Person |
| Störung | Ticket mit **Portal: Art = Störung**; Auswirkung, Phase, Services, Standorte, Beginn und Ende als Felder; Updates als öffentliche Notizen |
| „Ich bin auch betroffen“ | eigenes Ticket der Person, verknüpft als Kind der Störung, Feld „Portal: betroffen von Störung“ |
| Geplante Wartung | Ticket mit **Portal: Art = Wartung**, Beginn und Ende als Felder |
| Bekanntes Problem | Ticket mit **Portal: Art = Problem**, Status, Workaround und Ursache als Felder; betroffene Tickets verknüpft |

Inhaltsverzeichnis

1. [Was das Portal in Zammad braucht](#1-was-das-portal-in-zammad-braucht)
2. [Zammad-Zuordnung: an die eigene Struktur anpassen](#2-zammad-zuordnung-an-die-eigene-struktur-anpassen)
3. [Abhängigkeiten: Felder nur zeigen, wo sie gebraucht werden](#3-abhängigkeiten-felder-nur-zeigen-wo-sie-gebraucht-werden)
4. [Freigaben im Ticket](#4-freigaben-im-ticket)
5. [Störungen, Wartungen und Probleme im Ticket](#5-störungen-wartungen-und-probleme-im-ticket)
6. [In Zammad arbeiten](#6-in-zammad-arbeiten)
7. [Umstieg von 1.x](#7-umstieg-von-1x)
8. [Rechte des API-Benutzers](#8-rechte-des-api-benutzers)

## 1. Was das Portal in Zammad braucht

Unter **Verwaltung → Ticketsysteme → Zammad-Zuordnung** prüft das Portal, ob Zammad zur Zuordnung passt, und zeigt, was fehlt. **In Zammad einrichten** legt es an:

- **Gruppen** für Störungen, Wartungen und Probleme (Standard: „Störungen“, „Wartungen“, „Probleme“) – nur für eingeschaltete Funktionen und nur, wenn keine vorhandene Gruppe zugeordnet ist
- den **Status „wartet auf Freigabe“** (Typ „offen“, ohne Eskalation)
- die **Felder** des Portals im Objekt-Manager, alle mit dem Präfix `portal_`, damit nichts mit vorhandenen Feldern kollidiert
- fehlende **Auswahlwerte**, z. B. neue Services oder Standorte
- die **Abhängigkeiten** (Core Workflows „Portal: …“, siehe Abschnitt 3)

Es wird nie etwas gelöscht oder umbenannt. Vorhandene Felder, auf die umgelenkt wurde, bekommen höchstens fehlende Auswahlwerte.

Das Portal prüft stündlich. Passt etwas nicht, steht ein Hinweis in der Übersicht der Verwaltung. Auf der Kommandozeile:

```bash
service-portal-cli zammad:setup              # prüfen
service-portal-cli zammad:setup --apply      # einrichten
```

Felder des Portals:

| Feld (Standardname) | Typ | Wofür |
| --- | --- | --- |
| Portal: Formular (`portal_formular`) | Text | aus welchem Formular das Ticket kam |
| Portal: Freigabe (`portal_freigabe`) | Auswahl | ausstehend, genehmigt, abgelehnt, zurückgezogen, abgelaufen, abgebrochen |
| Portal: Freigabe durch (`portal_freigabe_durch`) | Text | E-Mail-Adresse der freigebenden Person |
| Portal: Freigabe bis (`portal_freigabe_bis`) | Datum | Frist |
| Portal: entschieden am (`portal_freigabe_am`) | Datum/Zeit | Zeitpunkt der Entscheidung |
| Portal: Art (`portal_art`) | Auswahl | Störung, Wartung, Problem |
| Portal: im Portal anzeigen (`portal_anzeigen`) | Ja/Nein | nur dann sehen Mitarbeitende das Ticket auf der Status-Seite |
| Portal: Services (`portal_services`) | Mehrfachauswahl | betroffene Services (Werte pflegt das Portal) |
| Portal: Standorte (`portal_standorte`) | Mehrfachauswahl | betroffene Standorte |
| Portal: Auswirkung (`portal_auswirkung`) | Auswahl | eingeschränkt, Teilausfall, Ausfall |
| Portal: große Störung (`portal_grosse_stoerung`) | Ja/Nein | Banner auf allen Seiten |
| Portal: Phase der Störung (`portal_phase`) | Auswahl | wird untersucht, Ursache gefunden, behoben/wird beobachtet |
| Portal: Störung seit / behoben am | Datum/Zeit | Zeiten der Störung |
| Portal: betroffen von Störung (`portal_stoerung`) | Zahl | an Tickets von Betroffenen: ID der Störung |
| Portal: Wartung Beginn / Ende | Datum/Zeit | Wartungsfenster |
| Portal: Problem-Status (`portal_problem_status`) | Auswahl | neu, in Analyse, bekannter Fehler, gelöst, geschlossen |
| Portal: bekanntes Problem (`portal_problem`) | Zahl | an verknüpften Tickets: ID des Problems |
| Portal: Workaround, Ursache (intern) | Text | Workaround erscheint im Portal, die Ursache nicht |

## 2. Zammad-Zuordnung: an die eigene Struktur anpassen

Die Standardwerte funktionieren ohne Anpassung. Wer schon eine eingespielte Zammad-Struktur hat, stellt je Ticketsystem ein:

**Überschneidungen.** Vor dem Anlegen sucht das Portal nach vorhandenen Feldern mit gleicher Bedeutung und schlägt sie vor, z. B. ein vorhandenes Feld „Standort“ statt „Portal: Standorte“ oder bei Störungen zusätzlich „Ticketart = Störung“. **Übernehmen** trägt den Vorschlag in die Zuordnung ein. Felder mit festen Werten (z. B. Auswirkung) werden nur vorgeschlagen, wenn das vorhandene Feld alle Werte des Portals schon kennt – ein gleichnamiges Feld mit anderer Bedeutung bleibt unangetastet.

**Freigaben.**

| Einstellung | Standard | Hinweis |
| --- | --- | --- |
| Status, solange die Freigabe aussteht | wartet auf Freigabe | in SLA-Bedingungen nicht aufnehmen, dann läuft die SLA erst nach der Freigabe |
| Status nach der Freigabe | automatisch (Typ „neu“) | ab hier bearbeitet die Fachgruppe |
| Status nach Ablehnung, Rückzug, Ablauf | automatisch (Typ „geschlossen“) | |
| Tag nach der Freigabe | freigegeben | leer = kein Tag |
| Tags, solange die Freigabe aussteht | – | z. B. ein Tag, den eure Eskalation ausnimmt; nach der Entscheidung entfernt |
| E-Mail an die freigebende Person | an | Zammad schickt sie aus dem Ticket, mit Link ins Portal |
| E-Mail an die anfragende Person | an | nach der Entscheidung |

**Störungen, Wartungen, Probleme** – je Art:

| Einstellung | Beispiel |
| --- | --- |
| Gruppe | eine vorhandene Gruppe; leer = Standardgruppe des Ticketsystems |
| Zusätzliche Werte beim Anlegen | `ticketart=stoerung` – damit greifen vorhandene SLAs, Trigger und Übersichten |
| Tags | z. B. ein Tag, der Wartungen aus SLAs ausnimmt |
| Ausblenden | vorhandene Felder, die bei dieser Art keinen Sinn haben (siehe Abschnitt 3) |

Dazu: Tags an Tickets der Betroffenen, Tickets der Betroffenen beim Beheben schließen (Standard: an), Abhängigkeiten pflegen (Standard: an).

**Felder** – aufgebaut wie der Objekt-Manager in Zammad (Anzeige, Name, Typ, Verwendet für, Stand):

- **Anzeige** (immer): der Name, den Agenten in Zammad sehen. Leer = Standard („Portal: …“). Das Portal zieht geänderte Bezeichnungen bei „In Zammad einrichten“ nach – bei eigenen Feldern immer, bei umgelenkten nur, wenn hier ausdrücklich ein Name steht.
- **Name** (Ansicht „Erweitert“): Jedes Feld des Portals lässt sich auf ein vorhandenes Feld umlenken. Typ und Bedeutung sollten passen. Ist ein Mehrfachauswahl-Feld (Standorte, Services) auf eine Einfachauswahl umgelenkt, schreibt das Portal den ersten Wert.

**Bezeichnungen der Arten:** Störung, Wartung und Problem lassen sich umbenennen (z. B. „Ausfall“). Das ändert nur den angezeigten Wert im Feld „Art“, der gespeicherte Schlüssel bleibt – vorhandene Tickets passen weiter.

**Was in welcher Ansicht steht:**

| Einfach | Erweitert (zusätzlich) |
| --- | --- |
| Anzeige-Namen der Felder, Bezeichnungen der Arten, Gruppen und Tags je Art, Tags und E-Mails bei Freigaben, Betroffene schließen, Übersichten (an/aus, Namen, je Formular) | technische Namen und Umlenken auf vorhandene Felder, Status je Rolle (Abschnitt 2a), Status während der Freigabe, zusätzliche Werte beim Anlegen, Felder je Art ausblenden, Abhängigkeiten an/aus und ihre Vorsilbe, Übersichten insgesamt an/aus |

Die Zuordnung steht in der Exportdatei des Ticketsystems und wird beim Import mit übernommen.

### 2a. Status: nie über feste Namen

Viele Installationen benennen die Status um („1 Neu“, „2 In Arbeit“, „9 Erledigt“). Das Portal setzt deshalb jeden Status über seine **Rolle**:

| Rolle | wofür | automatisch |
| --- | --- | --- |
| Neue Tickets | Störung, Wartung, Problem und „Ich bin auch betroffen“ anlegen; nach der Freigabe | aktiver Status vom Typ *new*, bei mehreren der mit „Standard beim Anlegen“ |
| Wieder geöffnet / in Bearbeitung | Störung oder Problem wieder öffnen | Typ *open*, bei mehreren der mit „Standard bei Folgenachricht“; nie der Freigabe-Status |
| Geschlossen | beheben, schließen, absagen, „nicht mehr betroffen“, Ablehnung | Typ *closed* |

In der Ansicht „Erweitert“ lässt sich je Rolle ein bestimmter Status wählen. Gibt es den gewählten Namen in Zammad nicht (mehr), nimmt das Portal den automatischen und zeigt einen Hinweis. Gibt es zu einer Rolle gar keinen aktiven Status des Typs, meldet die Prüfung das als Problem.

„Erledigt“ im Portal (z. B. in „Meine Anfragen“) gilt für die Status aus „Zammad-Status, die als erledigt gelten“ (Verbindung, Erweitert) **und** für jeden Zammad-Status vom Typ geschlossen, zusammengeführt oder entfernt. Diese Liste setzt das Portal nie als Status.

### 2b. Übersichten in Zammad

Für Agenten legt das Portal eigene Übersichten an (Rolle Agent) und hält sie aktuell:

| Übersicht | zeigt |
| --- | --- |
| Wartet auf Freigabe | Anfragen, über die noch nicht entschieden ist |
| Störungen | offene Störungen |
| Wartungen | geplante und laufende Wartungen |
| Probleme | offene Probleme und bekannte Fehler |
| je Formular (frei wählbar) | alle offenen Tickets aus diesem Formular – auch die, die noch auf Freigabe warten, z. B. „Software-Anfragen“ |

„Offen“ heißt: jeder Status, der nicht vom Typ geschlossen, zusammengeführt oder entfernt ist. Namen und an/aus stehen in der Zammad-Zuordnung. Das Portal erkennt seine Übersichten am Verweis (`portal_…`) – umbenennen legt keine zweite an. Übersichten für Störungen usw. erscheinen nur, wenn die Funktion im Portal eingeschaltet ist.

## 3. Abhängigkeiten: Felder nur zeigen, wo sie gebraucht werden

Damit Agenten in Zammad nicht überall Portal-Felder sehen, legt das Portal Core Workflows an (**Einstellungen → System → Core Workflows**, Name „Portal: …“; die Vorsilbe ist einstellbar). Sie gelten beim Anlegen und Bearbeiten von Tickets:

| Abhängigkeit | Bedingung | Wirkung |
| --- | --- | --- |
| Portal: Felder ausblenden | immer | alle Portal-Felder ausblenden – außer „Portal: Art“, das bleibt als Schalter sichtbar |
| Portal: Formular | Formular ist gesetzt | Formular zeigen |
| Portal: Freigabe | Freigabe ist gesetzt | die vier Freigabefelder zeigen |
| Portal: Betroffen von Störung / Bekanntes Problem | Feld ist gesetzt | Feld zeigen |
| Portal: Störung | Portal: Art = Störung | Auswirkung, große Störung, Phase, Zeiten, Services, Standorte, im Portal anzeigen, bekanntes Problem zeigen; gewählte vorhandene Felder ausblenden |
| Portal: Wartung | Portal: Art = Wartung | Beginn, Ende, Services, Standorte, im Portal anzeigen zeigen; gewählte Felder ausblenden |
| Portal: Problem | Portal: Art = Problem | Problem-Status, Workaround, Ursache, Services, im Portal anzeigen zeigen; gewählte Felder ausblenden |

Status, Gruppe, Besitzer und Priorität blendet das Portal nie aus. **In Zammad einrichten** schreibt die Abhängigkeiten jedes Mal neu – eigene Änderungen daran gehen dabei verloren; eigene Regeln bitte als eigene Core Workflows mit anderem Namen anlegen. Das Portal erkennt seine Workflows an einer Kennung in der Notiz (`[portal:…]`), auch wenn sie in Zammad umbenannt wurden. „In Zammad einrichten“ lässt sich beliebig oft ausführen.

**Gesperrte Abhängigkeiten aus Version 2.0.0.** Zammad zeigt über die API nur Core Workflows, die als änderbar markiert sind. Version 2.0.0 hat ihre Workflows ohne diese Markierung angelegt – Zammad meldet dann beim erneuten Anlegen „Name has already been taken“, ändern lassen sie sich nicht. Das Portal merkt sich solche Namen, zählt sie als vorhanden und zeigt einen Hinweis. Einmalig auf dem Zammad-Server freigeben, danach pflegt das Portal sie wieder:

```bash
# Paket-Installation
zammad run rails r "CoreWorkflow.where(changeable: false).where('note LIKE ? OR name LIKE ?', '%Self-Service-Portal%', 'Portal: %').update_all(changeable: true)"
# Docker (Name des Rails-Containers anpassen)
docker compose exec zammad-railsserver rails r "CoreWorkflow.where(changeable: false).where('note LIKE ? OR name LIKE ?', '%Self-Service-Portal%', 'Portal: %').update_all(changeable: true)"
```

## 4. Freigaben im Ticket

```
Mitarbeiterin              Portal                          Zammad                        Vorgesetzter
     │ Formular mit Freigabe  │                                │                               │
     ├───────────────────────▶│ Ticket anlegen                 │                               │
     │                        ├───────────────────────────────▶│ Status „wartet auf Freigabe“  │
     │                        │                                │ Freigabe = ausstehend         │
     │                        │ E-Mail-Artikel an Vorgesetzten │──── E-Mail mit Link ─────────▶│
     │                        │                                │                               │
     │                        │◀──────────── Entscheidung im Portal (live gegen das Ticket geprüft)
     │                        ├───────────────────────────────▶│ Status „new“, Tag, Notiz      │
     │◀──── E-Mail und Glocke ┤                                │ (bzw. „closed“ bei Ablehnung) │
```

- Das Ticket entsteht **sofort**. Bis zur Entscheidung wartet es im eigenen Status; die Fachgruppe sieht es, bearbeitet es aber erst nach der Freigabe.
- Ob jemand freigeben darf, prüft das Portal bei jedem Aufruf **am Ticket**: eingetragene Adresse = eigenes Microsoft-Konto, nicht die anfragende Person, ggf. Mitglied der Gruppen aus dem Formular. Lokale Konten können nie freigeben.
- **Fristen:** Nach drei Tagen schickt Zammad einmal eine Erinnerung (Einstellung `APPROVAL_REMIND_DAYS`), nach 14 Tagen läuft die Freigabe ab (`APPROVAL_EXPIRE_DAYS`) – das Ticket wird geschlossen.
- **Die IT schließt ein wartendes Ticket in Zammad:** Die Freigabe gilt als abgebrochen, beide Seiten werden benachrichtigt.
- Den Inhalt der Anfrage zeigt das Portal der freigebenden Person aus der ersten Nachricht des Tickets, solange die Freigabe aussteht – danach nur noch Zammad.

## 5. Störungen, Wartungen und Probleme im Ticket

- **Anlegen im Portal** (Verwaltung → Status und Störungen) oder **direkt in Zammad**: „Portal: Art“ wählen, die Felder erscheinen; „Portal: im Portal anzeigen“ setzen, damit es auf der Status-Seite steht.
- **Updates einer Störung** sind öffentliche Notizen. Der Betreff ist die Phase („Wird untersucht“, „Ursache gefunden“, „Behoben, wird beobachtet“, „Behoben“). Im Portal erscheinen sie ohne Namen der Bearbeiter.
- **Behoben** heißt: Ticket geschlossen. Das Portal schließt dann die Tickets der Betroffenen mit einer Notiz – auch wenn die Störung direkt in Zammad geschlossen wurde (Prüfung alle fünf Minuten).
- **Wartungen** schließt das Portal nach ihrem Ende. Eine Wartung, die vor ihrem Ende geschlossen wird, gilt als abgesagt.
- **Neue Tickets** aus einem Formular, dessen Services gerade gestört sind, verknüpft das Portal mit der Störung.
- **Probleme:** Tickets werden mit dem Problem verknüpft und bekommen „Portal: bekanntes Problem“. Verantwortlich ist der Besitzer des Problem-Tickets.
- **Services** pflegt das Portal (Name, Beschreibung). Jeder Service ist ein Auswahlwert in „Portal: Services“; gelöschte Services bleiben dort für alte Tickets stehen.
- Die Status-Seite liest Zammad mit 30 Sekunden Zwischenspeicher. Ist Zammad nicht erreichbar, zeigt sie den letzten Stand.

## 6. In Zammad arbeiten

Empfohlene Übersichten (oder per [ITSM-Grundausstattung](ITSM-GRUNDAUSSTATTUNG.md) anlegen lassen):

- **Wartet auf Freigabe:** Portal: Freigabe ist „ausstehend“
- **Offene Störungen:** Portal: Art ist „Störung“, Status nicht geschlossen
- **Wartungen:** Portal: Art ist „Wartung“

Trigger, die beim Anlegen eines Tickets eine Eingangsbestätigung an den Kunden schicken, greifen auch bei Anfragen mit Freigabe (der Kunde ist die anfragende Person). Störungen, Wartungen und Probleme legt das Portal mit dem API-Benutzer als Kunden und mit Notizen an – Eingangsbestätigungen gehen dafür nicht raus.

Für die E-Mails an freigebende und anfragende Personen braucht die Gruppe des Tickets eine **Absenderadresse** (Gruppe → E-Mail).

## 7. Umstieg von 1.x

- **Wartende Freigaben** übernimmt das Portal beim ersten Start von 2.0 selbst: Die Anfragen gehen als Ticket „wartet auf Freigabe“ nach Zammad, die Frist bleibt. Vorher **In Zammad einrichten** ausführen (oder das Update in einem ruhigen Moment einspielen und direkt danach einrichten) – bis dahin wartet die Zustellung und versucht es erneut.
- **Störungen, Wartungen und Probleme** aus 1.x übernimmt die Kommandozeile:

  ```bash
  service-portal-cli zammad:migrate --dry-run   # zeigt, was übernommen würde
  service-portal-cli zammad:migrate             # übernehmen
  ```

  Jeder Eintrag wird genau einmal übernommen; ein zweiter Lauf setzt nach einem Abbruch fort. Updates werden zu öffentlichen Notizen (mit ursprünglicher Uhrzeit im Text), offene Störungen bekommen die Tickets ihrer Betroffenen, verknüpfte Tickets werden in Zammad verknüpft. Die alten Tabellen bleiben unverändert stehen.
- Die Kennung im Portal ist jetzt `<Ticketsystem>.<Ticket-ID>`; Links wie `/stoerungen/…` aus 1.x führen ins Leere.
- **Entfallen:** der von Hand gesetzte Zustand eines Service (dafür eine Störung oder Wartung anlegen) und das Feld „Verantwortlich“ bei Problemen (dafür der Besitzer des Tickets). Die Tags `inc-0001` und `prb-0001` setzt das Portal nicht mehr – stattdessen Verknüpfungen.

## 8. Rechte des API-Benutzers

Für 2.0 braucht der API-Benutzer die Rolle **Admin** (zusätzlich zu Agent für die Gruppen des Portals). Gebraucht werden:

| Recht | Wofür |
| --- | --- |
| `admin.user` | Kunden anlegen, im Namen des Kunden schreiben (`X-On-Behalf-Of`) |
| `admin.object` | Felder und Status lesen und anlegen |
| `admin.group` | Gruppen anlegen |
| `admin.core_workflow` | Abhängigkeiten pflegen |
| `admin.trigger`, `admin.scheduler`, `admin.sla`, `admin.calendar`, `admin.overview` | nur für die [ITSM-Grundausstattung](ITSM-GRUNDAUSSTATTUNG.md) |
| `ticket.agent` | Tickets lesen und schreiben, inkl. der Gruppen für Störungen, Wartungen und Probleme |

Wer die Admin-Rolle nicht dauerhaft vergeben möchte: für die Einrichtung vergeben, danach auf `admin.user` und `ticket.agent` zurücknehmen. Dann kann das Portal nur nicht mehr prüfen, ob Zammad noch passt (Hinweis in der Übersicht), und keine neuen Auswahlwerte für Services eintragen.
