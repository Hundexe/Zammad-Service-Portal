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
writeFileSync(join(out, 'index.html'), readFileSync(join(root, 'src/web/index.html'), 'utf8').replace(/__BUILD__/g, build));
// Das Frontend in app/ nutzt Importe wie '../../shared/form.js' – passt zur Struktur dist/web/app → dist/web/shared.
const count = walk(out).filter((f) => extname(f) === '.js').length;
console.log(`Frontend gebaut: ${count} Module, Build ${build}`);
