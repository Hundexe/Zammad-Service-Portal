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
  { file: 'BETRIEB.md', page: 'betrieb', name: 'Betrieb', hint: 'Sicherung, Monitoring, Härtung' },
  { file: 'UPDATES.md', page: 'updates', name: 'Updates', hint: 'Releases, Rollback' },
  { file: 'SICHERHEIT.md', page: 'sicherheit', name: 'Sicherheit', hint: 'Schutzmaßnahmen, Tests' },
  { file: 'GO-LIVE.md', page: 'go-live', name: 'Go-Live-Checkliste', hint: 'vor dem Produktivbetrieb' },
  { file: 'ARCHITEKTUR.md', page: 'architektur', name: 'Architektur', hint: 'Aufbau und Datenfluss' },
];

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Link- und Bildziele aus docs/ für die Seite unter doku/ umschreiben. Bilder werden nach doku/bilder/ kopiert. */
export function rewriteFor(outDir: string | null) {
  return (url: string, kind: 'link' | 'image'): string => {
    if (/^(https?:|mailto:|#)/i.test(url)) return url;
    const [path, hash] = url.split('#');
    const anchor = hash ? `#${hash}` : '';
    const doc = DOCS.find((d) => path === d.file || path === `./${d.file}`);
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
`;

function page(opts: { title: string; current: string | null; toc: { id: string; text: string; level: number }[]; body: string; description: string }): string {
  const nav = DOCS.map((d) => `<li><a href="${d.page}.html"${d.page === opts.current ? ' aria-current="page"' : ''}>${esc(d.name)}</a></li>`).join('');
  // Unterabschnitte nur, wenn es wenige Hauptabschnitte gibt (sonst wird die Liste zu lang)
  const h2 = opts.toc.filter((t) => t.level === 2).length;
  const entries = opts.toc.filter((t) => t.level === 2 || h2 < 6);
  const toc = entries.length ? `<h2>Auf dieser Seite</h2><ul class="toc">${entries.map((t) => `<li${t.level === 3 ? ' class="sub"' : ''}><a href="#${esc(t.id)}">${esc(t.text)}</a></li>`).join('')}</ul>` : '';
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(opts.title)} – Service-Portal für Zammad</title>
<meta name="description" content="${esc(opts.description)}">
<link rel="icon" href="../demo/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="doku.css">
</head>
<body>
<header class="top"><div class="wrap"><nav class="nav" aria-label="Hauptnavigation">
  <a class="brand" href="../"><span class="brand-mark" aria-hidden="true"></span>Service-Portal für Zammad</a>
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
  const cards = DOCS.map((d) => `<li><a href="${d.page}.html"><b>${esc(d.name)}</b><span>${esc(d.hint)}</span></a></li>`).join('');
  writeFileSync(join(outDir, 'index.html'), page({
    title: 'Dokumentation', current: null, toc: [], description: 'Anleitungen zum Service-Portal für Zammad',
    body: `<h1>Dokumentation</h1><p>Alles zum Einrichten, Bedienen und Betreiben des Portals. Neu hier? Am besten mit der <a href="installation.html">Installation</a> anfangen, danach die <a href="microsoft-anmeldung.html">Microsoft-Anmeldung</a>.</p><ul class="cards">${cards}</ul>
<p class="source"><span>Weitere Berichte (Penetrationstest, Lasttest, Review) und den Quelltext gibt es <a href="${REPO}/tree/main/docs">auf GitHub</a>.</span></p>`,
  }));
  written.push('index.html');
  return written;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = process.argv[2] ?? join(root, 'dist/doku');
  console.log(`Anleitungen gebaut: ${buildDocs(out).length} Seiten in ${out}`);
}
