// Schlanker HTTP-Kern: Router, Body-Parser, Cookies, Fehlerbehandlung.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { BlockList, isIPv4, isIPv6 } from 'node:net';

export class HttpError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, message: string, code = 'error', details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface Ctx<S = unknown, U = unknown> {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  url: URL;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  ip: string;
  cookies: Record<string, string>;
  body: unknown;
  session?: S;
  user?: U;
  requestId: string;
  responded: boolean;
}

export interface RouteOptions {
  /** 'public' = ohne Anmeldung; 'any' = Sitzung in beliebigem Zustand; 'user' = vollständig angemeldet */
  auth: 'public' | 'any' | 'user';
  /** CSRF-Prüfung für ändernde Methoden (Standard: an) */
  csrf?: boolean;
  /** Maximale Body-Größe in Byte */
  bodyLimit?: number;
  /** Rechte (eines davon genügt), optional auf das Ticketsystem aus params.systemId bezogen */
  permission?: string | string[];
  /** Frische Anmeldung erforderlich */
  stepup?: boolean;
  /** Nur aus Admin-Netzen erreichbar */
  adminNet?: boolean;
}

export type Handler = (ctx: Ctx<any, any>) => unknown | Promise<unknown>;

interface Route { method: string; re: RegExp; keys: string[]; handler: Handler; opts: RouteOptions; pattern: string }

export class Router {
  routes: Route[] = [];

  add(method: string, pattern: string, opts: RouteOptions, handler: Handler): void {
    const keys: string[] = [];
    const re = new RegExp('^' + pattern.replace(/\/:([a-zA-Z]+)/g, (_m, k: string) => { keys.push(k); return '/([^/]+)'; }) + '/?$');
    this.routes.push({ method, re, keys, handler, opts, pattern });
  }

  get(p: string, o: RouteOptions, h: Handler) { this.add('GET', p, o, h); }
  post(p: string, o: RouteOptions, h: Handler) { this.add('POST', p, o, h); }
  put(p: string, o: RouteOptions, h: Handler) { this.add('PUT', p, o, h); }
  delete(p: string, o: RouteOptions, h: Handler) { this.add('DELETE', p, o, h); }

  match(method: string, path: string): { route: Route; params: Record<string, string> } | { allowed: string[] } | null {
    const allowed: string[] = [];
    for (const r of this.routes) {
      const m = r.re.exec(path);
      if (!m) continue;
      if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) { allowed.push(r.method); continue; }
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => {
        try { params[k] = decodeURIComponent(m[i + 1]); } catch { throw new HttpError(400, 'Ungültige URL'); }
      });
      return { route: r, params };
    }
    return allowed.length ? { allowed } : null;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!(k in out)) {
      try { out[k] = decodeURIComponent(v); } catch { /* ignorieren */ }
    }
  }
  return out;
}

export interface CookieOpts { maxAge?: number; sameSite?: 'Strict' | 'Lax'; secure: boolean; httpOnly?: boolean }

export function serializeCookie(name: string, value: string, o: CookieOpts): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/'];
  if (o.httpOnly !== false) parts.push('HttpOnly');
  if (o.secure) parts.push('Secure');
  parts.push(`SameSite=${o.sameSite ?? 'Strict'}`);
  if (o.maxAge !== undefined) parts.push(`Max-Age=${o.maxAge}`);
  return parts.join('; ');
}

export function appendCookie(res: ServerResponse, cookie: string): void {
  const prev = res.getHeader('Set-Cookie');
  const list = Array.isArray(prev) ? prev : prev ? [String(prev)] : [];
  res.setHeader('Set-Cookie', [...list, cookie]);
}

export async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > limit) throw new HttpError(413, 'Anfrage zu groß', 'too_large');
  // Mit bekannter Länge direkt in einen Puffer schreiben (spart die Kopie von Buffer.concat)
  if (declared > 0) {
    const out = Buffer.allocUnsafe(declared);
    let size = 0;
    for await (const chunk of req) {
      const c = chunk as Buffer;
      if (size + c.length > declared) throw new HttpError(400, 'Länge der Anfrage stimmt nicht', 'bad_request');
      c.copy(out, size);
      size += c.length;
    }
    return size === declared ? out : out.subarray(0, size);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, 'Anfrage zu groß', 'too_large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/** Grenzen für die Struktur von JSON-Bodys (Tiefe, Anzahl der Elemente). */
export const JSON_LIMITS = { maxDepth: 64, maxTokens: 100_000 };

/**
 * Prüft einen JSON-Body linear, bevor er geparst wird: muss ein Objekt sein, höchstens maxDepth tief
 * und höchstens maxTokens Strukturzeichen ([ { , :) außerhalb von Zeichenketten. Lange Zeichenketten
 * (Base64-Dateien) sind erlaubt. Verhindert Absturz (Heap) und lange Blockaden durch präparierte Bodys.
 */
export function checkJsonShape(buf: Buffer, limits = JSON_LIMITS): string | null {
  let i = 0;
  const n = buf.length;
  while (i < n && (buf[i] === 0x20 || buf[i] === 0x0a || buf[i] === 0x0d || buf[i] === 0x09)) i++;
  if (i < n && buf[i] !== 0x7b /* { */) return 'Es wird ein JSON-Objekt erwartet';
  let depth = 0;
  let tokens = 0;
  let inString = false;
  for (; i < n; i++) {
    const c = buf[i];
    if (inString) {
      if (c === 0x5c /* \ */) i++;
      else if (c === 0x22 /* " */) inString = false;
      continue;
    }
    if (c === 0x22) inString = true;
    else if (c === 0x7b || c === 0x5b) {
      if (++depth > limits.maxDepth) return 'JSON zu tief verschachtelt';
      if (++tokens > limits.maxTokens) return 'JSON hat zu viele Elemente';
    } else if (c === 0x7d || c === 0x5d) depth--;
    else if (c === 0x2c || c === 0x3a) {
      if (++tokens > limits.maxTokens) return 'JSON hat zu viele Elemente';
    }
  }
  return null;
}

export async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  const buf = await readBody(req, limit);
  if (buf.length === 0) return {};
  if (type !== 'application/json') throw new HttpError(415, 'Nur application/json wird angenommen', 'unsupported_media_type');
  const shape = checkJsonShape(buf);
  if (shape) throw new HttpError(400, shape, 'bad_json');
  let out: unknown;
  try {
    out = JSON.parse(buf.toString('utf8'), (k, v) => (k === '__proto__' || k === 'constructor' || k === 'prototype' ? undefined : v));
  } catch {
    throw new HttpError(400, 'Ungültiges JSON', 'bad_json');
  }
  if (typeof out !== 'object' || out === null || Array.isArray(out)) throw new HttpError(400, 'Es wird ein JSON-Objekt erwartet', 'bad_json');
  return out;
}

/**
 * Begrenzt, wie viele Bytes großer Bodys gleichzeitig im Speicher sein dürfen. Wer nicht sofort
 * Platz bekommt, wartet (höchstens timeoutMs), statt den Prozess über das Speicherlimit zu treiben.
 */
export class ByteBudget {
  private used = 0;
  private queue: { bytes: number; resolve: () => void; timer: NodeJS.Timeout }[] = [];
  readonly capacity: number;
  constructor(capacity: number) { this.capacity = capacity; }

  acquire(bytes: number, timeoutMs: number): Promise<void> {
    const need = Math.min(bytes, this.capacity);
    if (this.queue.length === 0 && this.used + need <= this.capacity) { this.used += need; return Promise.resolve(); }
    return new Promise((resolve, reject) => {
      const entry = {
        bytes: need,
        resolve: () => { clearTimeout(entry.timer); this.used += need; resolve(); },
        timer: setTimeout(() => {
          this.queue = this.queue.filter((q) => q !== entry);
          reject(new HttpError(503, 'Das Portal verarbeitet gerade viele Uploads – bitte gleich noch einmal senden', 'busy'));
        }, timeoutMs),
      };
      this.queue.push(entry);
    });
  }

  release(bytes: number): void {
    this.used = Math.max(0, this.used - Math.min(bytes, this.capacity));
    while (this.queue.length && this.used + this.queue[0].bytes <= this.capacity) this.queue.shift()!.resolve();
  }

  get inUse(): number { return this.used; }
}

export function sendJson(ctx: Ctx, status: number, data: unknown): void {
  if (ctx.responded) return;
  ctx.responded = true;
  const body = JSON.stringify(data);
  ctx.res.statusCode = status;
  ctx.res.setHeader('Content-Type', 'application/json; charset=utf-8');
  ctx.res.setHeader('Cache-Control', 'no-store');
  ctx.res.setHeader('Content-Length', Buffer.byteLength(body));
  ctx.res.end(ctx.method === 'HEAD' ? undefined : body);
}

export function redirect(ctx: Ctx, location: string): void {
  if (ctx.responded) return;
  ctx.responded = true;
  ctx.res.statusCode = 302;
  ctx.res.setHeader('Location', location);
  ctx.res.setHeader('Cache-Control', 'no-store');
  ctx.res.end();
}

/** Vertrauenswürdige Proxys (z. B. Caddy) – nur deren X-Forwarded-For wird ausgewertet. */
export class ProxyTrust {
  private list = new BlockList();
  private any = false;
  constructor(cidrs: string[]) {
    for (const c of cidrs) {
      const [addr, bits] = c.split('/');
      const type = isIPv6(addr) ? 'ipv6' : 'ipv4';
      if (!isIPv4(addr) && !isIPv6(addr)) throw new Error(`Ungültiges Netz: ${c}`);
      this.list.addSubnet(addr, Number(bits ?? (type === 'ipv4' ? 32 : 128)), type);
      this.any = true;
    }
  }

  contains(ip: string): boolean {
    if (!this.any) return false;
    const plain = ip.startsWith('::ffff:') && isIPv4(ip.slice(7)) ? ip.slice(7) : ip;
    if (isIPv4(plain)) return this.list.check(plain, 'ipv4');
    if (isIPv6(plain)) return this.list.check(plain, 'ipv6');
    return false;
  }

  clientIp(req: IncomingMessage): string {
    let ip = normalizeIp(req.socket.remoteAddress ?? '');
    if (!this.contains(ip)) return ip;
    const xff = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    // Von rechts nach links: erste Adresse, die kein vertrauenswürdiger Proxy ist.
    for (let i = xff.length - 1; i >= 0; i--) {
      const cand = normalizeIp(xff[i]);
      if (!isIPv4(cand) && !isIPv6(cand)) break;
      ip = cand;
      if (!this.contains(cand)) break;
    }
    return ip;
  }
}

export function normalizeIp(ip: string): string {
  return ip.startsWith('::ffff:') && isIPv4(ip.slice(7)) ? ip.slice(7) : ip;
}

/** Schlüssel für Ratenbegrenzung: IPv6 je /64-Netz (sonst lässt sich die Grenze mit wechselnden Adressen umgehen). */
export function limiterKey(ip: string): string {
  if (!isIPv6(ip)) return ip;
  const plain = ip.split('%')[0];
  const [head, tail] = plain.includes('::') ? plain.split('::') : [plain, undefined];
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const groups = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return groups.slice(0, 4).map((g) => (parseInt(g, 16) || 0).toString(16)).join(':') + '::/64';
}

/**
 * Token-Bucket je Schlüssel (pro Prozess). Aufgeräumt wird zeitgesteuert (volle Buckets sind wie neue
 * und werden entfernt), die Zahl der Schlüssel ist begrenzt: darüber werden die am längsten nicht
 * benutzten verdrängt. Kosten je Aufruf bleiben dadurch konstant.
 */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  private capacity: number;
  private refillPerSec: number;
  private maxKeys: number;
  private lastSweep = Date.now();

  constructor(capacity: number, refillPerSec: number, maxKeys = 100_000) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.maxKeys = maxKeys;
  }

  take(key: string, cost = 1): boolean {
    const t = Date.now();
    const b = this.buckets.get(key) ?? { tokens: this.capacity, at: t };
    b.tokens = Math.min(this.capacity, b.tokens + ((t - b.at) / 1000) * this.refillPerSec);
    b.at = t;
    const ok = b.tokens >= cost;
    if (ok) b.tokens -= cost;
    // Neu einsortieren: Map-Reihenfolge = zuletzt benutzt am Ende
    this.buckets.delete(key);
    this.buckets.set(key, b);
    if (this.buckets.size > this.maxKeys) {
      // In einem Rutsch auf 80 % verdrängen (amortisiert konstant): erst volle Buckets, dann die ältesten
      this.sweep(t);
      const drop = this.buckets.size - Math.floor(this.maxKeys * 0.8);
      if (drop > 0) {
        let i = 0;
        for (const k of this.buckets.keys()) { if (i++ >= drop) break; this.buckets.delete(k); }
      }
    }
    if (t - this.lastSweep > 60_000) this.sweep(t);
    return ok;
  }

  private sweep(t: number): void {
    this.lastSweep = t;
    for (const [k, b] of this.buckets) {
      if (b.tokens + ((t - b.at) / 1000) * this.refillPerSec >= this.capacity) this.buckets.delete(k);
    }
  }

  get size(): number { return this.buckets.size; }
}
