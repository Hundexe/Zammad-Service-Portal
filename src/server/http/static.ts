// Auslieferung des gebauten Frontends (dist/web) mit Schutz gegen Pfad-Traversal.
import { readFileSync, statSync, existsSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { createHash } from 'node:crypto';
import type { Ctx } from './core.ts';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
};

interface Cached { body: Buffer; type: string; etag: string }

export class StaticFiles {
  private root: string;
  private cache = new Map<string, Cached>();
  private dev: boolean;

  constructor(root: string, dev = false) {
    this.root = resolve(root);
    this.dev = dev;
  }

  available(): boolean {
    return existsSync(resolve(this.root, 'index.html'));
  }

  private load(rel: string): Cached | null {
    if (!this.dev && this.cache.has(rel)) return this.cache.get(rel)!;
    const full = resolve(this.root, '.' + sep + rel);
    if (full !== this.root && !full.startsWith(this.root + sep)) return null;
    if (rel.split('/').some((seg) => seg.startsWith('.'))) return null;
    let st;
    try { st = statSync(full); } catch { return null; }
    if (!st.isFile()) return null;
    const type = TYPES[extname(full).toLowerCase()];
    if (!type) return null;
    const body = readFileSync(full);
    const entry = { body, type, etag: '"' + createHash('sha256').update(body).digest('base64url').slice(0, 27) + '"' };
    if (!this.dev) this.cache.set(rel, entry);
    return entry;
  }

  /** Liefert eine Datei aus. Unbekannte Pfade ohne Dateiendung bekommen index.html (Single-Page-App). */
  serve(ctx: Ctx): boolean {
    let rel = ctx.path.replace(/^\/+/, '');
    let file = rel ? this.load(rel) : null;
    if (!file && !extname(rel)) { rel = 'index.html'; file = this.load(rel); }
    if (!file) return false;
    const res = ctx.res;
    res.statusCode = 200;
    res.setHeader('Content-Type', file.type);
    res.setHeader('ETag', file.etag);
    res.setHeader('Cache-Control', rel === 'index.html' ? 'no-cache' : 'public, max-age=3600');
    if (ctx.req.headers['if-none-match'] === file.etag) {
      res.statusCode = 304;
      res.end();
    } else {
      res.setHeader('Content-Length', file.body.length);
      res.end(ctx.method === 'HEAD' ? undefined : file.body);
    }
    ctx.responded = true;
    return true;
  }
}
