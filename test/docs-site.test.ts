// Anleitungen auf der Webseite: Markdown-Umsetzung und Links zwischen den Seiten.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderMarkdown, slug } from '../tools/md.ts';
import { buildDocs, rewriteFor } from '../tools/build-docs.ts';

test('Anker wie bei GitHub', () => {
  assert.equal(slug('3. Code holen'), '3-code-holen');
  assert.equal(slug('Ausgehende Verbindungen begrenzen (Egress-Firewall)'), 'ausgehende-verbindungen-begrenzen-egress-firewall');
  assert.equal(slug('Einstellungen ändern: deploy/.env'), 'einstellungen-ändern-deployenv');
});

test('Listen, Code, Tabellen, Zitate', () => {
  const md = [
    '# Titel', '', 'Absatz mit **fett**, *kursiv* und `a | b`.', '',
    '1. Erster', '   ```bash', '   echo hi', '   ```', '2. Zweiter', '   - innen', '',
    '| A | B |', '| --- | ---: |', '| `x \\| y` | 2 |', '',
    '> Hinweis', '', '---',
  ].join('\n');
  const r = renderMarkdown(md);
  assert.equal(r.title, 'Titel');
  assert.match(r.html, /<strong>fett<\/strong>/);
  assert.match(r.html, /<em>kursiv<\/em>/);
  assert.match(r.html, /<code>a \| b<\/code>/);
  assert.match(r.html, /<ol><li>Erster\n?<pre data-lang="bash"><code>echo hi<\/code><\/pre><\/li><li>Zweiter\n?<ul><li>innen<\/li><\/ul><\/li><\/ol>/);
  assert.match(r.html, /<td><code>x \| y<\/code><\/td><td style="text-align:right">2<\/td>/);
  assert.match(r.html, /<blockquote><p>Hinweis<\/p><\/blockquote>/);
  assert.match(r.html, /<hr>/);
});

test('Kein freies HTML, keine Skript-Links', () => {
  const r = renderMarkdown('<script>alert(1)</script> <b>x</b> [a](javascript:alert(1)) <img src="x.png" onerror="alert(1)" alt="b">');
  assert.doesNotMatch(r.html, /<script|<b>|javascript:|onerror/);
  assert.match(r.html, /&lt;script&gt;/);
  assert.match(r.html, /<img src="x.png" alt="b" loading="lazy">/);
});

test('Links zwischen Anleitungen, auf GitHub und Bilder', () => {
  const rw = rewriteFor(null);
  assert.equal(rw('BETRIEB.md#sicherung', 'link'), 'betrieb.html#sicherung');
  assert.equal(rw('ENTRA.md', 'link'), 'microsoft-anmeldung.html');
  assert.equal(rw('PENTEST.md', 'link'), 'https://github.com/Hundexe/Zammad-Service-Portal/blob/main/docs/PENTEST.md');
  assert.equal(rw('../deploy/release_signers', 'link'), 'https://github.com/Hundexe/Zammad-Service-Portal/blob/main/deploy/release_signers');
  assert.equal(rw('website/img/start.jpg', 'image'), '../img/start.jpg');
  assert.equal(rw('#abschnitt', 'link'), '#abschnitt');
});

test('Alle Seiten entstehen, alle internen Links und Anker stimmen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zsp-doku-'));
  try {
    buildDocs(dir);
    const pages = readdirSync(dir).filter((f) => f.endsWith('.html'));
    assert.ok(pages.length >= 9);
    const ids = new Map(pages.map((p) => [p, new Set([...readFileSync(join(dir, p), 'utf8').matchAll(/id="([^"]+)"/g)].map((m) => m[1]))]));
    const broken: string[] = [];
    for (const p of pages) {
      for (const [, href] of readFileSync(join(dir, p), 'utf8').matchAll(/(?:href|src)="([^"]+)"/g)) {
        if (/^(https?:|\.\.\/)/.test(href) || href === './' || href === 'doku.css') continue;
        const [path, anchor] = href.split('#');
        const target = path || p;
        if (path && !path.endsWith('.html')) { if (!readdirSync(join(dir, 'bilder')).includes(path.replace('bilder/', ''))) broken.push(`${p}: ${href}`); continue; }
        if (!ids.has(target)) broken.push(`${p}: ${href}`);
        else if (anchor && !ids.get(target)!.has(decodeURIComponent(anchor))) broken.push(`${p}: ${href}`);
      }
    }
    assert.deepEqual(broken, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
