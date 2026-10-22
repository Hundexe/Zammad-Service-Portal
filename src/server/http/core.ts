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
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, 'Anfrage zu groß', 'too_large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  const buf = await readBody(req, limit);
  if (buf.length === 0) return {};
  if (type !== 'application/json') throw new HttpError(415, 'Nur application/json wird angenommen', 'unsupported_media_type');
  try {
    return JSON.parse(buf.toString('utf8'), (k, v) => (k === '__proto__' || k === 'constructor' || k === 'prototype' ? undefined : v));
  } catch {
    throw new HttpError(400, 'Ungültiges JSON', 'bad_json');
  }
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

/** Einfacher Token-Bucket je Schlüssel (pro Prozess). */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  private capacity: number;
  private refillPerSec: number;

  constructor(capacity: number, refillPerSec: number) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
  }

  take(key: string, cost = 1): boolean {
    const t = Date.now();
    const b = this.buckets.get(key) ?? { tokens: this.capacity, at: t };
    b.tokens = Math.min(this.capacity, b.tokens + ((t - b.at) / 1000) * this.refillPerSec);
    b.at = t;
    const ok = b.tokens >= cost;
    if (ok) b.tokens -= cost;
    this.buckets.set(key, b);
    if (this.buckets.size > 50000) this.sweep();
    return ok;
  }

  private sweep(): void {
    const t = Date.now();
    for (const [k, b] of this.buckets) if (t - b.at > 3600_000) this.buckets.delete(k);
  }
}
