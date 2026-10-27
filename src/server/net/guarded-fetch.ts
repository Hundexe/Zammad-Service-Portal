// Ausgehende Verbindungen zu Ticketsystemen mit SSRF-Schutz.
//
// Die Adresse eines Ticketsystems wird beim Speichern geprüft. Das allein reicht nicht: Ein DNS-Eintrag
// kann sich danach ändern (DNS-Rebinding) und plötzlich auf 127.0.0.1, einen Cloud-Metadaten-Dienst
// oder einen anderen Container zeigen. Dieser fetch prüft deshalb bei JEDEM Verbindungsaufbau die
// tatsächlich aufgelöste IP-Adresse – direkt vor dem Connect, ohne zweite Namensauflösung.
// Weiterleitungen werden nie verfolgt.
import http from 'node:http';
import https from 'node:https';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';

/** Namen der eigenen Dienste (Docker-Compose) – ein Ticketsystem darf nie auf sie zeigen. */
export const INTERNAL_HOSTNAMES = ['localhost', 'app', 'worker', 'caddy', 'clamav', 'socket-proxy', 'updater', 'portal', 'zammad-service-portal'];

export interface GuardOptions {
  /** Private Netze (10/8, 172.16/12, 192.168/16, 100.64/10, fc00::/7) erlauben – Zammad steht meist intern */
  allowPrivate: boolean;
  /** Loopback und eigene Dienstnamen erlauben (nur Entwicklung und Tests) */
  allowLoopback: boolean;
  /** Größte Antwort in Byte */
  maxBytes?: number;
}

/** Grund, warum eine Adresse gesperrt ist – oder null, wenn sie erlaubt ist. */
export function blockedAddress(ip: string, opts: Pick<GuardOptions, 'allowPrivate' | 'allowLoopback'>): string | null {
  const raw = ip.replace(/^\[|\]$/g, '').toLowerCase();
  const v4 = raw.startsWith('::ffff:') && isIP(raw.slice(7)) === 4 ? raw.slice(7) : raw;
  if (isIP(v4) === 4) {
    const [a, b] = v4.split('.').map(Number);
    if (a === 127) return opts.allowLoopback ? null : 'Loopback';
    if (a === 169 && b === 254) return 'Link-Local / Metadaten-Dienst';
    if (a === 0) return 'ungültige Adresse';
    if (a >= 224) return 'Multicast / reserviert';
    const priv = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
    if (priv && !opts.allowPrivate) return 'privates Netz';
    return null;
  }
  if (isIP(v4) !== 6) return 'keine IP-Adresse';
  if (v4 === '::1') return opts.allowLoopback ? null : 'Loopback';
  if (v4 === '::') return 'ungültige Adresse';
  if (/^fe[89ab]/.test(v4)) return 'Link-Local';
  if (v4.startsWith('ff')) return 'Multicast';
  if (v4 === 'fd00:ec2::254') return 'Metadaten-Dienst';
  if (/^f[cd]/.test(v4) && !opts.allowPrivate) return 'privates Netz';
  return null;
}

/** Gesperrter Hostname (eigene Dienste)? */
export function blockedHostname(host: string, opts: Pick<GuardOptions, 'allowLoopback'>): string | null {
  const h = host.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (opts.allowLoopback) return null;
  if (INTERNAL_HOSTNAMES.includes(h) || h.endsWith('.localhost')) return `interner Dienstname „${h}“`;
  return null;
}

export class BlockedAddressError extends Error {}

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

export function guardedLookup(opts: GuardOptions) {
  return (hostname: string, options: { all?: boolean; family?: number } | number, cb: LookupCb) => {
    const o = typeof options === 'number' ? { family: options } : options ?? {};
    dnsLookup(hostname, { family: o.family as 0 | 4 | 6 | undefined, all: true }, (err, addrs) => {
      if (err) return cb(err, '', 0);
      const list = addrs as LookupAddress[];
      for (const a of list) {
        const why = blockedAddress(a.address, opts);
        if (why) return cb(new BlockedAddressError(`Adresse ${a.address} von ${hostname} ist gesperrt (${why})`), '', 0);
      }
      if (!list.length) return cb(new Error(`${hostname} nicht auflösbar`), '', 0);
      if (o.all) return cb(null, list);
      cb(null, list[0].address, list[0].family);
    });
  };
}

/** fetch-kompatible Funktion mit IP-Prüfung beim Verbindungsaufbau. */
export function guardedFetch(opts: GuardOptions): typeof fetch {
  const maxBytes = opts.maxBytes ?? 32 * 1024 * 1024;
  const lookup = guardedLookup(opts);
  const fn = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new TypeError('Nur http(s) erlaubt');
    if (url.username || url.password) throw new TypeError('Zugangsdaten in der URL sind nicht erlaubt');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const hostProblem = blockedHostname(host, opts) ?? (isIP(host) ? blockedAddress(host, opts) : null);
    if (hostProblem) throw new BlockedAddressError(`Ziel ${host} ist gesperrt (${hostProblem})`);

    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => { headers[k] = v; });
    const body = init.body === undefined || init.body === null ? undefined : typeof init.body === 'string' ? init.body : Buffer.from(init.body as ArrayBuffer);
    if (body !== undefined) headers['content-length'] = String(Buffer.byteLength(body));
    const method = (init.method ?? 'GET').toUpperCase();
    const mod = url.protocol === 'https:' ? https : http;

    return await new Promise<Response>((resolve, reject) => {
      const req = mod.request(url, { method, headers, lookup: lookup as any, signal: init.signal ?? undefined, agent: false }, (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          reject(new TypeError(`Weiterleitung (${status}) wird nicht verfolgt`));
          return;
        }
        const h = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (v === undefined) continue;
          for (const x of Array.isArray(v) ? v : [v]) h.append(k, x);
        }
        let seen = 0;
        res.on('data', (chunk: Buffer) => {
          seen += chunk.length;
          if (seen > maxBytes) res.destroy(new Error('Antwort zu groß'));
        });
        const noBody = method === 'HEAD' || status === 204 || status === 304;
        resolve(new Response(noBody ? null : (Readable.toWeb(res) as ReadableStream), { status, statusText: res.statusMessage, headers: h }));
      });
      req.on('error', reject);
      if (body !== undefined) req.write(body);
      req.end();
    });
  };
  return fn as typeof fetch;
}
