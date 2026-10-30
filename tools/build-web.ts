// Baut das Frontend ohne Fremdwerkzeuge: TypeScript-Typen werden mit dem in Node
// eingebauten stripTypeScriptTypes entfernt, Importe auf .js umgeschrieben.
// Ergebnis: dist/web/ (index.html, styles.css, app/…, shared/…)
import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, statSync, copyFileSync } from 'node:fs';
import { join, dirname, relative, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';

const root = new URL('..', import.meta.url).pathname;
const out = join(root, 'dist/web');
rmSync(out, { recursive: true, force: true });

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const hash = createHash('sha256');
function emitTs(srcDir: string, destDir: string) {
  for (const file of walk(srcDir).filter((f) => f.endsWith('.ts'))) {
    const src = readFileSync(file, 'utf8');
    let js = stripTypeScriptTypes(src, { mode: 'strip' });
    js = js.replace(/(from\s+['"])(\.{1,2}\/[^'"]+)\.ts(['"])/g, '$1$2.js$3').replace(/(import\s*\(\s*['"])(\.{1,2}\/[^'"]+)\.ts(['"])/g, '$1$2.js$3');
    const dest = join(destDir, relative(srcDir, file)).replace(/\.ts$/, '.js');
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, js);
    hash.update(js);
  }
}

emitTs(join(root, 'src/web'), join(out, 'app'));
emitTs(join(root, 'src/shared'), join(out, 'shared'));

for (const f of ['styles.css', 'favicon.svg', 'theme.js']) {
  copyFileSync(join(root, 'src/web', f), join(out, f));
  hash.update(readFileSync(join(out, f)));
}
// Schrift (Inter, OFL) wird selbst ausgeliefert – keine externen Quellen nötig (CSP font-src 'self').
mkdirSync(join(out, 'fonts'), { recursive: true });
for (const f of readdirSync(join(root, 'src/web/fonts'))) {
  copyFileSync(join(root, 'src/web/fonts', f), join(out, 'fonts', f));
  hash.update(readFileSync(join(out, 'fonts', f)));
}
const build = hash.digest('hex').slice(0, 12);
// Alle Modul-Importe mit der Build-Kennung versehen: Nach einem Update lädt der Browser so den ganzen
// Modulbaum neu – auch wenn er einzelne Dateien noch zwischengespeichert hat (sonst Mischung aus alt und neu).
for (const f of walk(out).filter((x) => extname(x) === '.js' && !x.endsWith('theme.js'))) {
  const js = readFileSync(f, 'utf8')
    .replace(/(from\s+['"])(\.{1,2}\/[^'"?]+\.js)(['"])/g, `$1$2?v=${build}$3`)
    .replace(/(import\s*\(\s*['"])(\.{1,2}\/[^'"?]+\.js)(['"])/g, `$1$2?v=${build}$3`);
  writeFileSync(f, js);
}
writeFileSync(join(out, 'index.html'), readFileSync(join(root, 'src/web/index.html'), 'utf8').replace(/__BUILD__/g, build));
// Service Worker (Portal als App): liegt im Wurzelverzeichnis, damit er für das ganze Portal gilt.
// Die Build-Kennung darin ändert die Datei bei jedem Update – so übernehmen Browser die neue Fassung.
writeFileSync(join(out, 'sw.js'), readFileSync(join(root, 'src/web/sw.js'), 'utf8').replace(/__BUILD__/g, build));
// Das Frontend in app/ nutzt Importe wie '../../shared/form.js' – passt zur Struktur dist/web/app → dist/web/shared.
const count = walk(out).filter((f) => extname(f) === '.js').length;
console.log(`Frontend gebaut: ${count} Module, Build ${build}`);
