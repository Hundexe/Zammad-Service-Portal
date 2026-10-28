# Fremde Bestandteile

Das Portal hat keine npm-Laufzeitabhängigkeiten. Mitgeliefert bzw. zur Laufzeit verwendet werden:

| Bestandteil | Lizenz | Wo |
| --- | --- | --- |
| Schrift **Inter** (The Inter Project Authors) | SIL Open Font License 1.1 | `src/web/fonts/` – Lizenztext in [`src/web/fonts/LICENSE.txt`](src/web/fonts/LICENSE.txt) |
| **Node.js** | MIT und weitere (siehe Node.js-Paket) | Laufzeit; wird bei der Installation von nodejs.org bzw. als Container-Image geladen, nicht im Repository |
| **Caddy** | Apache-2.0 | Reverse Proxy; Paket bzw. Image, nicht im Repository |
| **ClamAV** (optional) | GPL-2.0 | Virenscanner als eigener Dienst bzw. Container, nicht im Repository und nicht mit dem Portal verlinkt |
| **docker-socket-proxy** (optional, Updater) | Apache-2.0 | Container-Image, nicht im Repository |
| Basis-Images `node` (Alpine) und `distroless/nodejs` | jeweils eigene Lizenzen der Pakete im Image | nur beim Bauen der Container |

Nur für die Entwicklung (nicht im Betrieb): TypeScript (Apache-2.0), `@types/node` und `undici-types` (MIT).

## Marken

„Zammad“ ist eine Marke der Zammad Foundation. Dieses Projekt ist **kein offizielles Zammad-Produkt** und steht in keiner Verbindung zur Zammad Foundation oder Zammad GmbH; es nutzt nur die öffentliche Zammad-API. Microsoft, Entra ID, Fluent, Apple und Google bzw. Material sind Marken ihrer jeweiligen Inhaber. Die Stilnamen in der Oberfläche beschreiben nur die Anmutung; es werden keine Logos oder Grafiken dieser Unternehmen mitgeliefert.
