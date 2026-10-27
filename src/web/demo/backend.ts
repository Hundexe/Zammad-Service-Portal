// Simulator für die statische Demo (GitHub Pages).
// Beantwortet die API-Aufrufe der Oberfläche aus aufgezeichneten Antworten (demo-data.json,
// erzeugt von tools/build-pages.ts aus der lokalen Demo). Änderungen leben nur im Browser-Tab.
import type { DemoBackend } from '../lib/env.ts';

interface Recorded { status: number; data: unknown }
interface DemoData { recordedAt: number; responses: Record<string, Recorded>; assets: Record<string, string> }

type Json = any;

const PASSWORD = 'Demo-Passwort-2026!';

/** Schlüssel einer Anfrage: Methode, Pfad und sortierte Parameter (ohne "refresh"). */
export function requestKey(method: string, path: string): string {
  const u = new URL(path, 'http://demo');
  const params = [...u.searchParams.entries()].filter(([k]) => k !== 'refresh').sort(([a], [b]) => a.localeCompare(b));
  const q = new URLSearchParams(params).toString();
  return `${method.toUpperCase()} ${u.pathname}${q ? `?${q}` : ''}`;
}

/** Zeitangaben so verschieben, als wären die Daten eben erst aufgezeichnet worden. */
function shiftTimes(v: Json, delta: number, key = ''): Json {
  if (Array.isArray(v)) return v.map((x) => shiftTimes(x, delta));
  if (v && typeof v === 'object') {
    const out: Json = {};
    for (const [k, x] of Object.entries(v)) out[k] = shiftTimes(x, delta, k);
    return out;
  }
  if (!/(At|_at|Until)$/.test(key)) return v;
  if (typeof v === 'number' && v > 1e12) return v + delta;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) {
    const t = Date.parse(v);
    return Number.isNaN(t) ? v : new Date(t + delta).toISOString();
  }
  return v;
}

function sniffMime(b64: string): string {
  if (b64.startsWith('iVBOR')) return 'image/png';
  if (b64.startsWith('/9j/')) return 'image/jpeg';
  if (b64.startsWith('UklGR')) return 'image/webp';
  return 'image/svg+xml';
}

export async function createDemoBackend(): Promise<DemoBackend> {
  const res = await fetch(new URL('demo-data.json', document.baseURI));
  if (!res.ok) throw new Error('Demo-Daten fehlen');
  const raw = (await res.json()) as DemoData;
  const delta = Date.now() - raw.recordedAt;
  const responses: Record<string, Recorded> = {};
  for (const [k, r] of Object.entries(raw.responses)) responses[k] = { status: r.status, data: shiftTimes(r.data, delta) };
  const assets = { ...raw.assets };

  let loggedIn = true;
  let counter = 0;
  const pending: Record<string, Json[]> = {};
  const requests: Json[] = [];
  const replies: Record<string, Json[]> = {};

  const ok = (data: Json = { ok: true }, status = 200) => ({ status, data });
  const fail = (status: number, error: string, code: string) => ({ status, data: { error, code } });
  const recorded = (key: string) => responses[key];

  async function request(method: string, path: string, body: Json): Promise<{ status: number; data: unknown }> {
    await new Promise((r) => setTimeout(r, 60)); // wie ein echter Server: kurz warten
    const key = requestKey(method, path);
    const p = new URL(path, 'http://demo').pathname;
    const m = method.toUpperCase();

    // ---------------------------------------------------------------- Anmeldung
    if (p === '/api/demo/login') { loggedIn = true; return ok(); }
    if (p === '/api/auth/logout') { loggedIn = false; return ok({ ok: true, redirect: null }); }
    if (p === '/api/auth/local/login') return fail(401, 'In der Demo bitte „Mit Microsoft anmelden“ verwenden – das meldet ohne Passwort als Demo-Admin an.', 'demo');
    if (p === '/api/auth/stepup') return ok({ ok: true, stepupValidUntil: Date.now() + 3600_000 });
    if (!loggedIn && !p.startsWith('/api/public/')) return fail(401, 'Bitte anmelden', 'unauthenticated');

    if (m === 'GET') {
      const r = recorded(key);
      if (!r) return fail(404, 'Diese Ansicht ist in der Demo nicht enthalten.', 'not_found');
      let data: Json = r.data;
      if (p === '/api/me') data = { ...data, stepupValidUntil: Date.now() + 365 * 86400_000, sessionExpiresAt: Date.now() + 8 * 3600_000 };
      const tickets = /^\/api\/portal\/systems\/([^/]+)\/tickets$/.exec(p);
      if (tickets && data && Array.isArray(data.pending)) data = { ...data, pending: [...(pending[tickets[1]] ?? []), ...data.pending] };
      if (p === '/api/portal/requests' && data && Array.isArray(data.requests)) data = { ...data, requests: [...requests, ...data.requests] };
      const detail = /^\/api\/portal\/systems\/[^/]+\/tickets\/[^/]+$/.exec(p);
      if (detail && data && Array.isArray(data.articles)) data = { ...data, articles: [...data.articles, ...(replies[p] ?? [])] };
      return { status: r.status, data };
    }

    // ---------------------------------------------------------------- Ändernde Aufrufe (nur in diesem Tab)
    const submit = /^\/api\/portal\/forms\/([^/]+)\/submit$/.exec(p);
    if (submit) {
      const form = recorded(requestKey('GET', `/api/portal/forms/${submit[1]}`))?.data as Json;
      const sys = form?.system ?? {};
      const title = `${form?.form?.name ?? 'Anfrage'}: ${String(body?.values?.betreff ?? body?.values?.beschreibung ?? 'Demo-Anfrage').slice(0, 60)}`;
      const id = `demo-${++counter}`;
      (pending[sys.id] ??= []).unshift({ id, title, status: 'queued', created_at: Date.now() });
      requests.unshift({ id, systemName: sys.name, system_id: sys.id, title, status: 'queued', ticket_number: null, ticket_id: null, created_at: Date.now() });
      return ok({ id, title, successText: form?.definition?.settings?.successText || 'Danke! In der Demo wird nichts an Zammad gesendet.' }, 201);
    }
    const reply = /^(\/api\/portal\/systems\/[^/]+\/tickets\/[^/]+)\/reply$/.exec(p);
    if (reply) {
      (replies[reply[1]] ??= []).push({ id: 900000 + ++counter, from: 'Sie', sender: 'Customer', createdAt: new Date().toISOString(), text: String(body?.text ?? ''), attachments: [] });
      return ok();
    }
    if (p === '/api/admin/users' && m === 'POST') return ok({ created: true, id: `demo-user-${++counter}`, username: body?.username ?? 'neu', password: PASSWORD }, 201);
    if (/\/reset-password$/.test(p)) return ok({ username: 'benutzer', password: PASSWORD });
    if (/^\/api\/admin\/systems\/[^/]+\/test$/.test(p)) return ok({ ok: true, user: 'service-portal@zammad.demo', version: '6.5' });
    if (/\/publish$/.test(p)) return ok({ status: 'published' });
    if (m === 'POST' && body && typeof body.data === 'string' && typeof body.kind === 'string') {
      const id = `demo-asset-${++counter}`;
      assets[id] = `data:${sniffMime(body.data)};base64,${body.data}`;
      return ok({ created: true, id }, 201);
    }
    if (m === 'POST' && /\/(forms|copy)$/.test(p)) return fail(409, 'Neue Formulare anlegen geht in der Demo nicht – bestehende lassen sich öffnen und bearbeiten.', 'demo');
    return ok({ ok: true });
  }

  return { request, asset: (id: string) => assets[id] ?? '' };
}
