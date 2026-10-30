// Baut die Anleitungen aus docs/*.md als Seiten der Webseite (doku/…html) – für GitHub Pages.
// Aufruf: von build-pages.ts, oder einzeln: node tools/build-docs.ts [Zielordner]
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderMarkdown } from './md.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'https://github.com/Hundexe/Zammad-Service-Portal';

/** Anleitungen auf der Webseite, in dieser Reihenfolge. Andere docs/*.md verlinken auf GitHub. */
export const DOCS: { file: string; page: string; name: string; hint: string }[] = [
  { file: 'INSTALLATION.md', page: 'installation', name: 'Installation', hint: 'Schritt für Schritt' },
  { file: 'ENTRA.md', page: 'microsoft-anmeldung', name: 'Microsoft-Anmeldung', hint: 'App, Rechte, Gruppen' },
  { file: 'BEDIENUNG.md', page: 'bedienung', name: 'Bedienung', hint: 'Portal und Verwaltung' },
  { file: 'APP.md', page: 'app', name: 'Portal als App', hint: 'Installieren, per Intune verteilen' },
  { file: 'BETRIEB.md', page: 'betrieb', name: 'Betrieb', hint: 'Sicherung, Monitoring, Härtung' },
  { file: 'UPDATES.md', page: 'updates', name: 'Updates', hint: 'Releases, Rollback' },
  { file: 'SICHERHEIT.md', page: 'sicherheit', name: 'Sicherheit', hint: 'Schutzmaßnahmen, Tests' },
  { file: 'GO-LIVE.md', page: 'go-live', name: 'Go-Live-Checkliste', hint: 'vor dem Produktivbetrieb' },
  { file: 'ARCHITEKTUR.md', page: 'architektur', name: 'Architektur', hint: 'Aufbau und Datenfluss' },
];

/** Prüfberichte, neueste zuerst (sortiert nach Datum). Funde und Stand werden aus den Tabellen der Berichte gezählt. */
export const AUDITS: { file: string; page: string; name: string; kind: string; date: string; dateText: string; version: string; scope: string; summary?: string }[] = [
  {
    file: 'SICHERHEITSTEST-2026-10-28.md', page: 'sicherheitstest-2026-10-28', name: 'Sicherheitstest der neuen Funktionen', kind: 'Sicherheitstest',
    date: '2026-10-28', dateText: '28.10.2026', version: 'Version 1.8.0, Korrekturen bis 1.10.2',
    scope: 'Gesamter Quellcode und laufende Instanz hinter Caddy mit TLS. Schwerpunkt: Freigabe durch Vorgesetzte, Benachrichtigungen, Personensuche, Export und Import, Update-Dienst ohne Docker.',
  },
  {
    file: 'REVIEW-2026-10.md', page: 'review-2026-10', name: 'Externes Review', kind: 'Review',
    date: '2026-10-27', dateText: '27.10.2026', version: 'Version 1.3.0, Nachträge 1.3.1 und 1.3.2',
    scope: 'Architektur, Anmeldung, Rechteprüfung, Zammad-Anbindung, Uploads, SSRF, Updater, Container, SQLite, Tests und Projektzustand.',
    summary: 'Urteil des Reviews: Pilot ja, eingeschränkter Produktivbetrieb nach zusätzlichen Prüfungen. Alle 12 Punkte sind bearbeitet, zwei Fehler im Code gefunden und behoben, die Zahl der Tests stieg von 128 auf 196. Dazu ein zweites Review mit drei Schwerpunkten (IPv6 beim SSRF-Schutz, TLS-Prüfung, Schlüssel der Microsoft-Anmeldung).',
  },
  {
    file: 'LASTTEST.md', page: 'lasttest', name: 'Lasttest', kind: 'Lasttest',
    date: '2026-10-27', dateText: '27.10.2026', version: 'Version 1.3.0',
    scope: 'Anmeldespitze, Ticketansichten und gleichzeitige Anfragen mit Anhang, dazu Ausfall und Neustart von Zammad und Portal.',
    summary: '50 Anmeldungen, 50 Ticketansichten und 20 gleichzeitige Anfragen mit 1 MB Anhang: keine Fehler, alle Antworten unter 0,6 Sekunden. Nach Ausfällen gehen keine Anfragen verloren und es entstehen keine doppelten Tickets.',
  },
  {
    file: 'PENTEST.md', page: 'pentest', name: 'Penetrationstest', kind: 'Penetrationstest',
    date: '2026-10-21', dateText: '21. und 22.10.2026', version: 'Version 1.0.0, Nachprüfung mit 1.1.0',
    scope: 'Web-Anwendung, Reverse Proxy mit TLS, Container-Konfiguration, Updater-Logik und Quellcode, mit Scannern (testssl.sh, nuclei, trivy, hadolint) und automatisierten Angriffstests.',
  },
];

export const SEVERITIES = ['Kritisch', 'Hoch', 'Mittel', 'Niedrig', 'Info'] as const;
type Severity = (typeof SEVERITIES)[number];
type State = 'behoben' | 'teilweise' | 'restrisiko' | 'inhaber' | 'offen';
const STATE_LABEL: Record<State, string> = { behoben: 'behoben', teilweise: 'teilweise behoben', restrisiko: 'Restrisiko dokumentiert', inhaber: 'beim Inhaber des Repositorys', offen: 'offen' };

/** Funde aus der Tabelle eines Berichts (Spalten ID, Risiko/Schwere, Stand/Status/Behebung). */
export function findingsOf(md: string): { id: string; severity: Severity; state: State }[] {
  const out: { id: string; severity: Severity; state: State }[] = [];
  const lines = md.split('\n');
  for (let i = 0; i < lines.length - 1; i++) {
    const head = lines[i].split('|').map((c) => c.trim());
    if (head[1] !== 'ID' || !/^\|?\s*-{3}/.test(lines[i + 1])) continue;
    const sevCol = head.findIndex((c) => c === 'Risiko' || c === 'Schwere');
    const stateCol = head.findIndex((c) => c === 'Stand' || c === 'Status' || c === 'Behebung');
    if (sevCol < 0 || stateCol < 0) continue;
    const fixedByDesign = head[stateCol] === 'Behebung';
    for (let j = i + 2; j < lines.length && lines[j].startsWith('|'); j++) {
      const cells = lines[j].split('|').map((c) => c.trim());
      const sev = SEVERITIES.find((x) => cells[sevCol].replace(/\*/g, '').startsWith(x));
      if (!sev) continue;
      const st = cells[stateCol].replace(/\*/g, '').toLowerCase();
      const state: State = fixedByDesign || st.startsWith('behoben') ? 'behoben' : st.startsWith('teilweise') ? 'teilweise'
        : st.startsWith('dokumentiert') ? 'restrisiko' : st.startsWith('beim inhaber') ? 'inhaber' : 'offen';
      out.push({ id: cells[1], severity: sev, state });
    }
    break;
  }
  return out;
}

/** Schwere und Stand in den Tabellen der Berichte als farbige Marken, IDs verlinken auf ihre Details. */
function decorateReport(html: string): string {
  const detail = new Map<string, string>();
  for (const m of html.matchAll(/<h3 id="(((?:st|pt)-\d\d)[^"]*)"/g)) detail.set(m[2].toUpperCase(), m[1]);
  return html
    .replace(/<td>(<strong>)?(Kritisch|Hoch|Mittel|Niedrig|Info)(<\/strong>)?/g, (_m, _a, sev: string) => `<td><span class="sev sev-${sev.toLowerCase()}">${sev}</span>`)
    .replace(/<td>(<strong>)?(behoben|teilweise|dokumentiert|beim Inhaber|offen)([^<]*)(<\/strong>)?/g, (m, a: string | undefined, k: string, rest: string, b: string | undefined) => {
      if (Boolean(a) !== Boolean(b)) return m;
      const cls = k === 'behoben' ? 'ok' : k === 'offen' ? 'open' : 'part';
      return `<td><span class="state state-${cls}">${k}</span>${rest}`;
    })
    .replace(/<td>((?:ST|PT)-\d\d)<\/td>/g, (m, id: string) => (detail.has(id) ? `<td><a href="#${detail.get(id)}">${id}</a></td>` : m));
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Link- und Bildziele aus docs/ für die Seite unter doku/ umschreiben. Bilder werden nach doku/bilder/ kopiert. */
export function rewriteFor(outDir: string | null) {
  return (url: string, kind: 'link' | 'image'): string => {
    if (/^(https?:|mailto:|#)/i.test(url)) return url;
    const [path, hash] = url.split('#');
    const anchor = hash ? `#${hash}` : '';
    const doc = [...DOCS, ...AUDITS].find((d) => path === d.file || path === `./${d.file}`);
    if (doc) return `${doc.page}.html${anchor}`;
    if (path === '../README.md') return `../${anchor}`;
    if (path.startsWith('website/img/')) return `../img/${path.slice('website/img/'.length)}`;
    const repoPath = normalize(join('docs', path)).replace(/\\/g, '/');
    if (kind === 'image' && path.startsWith('screenshots/') && outDir) {
      const src = join(root, repoPath);
      if (existsSync(src)) {
        mkdirSync(join(outDir, 'bilder'), { recursive: true });
        copyFileSync(src, join(outDir, 'bilder', path.slice('screenshots/'.length)));
        return `bilder/${path.slice('screenshots/'.length)}`;
      }
    }
    // Alles andere (weitere Dokumente, Skripte, Konfiguration) auf GitHub
    if (repoPath.startsWith('..')) return REPO;
    return `${REPO}/${kind === 'image' ? 'raw' : 'blob'}/main/${repoPath}${anchor}`;
  };
}

const CSS = `
@font-face { font-family: "Site Sans"; src: url("../demo/fonts/inter-400.woff") format("woff"); font-weight: 400; font-display: swap; }
@font-face { font-family: "Site Sans"; src: url("../demo/fonts/inter-600.woff") format("woff"); font-weight: 600 700; font-display: swap; }
@font-face { font-family: "Site Display"; src: url("../demo/fonts/inter-display-700.woff") format("woff"); font-weight: 700; font-display: swap; }
:root { --ink: #0e2238; --paper: #f3f5f8; --text: #172233; --muted: #556275; --line: #d8dfe8; --blue: #1662a8; --teal: #0f8a6a;
  --sans: "Site Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; --display: "Site Display", "Site Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace; color-scheme: light; }
* { box-sizing: border-box; }
html { scroll-behavior: smooth; scroll-padding-top: 24px; -webkit-text-size-adjust: 100%; }
@media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } }
body { margin: 0; background: var(--paper); color: var(--text); font: 400 16.5px/1.65 var(--sans); }
a { color: var(--blue); text-underline-offset: 3px; }
:focus-visible { outline: 3px solid #5aa0f0; outline-offset: 3px; border-radius: 6px; }
.wrap { width: min(1240px, 100% - 48px); margin: 0 auto; }
@media (max-width: 640px) { .wrap { width: calc(100% - 32px); } body { font-size: 16px; } }
.top { background: var(--ink); }
.nav { display: flex; align-items: center; gap: 28px; height: 64px; }
.brand { display: flex; align-items: center; gap: 10px; color: #fff; text-decoration: none; font: 600 17px/1 var(--display); }
.brand-mark { width: 24px; height: 24px; border-radius: 50%; border: 3px solid #fff; }
.nav-links { display: flex; gap: 22px; margin-left: auto; }
.nav-links a { color: #c3d1e3; text-decoration: none; font-size: 15px; }
.nav-links a:hover, .nav-links a[aria-current] { color: #fff; }
@media (max-width: 760px) { .nav-links a:not(.keep) { display: none; } .brand { font-size: 15px; } }
.layout { display: grid; grid-template-columns: 250px minmax(0, 1fr); gap: 56px; padding: 40px 0 96px; }
.side { position: sticky; top: 24px; align-self: start; max-height: calc(100vh - 48px); overflow-y: auto; font-size: 15px; }
.side h2 { font: 600 13px/1.4 var(--sans); color: var(--muted); margin: 0 0 8px; }
.side ul { list-style: none; margin: 0 0 28px; padding: 0; }
.side li a { display: block; padding: 5px 10px; border-radius: 8px; color: var(--text); text-decoration: none; }
.side li a:hover { background: #e6ebf2; }
.side li a[aria-current] { background: var(--ink); color: #fff; }
.side .toc a { color: var(--muted); padding: 3px 10px; font-size: 14px; }
.side .toc a:hover { color: var(--text); }
.side .toc .sub a { padding-left: 22px; font-size: 13.5px; }
.side details summary { display: none; }
@media (max-width: 960px) {
  .layout { grid-template-columns: 1fr; gap: 0; padding-top: 20px; }
  .side { position: static; max-height: none; background: #fff; border: 1px solid var(--line); border-radius: 12px; padding: 4px 14px; margin-bottom: 28px; }
  .side details summary { display: block; cursor: pointer; padding: 10px 0; font-weight: 600; }
  .side details:not([open]) > :not(summary) { display: none; }
}
.doc { max-width: 78ch; min-width: 0; }
.doc h1 { font: 700 clamp(32px, 4.4vw, 50px)/1.05 var(--display); letter-spacing: -.03em; margin: 0 0 24px; }
.doc h2 { font: 700 28px/1.2 var(--display); letter-spacing: -.02em; margin: 56px 0 14px; padding-top: 20px; border-top: 1px solid var(--line); }
.doc h3 { font: 600 20px/1.3 var(--display); margin: 34px 0 10px; }
.doc h4 { font: 600 17px/1.4 var(--sans); margin: 26px 0 8px; }
.doc .anchor { margin-left: 10px; color: var(--line); text-decoration: none; font-weight: 400; opacity: 0; }
.doc :is(h2, h3, h4):hover .anchor, .doc .anchor:focus-visible { opacity: 1; color: var(--muted); }
.doc p, .doc ul, .doc ol { margin: 0 0 14px; }
.doc li { margin: 4px 0; }
.doc li > ul, .doc li > ol { margin: 6px 0; }
.doc code { font: .88em/1.4 var(--mono); background: #e7ecf3; padding: .12em .38em; border-radius: 5px; overflow-wrap: anywhere; }
.doc pre { margin: 0 0 18px; background: var(--ink); color: #e6eef8; border-radius: 12px; padding: 16px 18px; overflow-x: auto; font: 14px/1.6 var(--mono); }
.doc pre code { background: none; padding: 0; font: inherit; color: inherit; overflow-wrap: normal; }
.doc .table { overflow-x: auto; margin: 0 0 18px; border: 1px solid var(--line); border-radius: 12px; background: #fff; }
.doc table { border-collapse: collapse; width: 100%; font-size: 15px; }
.doc th, .doc td { text-align: left; vertical-align: top; padding: 10px 14px; border-bottom: 1px solid var(--line); }
.doc th { background: #edf1f6; font-weight: 600; }
.doc tr:last-child td { border-bottom: 0; }
.doc blockquote { margin: 0 0 18px; padding: 12px 18px; border-left: 3px solid var(--teal); background: #e7f3ef; border-radius: 0 10px 10px 0; }
.doc blockquote > :last-child { margin-bottom: 0; }
.doc img { max-width: 100%; height: auto; border-radius: 10px; box-shadow: 0 1px 2px rgba(14, 34, 56, .08), 0 14px 34px -16px rgba(14, 34, 56, .3); vertical-align: top; margin: 6px 0; }
.doc hr { border: 0; border-top: 1px solid var(--line); margin: 40px 0; }
.doc hr:has(+ h2) { display: none; }
.doc h1 + h2 { border-top: 0; padding-top: 0; margin-top: 24px; }
.source { margin-top: 56px; padding-top: 18px; border-top: 1px solid var(--line); font-size: 14.5px; color: var(--muted); display: flex; flex-wrap: wrap; gap: 8px 24px; justify-content: space-between; }
.pager { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 40px; }
.pager a { display: block; padding: 14px 18px; border: 1px solid var(--line); border-radius: 12px; background: #fff; text-decoration: none; color: var(--text); }
.pager a:hover { border-color: var(--blue); }
.pager span { display: block; font-size: 13.5px; color: var(--muted); }
.pager .next { text-align: right; grid-column: 2; }
.cards { list-style: none; padding: 0; margin: 32px 0 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.cards a { display: block; padding: 18px 20px; background: #fff; border: 1px solid var(--line); border-radius: 12px; text-decoration: none; color: var(--text); height: 100%; }
.cards a:hover { border-color: var(--blue); }
.cards b { display: block; font: 600 18px/1.3 var(--display); margin-bottom: 4px; }
.cards span { color: var(--muted); font-size: 15px; }
@media (max-width: 640px) { .cards, .pager { grid-template-columns: 1fr; } .pager .next { grid-column: 1; } }
.crumbs { margin: 0 0 10px; font-size: 14.5px; }
.crumbs a { text-decoration: none; }
.report-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; margin: 0 0 14px; color: var(--muted); font-size: 14.5px; }
.kind { display: inline-block; padding: 2px 10px; border-radius: 999px; font: 600 13px/1.5 var(--sans); vertical-align: middle; letter-spacing: 0; }
.kind-sicherheitstest { background: #fbe7e5; color: #8f1d16; }
.kind-penetrationstest { background: #f8ecd9; color: #7a4d06; }
.kind-review { background: #e3edf9; color: #0f4c86; }
.kind-lasttest { background: #dff3ec; color: #0b6b52; }
.sev { display: inline-block; padding: 1px 9px; border-radius: 999px; font-size: 13px; font-weight: 600; white-space: nowrap; }
.sev.sev-kritisch { background: #7f1d1d; color: #fff; }
.sev.sev-hoch { background: #fbe1df; color: #a3201a; }
.sev.sev-mittel { background: #fbefd9; color: #8a5600; }
.sev.sev-niedrig { background: #e3edf9; color: #0f4c86; }
.sev.sev-info { background: #e9edf2; color: #4a5566; }
.state { display: inline-block; padding: 1px 9px; border-radius: 999px; font-size: 13px; font-weight: 600; white-space: nowrap; margin-right: 4px; }
.state-ok { background: #dff3ec; color: #0b6b52; }
.state-part { background: #fbefd9; color: #8a5600; }
.state-open { background: #fbe1df; color: #a3201a; }
.sevbar { display: flex; height: 12px; border-radius: 999px; overflow: hidden; gap: 2px; margin: 14px 0 10px; background: var(--line); }
.sevbar span, .dot { background: #8b97a8; }
.sevbar .sev-kritisch, .dot.sev-kritisch { background: #7f1d1d; }
.sevbar .sev-hoch, .dot.sev-hoch { background: #d0352c; }
.sevbar .sev-mittel, .dot.sev-mittel { background: #d58c12; }
.sevbar .sev-niedrig, .dot.sev-niedrig { background: #3b7fc4; }
.sevbar .sev-info, .dot.sev-info { background: #a4aebb; }
.legend { list-style: none; padding: 0; margin: 0 0 10px; display: flex; flex-wrap: wrap; gap: 4px 18px; font-size: 14.5px; color: var(--muted); }
.legend li { margin: 0; display: flex; align-items: center; gap: 6px; }
.legend b { color: var(--text); }
.dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
.states { margin: 0 0 6px; display: flex; flex-wrap: wrap; gap: 6px; }
.report-sum { background: #fff; border: 1px solid var(--line); border-radius: 12px; padding: 4px 18px 10px; margin: 0 0 28px; }
.doc .lead { font-size: 18.5px; color: var(--text); }
.doc .small { font-size: 14.5px; color: var(--muted); }
.doc h2.plain { border-top: 0; padding-top: 0; margin-top: 44px; }
.timeline { list-style: none; padding: 0; margin: 20px 0 0; position: relative; }
.timeline::before { content: ""; position: absolute; left: 112px; top: 6px; bottom: 6px; width: 2px; background: var(--line); }
.audit { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 0 34px; margin: 0 0 22px; position: relative; }
.audit::before { content: ""; position: absolute; left: 107px; top: 22px; width: 12px; height: 12px; border-radius: 50%; background: var(--paper); border: 2px solid var(--blue); }
.when { text-align: right; padding-top: 14px; color: var(--muted); font-size: 14px; line-height: 1.2; }
.when b { display: block; font: 700 22px/1.1 var(--display); color: var(--text); }
.audit-card { background: #fff; border: 1px solid var(--line); border-radius: 14px; padding: 16px 22px 8px; }
.audit-card h2 { margin: 0 0 2px; padding: 0; border: 0; font-size: 22px; }
.audit-card h2 a { color: var(--text); text-decoration: none; }
.audit-card h2 a:hover { color: var(--blue); }
.audit-card .meta { color: var(--muted); font-size: 14.5px; margin: 0 0 8px; }
.audit-card .result { border-left: 3px solid var(--teal); padding-left: 12px; }
.audit-card .read { font-weight: 600; }
.cards .wide { grid-column: 1 / -1; }
@media (max-width: 640px) {
  .timeline::before, .audit::before { display: none; }
  .audit { grid-template-columns: 1fr; }
  .when { text-align: left; padding: 0 0 6px; }
  .when b { display: inline; margin-right: 4px; }
}

`;

function page(opts: { title: string; current: string | null; toc: { id: string; text: string; level: number }[]; body: string; description: string }): string {
  const item = (href: string, name: string, cur: boolean) => `<li><a href="${href}"${cur ? ' aria-current="page"' : ''}>${esc(name)}</a></li>`;
  const nav = DOCS.map((d) => item(`${d.page}.html`, d.name, d.page === opts.current)).join('');
  const reports = item('pruefungen.html', 'Übersicht', opts.current === 'pruefungen') + AUDITS.map((a) => item(`${a.page}.html`, `${a.kind} ${a.date.split('-').reverse().join('.')}`, a.page === opts.current)).join('');
  // Unterabschnitte nur, wenn es wenige Hauptabschnitte gibt (sonst wird die Liste zu lang)
  const h2 = opts.toc.filter((t) => t.level === 2).length;
  const entries = opts.toc.filter((t) => t.level === 2 || h2 < 6);
  const toc = entries.length ? `<h2>Auf dieser Seite</h2><ul class="toc">${entries.map((t) => `<li${t.level === 3 ? ' class="sub"' : ''}><a href="#${esc(t.id)}">${esc(t.text)}</a></li>`).join('')}</ul>` : '';
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(opts.title)} – Self-Service-Portal für Zammad</title>
<meta name="description" content="${esc(opts.description)}">
<link rel="icon" href="../demo/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="doku.css">
</head>
<body>
<header class="top"><div class="wrap"><nav class="nav" aria-label="Hauptnavigation">
  <a class="brand" href="../"><span class="brand-mark" aria-hidden="true"></span>Self-Service-Portal für Zammad</a>
  <div class="nav-links">
    <a href="../#video">Video</a>
    <a class="keep" href="./" aria-current="page">Dokumentation</a>
    <a href="../demo/">Demo</a>
    <a href="${REPO}">GitHub</a>
  </div>
</nav></div></header>
<div class="wrap layout">
  <aside class="side" aria-label="Dokumentation">
    <details open><summary>Anleitungen und Inhalt</summary>
      <h2>Anleitungen</h2>
      <ul>${nav}</ul>
      <h2>Sicherheitsprüfungen</h2>
      <ul>${reports}</ul>
      ${toc}
    </details>
  </aside>
  <main class="doc" id="inhalt">
${opts.body}
  </main>
</div>
<script>
  // Auf schmalen Bildschirmen startet das Menü zugeklappt
  if (matchMedia('(max-width: 960px)').matches) document.querySelector('.side details').removeAttribute('open');
</script>
</body>
</html>
`;
}

const slugKind = (k: string) => k.toLowerCase().replace(/[^a-z]+/g, '-');
const count = <T,>(list: T[], fn: (x: T) => boolean) => list.filter(fn).length;
type Finding = ReturnType<typeof findingsOf>[number];

function severityBar(f: Finding[]): string {
  const parts = SEVERITIES.map((s) => ({ s, n: count(f, (x) => x.severity === s) })).filter((p) => p.n);
  const label = `${f.length} Funde: ${parts.map((p) => `${p.n} ${p.s.toLowerCase()}`).join(', ')}`;
  return `<div class="sevbar" role="img" aria-label="${esc(label)}">${parts.map((p) => `<span class="sev-${p.s.toLowerCase()}" style="flex:${p.n}"></span>`).join('')}</div>
<ul class="legend">${parts.map((p) => `<li><span class="dot sev-${p.s.toLowerCase()}"></span><b>${p.n}</b> ${esc(p.s.toLowerCase())}</li>`).join('')}</ul>`;
}

function statusLine(f: Finding[]): string {
  const states = (['behoben', 'teilweise', 'restrisiko', 'inhaber', 'offen'] as const).map((s) => ({ s, n: count(f, (x) => x.state === s) })).filter((p) => p.n);
  return `<p class="states">${states.map((p) => `<span class="state state-${p.s === 'behoben' ? 'ok' : p.s === 'offen' ? 'open' : 'part'}">${p.n} ${esc(STATE_LABEL[p.s])}</span>`).join(' ')}</p>`;
}

function overview(stats: { audit: (typeof AUDITS)[number]; findings: Finding[] }[]): string {
  const all = stats.flatMap((x) => x.findings);
  const fixed = count(all, (x) => x.state === 'behoben');
  const seriousOpen = all.filter((x) => (x.severity === 'Kritisch' || x.severity === 'Hoch') && x.state !== 'behoben');
  const rest = all.filter((x) => x.state !== 'behoben');
  const first = stats[stats.length - 1].audit, last = stats[0].audit;
  const entries = stats.map(({ audit: a, findings: f }) => {
    const [y, m, d] = a.date.split('-');
    return `<li class="audit">
  <div class="when"><time datetime="${a.date}"><b>${d}.${m}.</b>${y}</time></div>
  <article class="audit-card">
    <h2 id="${a.page}"><a href="${a.page}.html">${esc(a.name)}</a> <span class="kind kind-${slugKind(a.kind)}">${esc(a.kind)}</span></h2>
    <p class="meta">${esc(a.dateText)}, ${esc(a.version)}</p>
    <p>${esc(a.scope)}</p>
    ${f.length ? severityBar(f) + statusLine(f) : `<p class="result">${esc(a.summary ?? '')}</p>`}
    <p><a class="read" href="${a.page}.html">Bericht lesen</a></p>
  </article>
</li>`;
  }).join('\n');
  return `<h1>Sicherheitsprüfungen</h1>
<p class="lead">Zwischen dem ${first.date.split('-').reverse().join('.')} und dem ${last.date.split('-').reverse().join('.')} wurde das Portal ${stats.length}-mal geprüft. Von ${all.length} Funden sind ${fixed} behoben${seriousOpen.length ? `, ${seriousOpen.length} mit hohem oder kritischem Risiko sind noch offen` : '; offen ist keiner mit hohem oder kritischem Risiko'}.</p>
<div class="report-sum overall">${severityBar(all)}${statusLine(all)}</div>
${rest.length ? `<p class="small">Noch nicht ganz erledigt: ${rest.map((x) => `<b>${esc(x.id)}</b> (${esc(STATE_LABEL[x.state])})`).join(', ')}. Details stehen im jeweiligen Bericht.</p>` : ''}
<blockquote><p><strong>Einordnung:</strong> Die Prüfungen liefen während der Entwicklung in einer Testumgebung mit Simulatoren für Zammad, Microsoft Entra ID und ClamAV. Sie ersetzen keinen unabhängigen Penetrationstest gegen die echte Installation – der gehört zur <a href="go-live.html">Go-Live-Checkliste</a>.</p></blockquote>
<h2 class="plain">Nach Datum, neueste zuerst</h2>
<ol class="timeline">
${entries}
</ol>
<p class="source"><span>Schwachstellen bitte vertraulich melden: <a href="${REPO}/blob/main/SECURITY.md">SECURITY.md</a>.</span><a href="#inhalt">Nach oben</a></p>`;
}

export function buildDocs(outDir: string): string[] {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'doku.css'), CSS.trim() + '\n');
  const rewrite = rewriteFor(outDir);
  const written: string[] = [];
  DOCS.forEach((d, i) => {
    const md = readFileSync(join(root, 'docs', d.file), 'utf8');
    const r = renderMarkdown(md, { rewrite });
    const prev = DOCS[i - 1], next = DOCS[i + 1];
    const pager = `<nav class="pager" aria-label="Weitere Anleitungen">${prev ? `<a href="${prev.page}.html"><span>Zurück</span>${esc(prev.name)}</a>` : ''}${next ? `<a class="next" href="${next.page}.html"><span>Weiter</span>${esc(next.name)}</a>` : ''}</nav>`;
    const source = `<p class="source"><span>Diese Seite entsteht aus <a href="${REPO}/blob/main/docs/${d.file}">docs/${d.file}</a>.</span><a href="#inhalt">Nach oben</a></p>`;
    writeFileSync(join(outDir, `${d.page}.html`), page({ title: r.title || d.name, current: d.page, toc: r.toc, body: r.html + pager + source, description: `${d.name}: ${d.hint}` }));
    written.push(`${d.page}.html`);
  });
  // Prüfberichte
  const stats = AUDITS.map((a) => ({ audit: a, findings: findingsOf(readFileSync(join(root, 'docs', a.file), 'utf8')) }));
  AUDITS.forEach((a, i) => {
    const r = renderMarkdown(readFileSync(join(root, 'docs', a.file), 'utf8'), { rewrite });
    const prev = AUDITS[i - 1], next = AUDITS[i + 1];
    const pager = `<nav class="pager" aria-label="Weitere Prüfberichte">${prev ? `<a href="${prev.page}.html"><span>Neuer</span>${esc(prev.name)}</a>` : `<a href="pruefungen.html"><span>Zurück</span>Übersicht</a>`}${next ? `<a class="next" href="${next.page}.html"><span>Älter</span>${esc(next.name)}</a>` : ''}</nav>`;
    const source = `<p class="source"><span>Diese Seite entsteht aus <a href="${REPO}/blob/main/docs/${a.file}">docs/${a.file}</a>.</span><a href="#inhalt">Nach oben</a></p>`;
    const head = `<p class="crumbs"><a href="pruefungen.html">Sicherheitsprüfungen</a></p><div class="report-meta"><span class="kind kind-${slugKind(a.kind)}">${esc(a.kind)}</span><time datetime="${a.date}">${esc(a.dateText)}</time><span>${esc(a.version)}</span></div>`;
    const f = stats[i].findings;
    const box = f.length ? `<div class="report-sum">${severityBar(f)}${statusLine(f)}</div>` : '';
    const body = r.html.replace(/(<h1[^>]*>[\s\S]*?<\/h1>)/, `${head}$1${box}`);
    writeFileSync(join(outDir, `${a.page}.html`), page({ title: r.title || a.name, current: a.page, toc: r.toc, body: decorateReport(body) + pager + source, description: `${a.kind} vom ${a.dateText}: ${a.scope}` }));
    written.push(`${a.page}.html`);
  });
  writeFileSync(join(outDir, 'pruefungen.html'), page({ title: 'Sicherheitsprüfungen', current: 'pruefungen', toc: [], description: 'Alle Sicherheitsprüfungen des Self-Service-Portals für Zammad, nach Datum', body: overview(stats) }));
  written.push('pruefungen.html');

  const cards = DOCS.map((d) => `<li><a href="${d.page}.html"><b>${esc(d.name)}</b><span>${esc(d.hint)}</span></a></li>`).join('');
  writeFileSync(join(outDir, 'index.html'), page({
    title: 'Dokumentation', current: null, toc: [], description: 'Anleitungen zum Self-Service-Portal für Zammad',
    body: `<h1>Dokumentation</h1><p>Alles zum Einrichten, Bedienen und Betreiben des Portals. Neu hier? Am besten mit der <a href="installation.html">Installation</a> anfangen, danach die <a href="microsoft-anmeldung.html">Microsoft-Anmeldung</a>.</p><ul class="cards">${cards}<li class="wide"><a href="pruefungen.html"><b>Sicherheitsprüfungen</b><span>Penetrationstest, Review, Lasttest und Sicherheitstest – mit allen Funden und ihrem Stand, nach Datum</span></a></li></ul>
<p class="source"><span>Den Quelltext aller Anleitungen gibt es <a href="${REPO}/tree/main/docs">auf GitHub</a>.</span></p>`,
  }));
  written.push('index.html');
  return written;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = process.argv[2] ?? join(root, 'dist/doku');
  console.log(`Anleitungen gebaut: ${buildDocs(out).length} Seiten in ${out}`);
}
