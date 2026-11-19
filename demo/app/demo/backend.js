// Simulator für die statische Demo (GitHub Pages).
// Beantwortet die API-Aufrufe der Oberfläche aus aufgezeichneten Antworten (demo-data.json,
// erzeugt von tools/build-pages.ts aus der lokalen Demo). Änderungen leben nur im Browser-Tab.
                                                 

                                                    
                                                                                                              

                

const PASSWORD = 'Demo-Passwort-2026!';

/** Schlüssel einer Anfrage: Methode, Pfad und sortierte Parameter (ohne "refresh"). */
export function requestKey(method        , path        )         {
  const u = new URL(path, 'http://demo');
  const params = [...u.searchParams.entries()].filter(([k]) => k !== 'refresh').sort(([a], [b]) => a.localeCompare(b));
  const q = new URLSearchParams(params).toString();
  return `${method.toUpperCase()} ${u.pathname}${q ? `?${q}` : ''}`;
}

/** Zeitangaben so verschieben, als wären die Daten eben erst aufgezeichnet worden. */
function shiftTimes(v      , delta        , key = '')       {
  if (Array.isArray(v)) return v.map((x) => shiftTimes(x, delta));
  if (v && typeof v === 'object') {
    const out       = {};
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

function sniffMime(b64        )         {
  if (b64.startsWith('iVBOR')) return 'image/png';
  if (b64.startsWith('/9j/')) return 'image/jpeg';
  if (b64.startsWith('UklGR')) return 'image/webp';
  return 'image/svg+xml';
}

export async function createDemoBackend()                       {
  const res = await fetch(new URL('demo-data.json', document.baseURI));
  if (!res.ok) throw new Error('Demo-Daten fehlen');
  const raw = (await res.json())            ;
  const delta = Date.now() - raw.recordedAt;
  const responses                           = {};
  for (const [k, r] of Object.entries(raw.responses)) responses[k] = { status: r.status, data: shiftTimes(r.data, delta) };
  const assets = { ...raw.assets };

  let loggedIn = true;
  let counter = 0;
  const pending                         = {};
  const requests         = [];
  const replies                         = {};
  const decided = new Map              ();
  const withdrawn = new Set        ();
  const readIds = new Set        ();
  let readAll = false;
  let readCount = 0;

  const ok = (data       = { ok: true }, status = 200) => ({ status, data });
  const fail = (status        , error        , code        ) => ({ status, data: { error, code } });
  const recorded = (key        ) => responses[key];

  async function request(method        , path        , body      )                                             {
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

    if (m === 'GET' && p === '/api/portal/people') {
      // Vorschläge aus einer Aufzeichnung, hier im Browser gefiltert
      const q = (new URL(path, 'http://demo').searchParams.get('q') ?? '').toLowerCase();
      const all = (recorded('GET /api/portal/people?q=example')?.data        )?.people ?? [];
      return ok({ people: q.length < 2 ? [] : all.filter((x      ) => `${x.name} ${x.email}`.toLowerCase().includes(q)) });
    }
    if (m === 'GET' && p === '/api/portal/notifications/count') {
      const r = recorded(key)?.data        ;
      return ok({ unread: readAll ? 0 : Math.max(0, (r?.unread ?? 0) - readCount), approvalsOpen: Math.max(0, (r?.approvalsOpen ?? 0) - decided.size) });
    }
    if (m === 'GET') {
      const r = recorded(key);
      if (!r) return fail(404, 'Diese Ansicht ist in der Demo nicht enthalten.', 'not_found');
      let data       = r.data;
      if (p === '/api/me') data = { ...data, stepupValidUntil: Date.now() + 365 * 86400_000, sessionExpiresAt: Date.now() + 8 * 3600_000 };
      const tickets = /^\/api\/portal\/systems\/([^/]+)\/tickets$/.exec(p);
      if (tickets && data && Array.isArray(data.pending)) data = { ...data, pending: [...(pending[tickets[1]] ?? []), ...data.pending] };
      if (p === '/api/portal/requests' && data && Array.isArray(data.requests)) {
        data = { ...data, requests: [...requests, ...data.requests].map((x      ) => withdrawn.has(x.id) ? { ...x, status: 'withdrawn' } : x) };
      }
      if (p === '/api/portal/approvals' && data && Array.isArray(data.approvals)) {
        const open = new URL(path, 'http://demo').searchParams.get('status') !== 'done';
        data = { ...data, open: Math.max(0, data.open - decided.size), approvals: open ? data.approvals.filter((a      ) => !decided.has(a.id)) : [...[...decided.values()], ...data.approvals] };
      }
      const appr = /^\/api\/portal\/approvals\/([^/]+)$/.exec(p);
      if (appr && decided.has(appr[1])) data = { ...data, approval: decided.get(appr[1]), summary: null, files: [] };
      if (p === '/api/portal/notifications' && data && Array.isArray(data.notifications)) {
        data = { ...data, unread: readAll ? 0 : Math.max(0, data.unread - readCount), approvalsOpen: Math.max(0, data.approvalsOpen - decided.size), notifications: data.notifications.map((n      ) => readAll || readIds.has(n.id) ? { ...n, read: true } : n) };
      }
      const detail = /^\/api\/portal\/systems\/[^/]+\/tickets\/[^/]+$/.exec(p);
      if (detail && data && Array.isArray(data.articles)) data = { ...data, articles: [...data.articles, ...(replies[p] ?? [])] };
      return { status: r.status, data };
    }

    // ---------------------------------------------------------------- Ändernde Aufrufe (nur in diesem Tab)
    const submit = /^\/api\/portal\/forms\/([^/]+)\/submit$/.exec(p);
    if (submit) {
      const form = recorded(requestKey('GET', `/api/portal/forms/${submit[1]}`))?.data        ;
      const sys = form?.system ?? {};
      const title = `${form?.form?.name ?? 'Anfrage'}: ${String(body?.values?.betreff ?? body?.values?.beschreibung ?? 'Demo-Anfrage').slice(0, 60)}`;
      const id = `demo-${++counter}`;
      const fields         = form?.definition?.fields ?? [];
      const approverField = fields.find((f) => f.type === 'approver' && (!f.visibleIf || String(body?.values?.[f.visibleIf.field] ?? '') === String(f.visibleIf.value ?? '')));
      const approverEmail = approverField ? String(body?.values?.[approverField.id] ?? '').trim().toLowerCase() : '';
      const status = approverEmail ? 'awaiting_approval' : 'queued';
      const approval = approverEmail ? { approverEmail, approverName: null, status: 'pending', decidedAt: null, decidedByName: null, expiresAt: Date.now() + 14 * 86400_000, comment: null, known: true } : null;
      (pending[sys.id] ??= []).unshift({ id, title, status, created_at: Date.now() });
      requests.unshift({ id, systemName: sys.name, system_id: sys.id, title, status, ticket_number: null, ticket_id: null, created_at: Date.now(), approval });
      return ok({ id, title, successText: form?.definition?.settings?.successText || 'Danke! In der Demo wird nichts an Zammad gesendet.', approval: approverEmail ? { email: approverEmail, name: null, known: true } : null }, 201);
    }
    const decision = /^\/api\/portal\/approvals\/([^/]+)\/(approve|reject)$/.exec(p);
    if (decision) {
      const d = recorded(requestKey('GET', `/api/portal/approvals/${decision[1]}`))?.data        ;
      if (decision[2] === 'reject' && !String(body?.comment ?? '').trim()) return fail(422, 'Bitte kurz begründen, warum Sie ablehnen', 'validation');
      if (d?.approval) decided.set(decision[1], { ...d.approval, status: decision[2] === 'approve' ? 'approved' : 'rejected', decidedAt: Date.now(), decidedByName: 'Alex Berger', comment: String(body?.comment ?? '') || null });
      return ok({ status: decision[2] === 'approve' ? 'approved' : 'rejected' });
    }
    const wd = /^\/api\/portal\/requests\/([^/]+)\/withdraw$/.exec(p);
    if (wd) { withdrawn.add(wd[1]); return ok(); }
    if (p === '/api/portal/notifications/read') {
      if (Array.isArray(body?.ids)) for (const i of body.ids) { if (!readIds.has(i)) { readIds.add(i); readCount++; } } else readAll = true;
      return ok({ marked: 1, unread: 0 });
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
    if (p.startsWith('/api/admin/transfer/') || p.endsWith('/forms/import')) return fail(409, 'Export und Import gehen in der Demo nicht.', 'demo');
    if (m === 'POST' && /\/(forms|copy)$/.test(p)) return fail(409, 'Neue Formulare anlegen geht in der Demo nicht – bestehende lassen sich öffnen und bearbeiten.', 'demo');
    return ok({ ok: true });
  }

  return { request, asset: (id        ) => assets[id] ?? '' };
}
