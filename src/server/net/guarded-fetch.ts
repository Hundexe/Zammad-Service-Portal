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
import { BlockList, isIP } from 'node:net';
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
  /** Zusätzliche vertrauenswürdige Stammzertifikate (PEM), z. B. interne CA – sonst die des Systems bzw. NODE_EXTRA_CA_CERTS */
  ca?: string | Buffer;
  /** Zusätzlich gesperrte Netze (z. B. die eigenen Docker-Netze), CIDR-Liste */
  blockedCidrs?: string[];
  /** Wenn gesetzt: nur diese Hostnamen (exakt oder „.domain“ für alle Unterdomains) */
  allowedHosts?: string[];
  /** Höchstdauer für Namensauflösung und Verbindungsaufbau (Standard 5 s) – unabhängig von der Gesamtdauer */
  connectTimeoutMs?: number;
}

type AddrOpts = Pick<GuardOptions, 'allowPrivate' | 'allowLoopback' | 'blockedCidrs'>;

const blockLists = new Map<string, BlockList>();
function extraBlocked(ip: string, cidrs: string[] | undefined): boolean {
  if (!cidrs?.length) return false;
  const key = cidrs.join(',');
  let bl = blockLists.get(key);
  if (!bl) {
    bl = new BlockList();
    for (const c of cidrs) {
      const [addr, bits] = c.split('/');
      const type = isIP(addr) === 6 ? 'ipv6' : 'ipv4';
      bl.addSubnet(addr, Number(bits ?? (type === 'ipv4' ? 32 : 128)), type);
    }
    blockLists.set(key, bl);
  }
  const plain = ip.replace(/^\[|\]$/g, '').replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, '$1');
  return isIP(plain) === 4 ? bl.check(plain, 'ipv4') : isIP(plain) === 6 ? bl.check(plain, 'ipv6') : false;
}

/** Hostname erlaubt? (Allowlist leer = alle) */
export function hostAllowed(host: string, allowed: string[] | undefined): boolean {
  if (!allowed?.length) return true;
  const h = host.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  return allowed.some((a) => { const x = a.toLowerCase(); return x.startsWith('.') ? h.endsWith(x) || h === x.slice(1) : h === x; });
}

/** IPv6-Adresse als 16 Bytes (auch mit eingebetteter IPv4 am Ende, z. B. ::ffff:127.0.0.1); null, wenn ungültig. */
export function ipv6Bytes(ip: string): Uint8Array | null {
  let s = ip.replace(/^\[|\]$/g, '').toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  if (isIP(s) !== 6) return null;
  const tail: number[] = [];
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) {
    const [a, b, c, d] = dotted[1].split('.').map(Number);
    tail.push((a << 8) | b, (c << 8) | d);
    s = s.slice(0, -dotted[1].length);
    if (!s.endsWith('::')) s = s.slice(0, -1); // abschließenden Doppelpunkt vor der IPv4 entfernen
  }
  const [headS, restS] = s.includes('::') ? s.split('::') : [s, null];
  const parse = (x: string) => (x ? x.split(':').filter((p) => p !== '').map((h) => Number.parseInt(h, 16)) : []);
  const head = parse(headS);
  const rest = restS === null ? [] : parse(restS);
  const fill = 8 - tail.length - head.length - rest.length;
  if (restS === null && fill !== 0) return null;
  if (fill < 0) return null;
  const words = [...head, ...Array(restS === null ? 0 : fill).fill(0), ...rest, ...tail];
  if (words.length !== 8 || words.some((w) => !(w >= 0 && w <= 0xffff))) return null;
  const out = new Uint8Array(16);
  words.forEach((w, i) => { out[2 * i] = w >> 8; out[2 * i + 1] = w & 0xff; });
  return out;
}

function v4Reason(a: number, b: number, opts: AddrOpts): string | null {
  if (a === 127) return opts.allowLoopback ? null : 'Loopback';
  if (a === 169 && b === 254) return 'Link-Local / Metadaten-Dienst';
  if (a === 0) return 'ungültige Adresse';
  if (a >= 224) return 'Multicast / reserviert';
  if (a === 198 && (b === 18 || b === 19)) return 'reserviert (Benchmark-Netz)';
  const priv = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0);
  if (priv && !opts.allowPrivate) return 'privates Netz';
  return null;
}

/**
 * Grund, warum eine Adresse gesperrt ist – oder null, wenn sie erlaubt ist.
 * IPv6 wird vollständig ausgewertet: Adressen, die eine IPv4-Adresse einbetten (IPv4-mapped ::ffff:0:0/96,
 * IPv4-kompatibel ::/96, IPv4-translated ::ffff:0:0:0/96, NAT64 64:ff9b::/96 und 64:ff9b:1::/48, 6to4 2002::/16),
 * werden nach der eingebetteten IPv4-Adresse beurteilt – in jeder Schreibweise (::ffff:7f00:1 = 127.0.0.1).
 * Teredo (2001::/32) und Dokumentationsadressen werden gesperrt, weil ihr Ziel nicht prüfbar bzw. nicht echt ist.
 */
export function blockedAddress(ip: string, opts: AddrOpts): string | null {
  const raw = ip.replace(/^\[|\]$/g, '').toLowerCase();
  if (extraBlocked(raw, opts.blockedCidrs)) return 'gesperrtes Netz (TICKET_URL_BLOCKED_CIDRS)';
  if (isIP(raw) === 4) {
    const [a, b] = raw.split('.').map(Number);
    return v4Reason(a, b, opts);
  }
  const x = ipv6Bytes(raw);
  if (!x) return 'keine IP-Adresse';
  const zero = (from: number, to: number) => x.slice(from, to).every((v) => v === 0);
  const embedded = (at: number): string | null => {
    const why = v4Reason(x[at], x[at + 1], opts);
    return why ? `${why} (eingebettete IPv4 ${x[at]}.${x[at + 1]}.${x[at + 2]}.${x[at + 3]})` : null;
  };
  if (zero(0, 16)) return 'ungültige Adresse';
  if (zero(0, 15) && x[15] === 1) return opts.allowLoopback ? null : 'Loopback';
  if (zero(0, 10) && x[10] === 0xff && x[11] === 0xff) return embedded(12);          // ::ffff:a.b.c.d
  if (zero(0, 8) && x[8] === 0xff && x[9] === 0xff && zero(10, 12)) return embedded(12); // ::ffff:0:a.b.c.d
  if (zero(0, 12)) return embedded(12);                                              // ::a.b.c.d
  if (x[0] === 0x00 && x[1] === 0x64 && x[2] === 0xff && x[3] === 0x9b) {             // NAT64
    if (zero(4, 12)) return embedded(12);
    if (x[4] === 0 && x[5] === 1) return 'NAT64 (lokales Präfix)';
  }
  if (x[0] === 0x20 && x[1] === 0x02) return embedded(2);                            // 6to4
  if (x[0] === 0x20 && x[1] === 0x01 && x[2] === 0 && x[3] === 0) return 'Teredo';
  if (x[0] === 0x20 && x[1] === 0x01 && x[2] === 0x0d && x[3] === 0xb8) return 'Dokumentationsadresse';
  if (x[0] === 0xfe && (x[1] & 0xc0) === 0x80) return 'Link-Local';
  if (x[0] === 0xff) return 'Multicast';
  if (x[0] === 0xfd && x[1] === 0x00 && x[2] === 0x0e && x[3] === 0xc2 && zero(4, 14) && x[14] === 0x02 && x[15] === 0x54) return 'Metadaten-Dienst';
  if (x[0] === 0xfe && (x[1] & 0xc0) === 0xc0 && !opts.allowPrivate) return 'privates Netz (site-local)';
  if ((x[0] & 0xfe) === 0xfc && !opts.allowPrivate) return 'privates Netz';
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
    const hostProblem = (hostAllowed(host, opts.allowedHosts) ? null : 'nicht in TICKET_URL_ALLOWED_HOSTS') ?? blockedHostname(host, opts) ?? (isIP(host) ? blockedAddress(host, opts) : null);
    if (hostProblem) throw new BlockedAddressError(`Ziel ${host} ist gesperrt (${hostProblem})`);

    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => { headers[k] = v; });
    const body = init.body === undefined || init.body === null ? undefined : typeof init.body === 'string' ? init.body : Buffer.from(init.body as ArrayBuffer);
    if (body !== undefined) headers['content-length'] = String(Buffer.byteLength(body));
    const method = (init.method ?? 'GET').toUpperCase();
    const mod = url.protocol === 'https:' ? https : http;

    return await new Promise<Response>((resolve, reject) => {
      // TLS: Zertifikat und Hostname werden immer geprüft (rejectUnauthorized bleibt an). Bei einem Namen geht er
      // als SNI mit und muss im Zertifikat stehen – auch wenn die Verbindung zur vorher geprüften IP geht.
      // Bei einer IP-Adresse in der URL wird kein SNI gesendet und die IP muss als IP-SAN im Zertifikat stehen.
      const tlsOpts = url.protocol === 'https:'
        ? { rejectUnauthorized: true, ...(isIP(host) ? {} : { servername: host }), ...(opts.ca ? { ca: opts.ca } : {}) }
        : {};
      const req = mod.request(url, { method, headers, lookup: lookup as any, signal: init.signal ?? undefined, agent: false, ...tlsOpts }, (res) => {
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
      // Nicht erreichbarer Server (Pakete werden verworfen) soll nicht erst nach der Gesamtzeit auffallen
      req.on('socket', (sock) => {
        if (!sock.connecting) return;
        const timer = setTimeout(() => req.destroy(new Error(`Verbindungsaufbau zu ${host} dauert zu lange`)), opts.connectTimeoutMs ?? 5000);
        sock.once(url.protocol === 'https:' ? 'secureConnect' : 'connect', () => clearTimeout(timer));
        req.once('close', () => clearTimeout(timer));
      });
      req.on('error', reject);
      if (body !== undefined) req.write(body);
      req.end();
    });
  };
  return fn as typeof fetch;
}
