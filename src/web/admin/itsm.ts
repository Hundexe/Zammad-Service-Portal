// Verwaltung: Funktionen ein- und ausschalten; Status und Störungen – eine Seite für alle Ticketsysteme.
import { h, icon, mount, fmtDate, relTime, type Child } from '../lib/dom.ts';
import { ApiError, del, get, post, put } from '../lib/api.ts';
import { curPath, link, loadMe, navigate, setUrl } from '../lib/app.ts';
import { badge, button, checkbox, confirmDialog, copyButton, dialog, emptyState, errorText, fieldWrap, input, listInput, notice, pageHead, select, table, tabs, textarea, toast } from '../lib/ui.ts';
import {
  INCIDENT_IMPACTS, INCIDENT_STATES, INCIDENT_STATE_LABEL, PROBLEM_STATES, PROBLEM_STATE_LABEL, SERVICE_STATUS_LABEL,
  type FeatureInfo, type Features, type IncidentState, type ProblemState, type ServiceStatus,
} from '../../shared/itsm.ts';
import { statusPill, type PublicIncident, type PublicMaintenance } from '../pages/status.ts';

// ------------------------------------------------------------------------------------------ Funktionen

export async function featuresPage(): Promise<Child> {
  const r = await get<{ features: Features; info: FeatureInfo[] }>('/api/admin/settings/features');
  const f: Features = { ...r.features, locations: [...r.features.locations] };
  const msg = h('div', { attrs: { 'aria-live': 'polite' } });
  const row = (info: FeatureInfo) => {
    const id = `feat-${info.key}`;
    const box = h('input', { id, class: 'toggle-input', attrs: { type: 'checkbox', role: 'switch', 'aria-describedby': `${id}-d` } });
    box.checked = f[info.key];
    box.addEventListener('change', () => { f[info.key] = box.checked; });
    return h('li', { class: 'feature' },
      h('label', { class: 'feature-label', attrs: { for: id } }, h('span', { class: 'feature-name' }, info.label), h('span', { class: 'feature-desc', id: `${id}-d` }, info.description)),
      h('span', { class: 'toggle-switch' }, box, h('span', { class: 'toggle-track', attrs: { 'aria-hidden': 'true' } })));
  };
  return h('div', null,
    pageHead('Funktionen', 'Was das Portal anbietet. Ausgeschaltete Funktionen verschwinden aus Portal und Verwaltung, der Server lehnt sie ab.'),
    msg,
    h('section', { class: 'panel' },
      h('h2', null, 'Status und Störungen'),
      h('p', { class: 'muted small' }, 'Zammad bleibt das führende System für Tickets. Das Portal zeigt den Zustand der Services, sammelt „Ich bin auch betroffen“ statt doppelter Tickets und markiert Tickets in Zammad mit Tags (inc-0001, prb-0001).'),
      h('ul', { class: 'feature-list' }, ...r.info.filter((i) => i.group === 'itsm').map(row)),
      h('div', { class: 'grid-2' },
        fieldWrap(listInput(f.locations, (x) => { f.locations = x; }, 'z. B. Zentrale\nStandort Nord'), { label: 'Standorte', help: 'Bei Störungen und Wartungen auswählbar. Eine pro Zeile.' }),
        h('div', { class: 'stack' },
          checkbox(f.showAffectedCount, 'Anzahl der Betroffenen im Portal zeigen', (x) => { f.showAffectedCount = x; }),
          checkbox(f.notifyAllOnMajor, 'Bei großen Störungen alle benachrichtigen', (x) => { f.notifyAllOnMajor = x; }, 'Alle, die das Ticketsystem sehen und sich in den letzten 90 Tagen angemeldet haben, bekommen eine Nachricht unter der Glocke. Sonst nur Banner.')))),
    h('section', { class: 'panel' },
      h('h2', null, 'Anfragen'),
      h('ul', { class: 'feature-list' }, ...r.info.filter((i) => i.group === 'requests').map(row))),
    h('section', { class: 'panel' },
      h('h2', null, 'Portal als App'),
      h('ul', { class: 'feature-list' }, ...r.info.filter((i) => i.group === 'portal').map(row)),
      await intunePanel()),
    h('div', { class: 'form-actions sticky' }, button('Speichern', async () => {
      try {
        await put('/api/admin/settings/features', { features: f });
        await loadMe();
        toast('Gespeichert');
        navigate(curPath(), true);
      } catch (err) { mount(msg, notice('error', errorText(err))); window.scrollTo({ top: 0 }); }
    }, { kind: 'primary' })));
}

/** Verteilung per Intune: fertiger Wert für die Edge-Richtlinie „WebAppInstallForceList“ */
async function intunePanel(): Promise<HTMLElement> {
  const a = await get<{ enabled: boolean; url: string; name: string; policy: string; policyDesktop: string }>('/api/admin/settings/app');
  let desktop = false;
  const code = h('pre', { class: 'policy-json', attrs: { 'aria-label': 'Wert für die Richtlinie' } });
  const copyHost = h('span');
  const draw = () => {
    const v = desktop ? a.policyDesktop : a.policy;
    code.textContent = v;
    mount(copyHost, copyButton(v, 'Wert kopieren'));
  };
  draw();
  return h('details', { class: 'intune', attrs: a.enabled ? { open: '' } : {} },
    h('summary', null, icon('laptop', 16), 'Per Intune auf alle Geräte verteilen'),
    h('div', { class: 'intune-body' },
      h('p', { class: 'muted small' }, 'Edge (und Chrome) installieren das Portal dann ohne Zutun als App – mit Symbol im Startmenü, auf Wunsch auch auf dem Desktop. Die Mitarbeitenden können die App nicht entfernen; wer aus der Zuweisung fällt, verliert sie wieder.'),
      h('ol', { class: 'steps' },
        h('li', null, 'Intune Admin Center › Geräte › Windows › Konfiguration › ', h('strong', null, 'Erstellen'), ' › Neue Richtlinie: Plattform „Windows 10 und höher“, Profiltyp „Einstellungskatalog“.'),
        h('li', null, 'Einstellungen hinzufügen › nach ', h('code', null, 'WebAppInstallForceList'), ' suchen › Kategorie „Microsoft Edge“ › ', h('strong', null, 'Configure list of force-installed Web Apps'), ' (Geräteeinstellung).'),
        h('li', null, 'Einstellung aktivieren und den Wert unten in das Textfeld darunter einfügen.'),
        h('li', null, 'Gruppen zuweisen und speichern. Die App erscheint nach der nächsten Synchronisierung, spätestens nach einem Neustart von Edge.')),
      h('div', { class: 'stack' },
        checkbox(false, 'Zusätzlich eine Verknüpfung auf dem Desktop anlegen', (x) => { desktop = x; draw(); }),
        code,
        h('div', { class: 'row' }, copyHost, h('span', { class: 'muted small' }, `Adresse: ${a.url}`))),
      a.enabled ? null : notice('warn', 'Zum Verteilen muss „Als App installierbar“ eingeschaltet und gespeichert sein.')));
}

// ------------------------------------------------------------------------------------------ Daten

interface Sys { id: string; name: string; canStatus: boolean; canProblems: boolean }
interface Svc { id: string; systemId: string; name: string; description: string; manualStatus: ServiceStatus | null; manualNote: string; sort: number; status: ServiceStatus; note: string }
interface AdminIncident extends PublicIncident { problemId: string | null; zammadTicket: string | null; tag: string }
interface AdminProblem {
  id: string; number: string; tag: string; systemId: string; systemName: string; title: string; state: ProblemState; serviceId: string | null;
  description: string; rootCause: string; workaround: string; public: boolean; owner: string; updatedAt: number; createdAt: number; tickets: number;
  incidents: { id: string; number: string; title: string; state: string }[];
}
interface Data { features: Features; systems: Sys[]; services: Svc[]; incidents: AdminIncident[]; maintenances: (PublicMaintenance & { cancelled: boolean })[]; problems: AdminProblem[] }

const IMPACT_LABEL: Record<string, string> = { degraded: 'Eingeschränkt', partial_outage: 'Teilausfall', major_outage: 'Ausfall' };
/** Zeitpunkt für <input type="datetime-local"> in Ortszeit */
const toLocal = (ms: number) => { const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000); return d.toISOString().slice(0, 16); };
const fromLocal = (v: string) => (v ? new Date(v).getTime() : null);
const errorsOf = (err: unknown) => (err instanceof ApiError && err.details && typeof err.details === 'object' && !Array.isArray(err.details) ? err.details as Record<string, string> : {});

function multiCheck(options: { value: string; label: string }[], selected: string[], onChange: (v: string[]) => void, emptyText: string): HTMLElement {
  if (!options.length) return h('p', { class: 'muted small' }, emptyText);
  const set = new Set(selected);
  return h('div', { class: 'value-grid' }, ...options.map((o) => checkbox(set.has(o.value), o.label, (x) => { x ? set.add(o.value) : set.delete(o.value); onChange([...set]); })));
}

// ------------------------------------------------------------------------------------------ Dialoge

async function incidentDialog(d: Data, existing?: AdminIncident): Promise<boolean> {
  const systems = d.systems.filter((s) => s.canStatus);
  const v = {
    systemId: existing?.systemId ?? systems[0]?.id ?? '', title: existing?.title ?? '', body: '', impact: existing?.impact ?? 'degraded', major: existing?.major ?? false,
    serviceIds: existing?.services ?? [], locations: existing?.locations ?? [], startedAt: toLocal(existing?.startedAt ?? Date.now()), zammadTicket: existing?.zammadTicket ?? '',
  };
  const svcHost = h('div');
  const drawSvc = () => mount(svcHost, multiCheck(d.services.filter((s) => s.systemId === v.systemId).map((s) => ({ value: s.id, label: s.name })), v.serviceIds, (x) => { v.serviceIds = x; }, 'Für dieses Ticketsystem gibt es noch keine Services (Reiter „Services“).'));
  drawSvc();
  const msg = h('div');
  const body = h('div', { class: 'stack' }, msg,
    !existing && systems.length > 1 ? fieldWrap(select(v.systemId, systems.map((s) => ({ value: s.id, label: s.name })), (x) => { v.systemId = x; v.serviceIds = []; drawSvc(); }), { label: 'Ticketsystem' }) : null,
    fieldWrap(input(v.title, (x) => { v.title = x; }, { maxlength: 200, placeholder: 'z. B. SAP nicht erreichbar' }), { label: 'Titel', required: true }),
    !existing ? fieldWrap(textarea(v.body, (x) => { v.body = x; }, { rows: 3, placeholder: 'Was ist los, was sollen die Mitarbeitenden tun?' }), { label: 'Erste Meldung', required: true, help: 'Erscheint im Portal. Weitere Updates schreiben Sie in der Störung.' }) : null,
    h('div', { class: 'grid-2' },
      fieldWrap(select(v.impact, INCIDENT_IMPACTS.map((x) => ({ value: x, label: IMPACT_LABEL[x] })), (x) => { v.impact = x as typeof v.impact; }), { label: 'Auswirkung' }),
      fieldWrap(input(v.startedAt, (x) => { v.startedAt = x; }, { type: 'datetime-local' }), { label: 'Beginn' })),
    checkbox(v.major, 'Große Störung: Banner auf allen Seiten des Portals', (x) => { v.major = x; }),
    h('p', { class: 'label' }, 'Betroffene Services'), svcHost,
    d.features.locations.length ? h('div', null, h('p', { class: 'label' }, 'Standorte'), multiCheck(d.features.locations.map((l) => ({ value: l, label: l })), v.locations, (x) => { v.locations = x; }, '')) : null,
    fieldWrap(input(v.zammadTicket, (x) => { v.zammadTicket = x; }, { inputmode: 'numeric', placeholder: 'optional' }), { label: 'Führendes Ticket in Zammad (Nummer)', help: 'Das Ticket bekommt in Zammad den Tag der Störung. Neue Tickets zu betroffenen Services bekommen ihn automatisch.' }));
  const r = await dialog(existing ? `${existing.number} bearbeiten` : 'Störung melden', body, (close) => [
    button('Abbrechen', () => close(false), { kind: 'ghost' }),
    button(existing ? 'Speichern' : 'Veröffentlichen', async () => {
      const payload = { title: v.title, body: v.body, impact: v.impact, major: v.major, serviceIds: v.serviceIds, locations: v.locations, startedAt: fromLocal(v.startedAt), zammadTicket: v.zammadTicket || null };
      try {
        if (existing) await put(`/api/admin/systems/${existing.systemId}/incidents/${existing.id}`, payload);
        else await post(`/api/admin/systems/${v.systemId}/incidents`, payload);
        close(true);
      } catch (err) { mount(msg, notice('error', errorText(err), ...Object.values(errorsOf(err)).map((e) => h('div', { class: 'small' }, e)))); }
    }, { kind: 'primary' }),
  ], { wide: true });
  return r === true;
}

async function maintenanceDialog(d: Data, existing?: PublicMaintenance): Promise<boolean> {
  const systems = d.systems.filter((s) => s.canStatus);
  const start = existing?.startsAt ?? Math.ceil(Date.now() / 3600_000) * 3600_000 + 86400_000;
  const v = { systemId: existing?.systemId ?? systems[0]?.id ?? '', title: existing?.title ?? '', body: existing?.body ?? '', startsAt: toLocal(start), endsAt: toLocal(existing?.endsAt ?? start + 2 * 3600_000), serviceIds: existing?.services ?? [], locations: existing?.locations ?? [] };
  const svcHost = h('div');
  const drawSvc = () => mount(svcHost, multiCheck(d.services.filter((s) => s.systemId === v.systemId).map((s) => ({ value: s.id, label: s.name })), v.serviceIds, (x) => { v.serviceIds = x; }, 'Für dieses Ticketsystem gibt es noch keine Services.'));
  drawSvc();
  const msg = h('div');
  const r = await dialog(existing ? 'Wartung bearbeiten' : 'Wartung planen', h('div', { class: 'stack' }, msg,
    !existing && systems.length > 1 ? fieldWrap(select(v.systemId, systems.map((s) => ({ value: s.id, label: s.name })), (x) => { v.systemId = x; v.serviceIds = []; drawSvc(); }), { label: 'Ticketsystem' }) : null,
    fieldWrap(input(v.title, (x) => { v.title = x; }, { maxlength: 200, placeholder: 'z. B. Update des Mailservers' }), { label: 'Titel', required: true }),
    fieldWrap(textarea(v.body, (x) => { v.body = x; }, { rows: 3 }), { label: 'Beschreibung', help: 'Was ist während der Wartung eingeschränkt?' }),
    h('div', { class: 'grid-2' },
      fieldWrap(input(v.startsAt, (x) => { v.startsAt = x; }, { type: 'datetime-local' }), { label: 'Beginn', required: true }),
      fieldWrap(input(v.endsAt, (x) => { v.endsAt = x; }, { type: 'datetime-local' }), { label: 'Ende', required: true })),
    h('p', { class: 'label' }, 'Betroffene Services'), svcHost,
    d.features.locations.length ? h('div', null, h('p', { class: 'label' }, 'Standorte'), multiCheck(d.features.locations.map((l) => ({ value: l, label: l })), v.locations, (x) => { v.locations = x; }, '')) : null),
  (close) => [
    button('Abbrechen', () => close(false), { kind: 'ghost' }),
    button('Speichern', async () => {
      const payload = { title: v.title, body: v.body, startsAt: fromLocal(v.startsAt), endsAt: fromLocal(v.endsAt), serviceIds: v.serviceIds, locations: v.locations };
      try {
        if (existing) await put(`/api/admin/systems/${existing.systemId}/maintenances/${existing.id}`, payload);
        else await post(`/api/admin/systems/${v.systemId}/maintenances`, payload);
        close(true);
      } catch (err) { mount(msg, notice('error', errorText(err))); }
    }, { kind: 'primary' }),
  ], { wide: true });
  return r === true;
}

async function serviceDialog(d: Data, existing?: Svc, systemId?: string): Promise<boolean> {
  const systems = d.systems.filter((s) => s.canStatus);
  const v = { systemId: existing?.systemId ?? systemId ?? systems[0]?.id ?? '', name: existing?.name ?? '', description: existing?.description ?? '', manualStatus: existing?.manualStatus ?? '', manualNote: existing?.manualNote ?? '', sort: existing?.sort ?? 0 };
  const msg = h('div');
  const r = await dialog(existing ? `${existing.name} bearbeiten` : 'Service anlegen', h('div', { class: 'stack' }, msg,
    !existing && systems.length > 1 ? fieldWrap(select(v.systemId, systems.map((s) => ({ value: s.id, label: s.name })), (x) => { v.systemId = x; }), { label: 'Ticketsystem' }) : null,
    fieldWrap(input(v.name, (x) => { v.name = x; }, { maxlength: 120, placeholder: 'z. B. Microsoft 365' }), { label: 'Name', required: true }),
    fieldWrap(input(v.description, (x) => { v.description = x; }, { maxlength: 1000, placeholder: 'z. B. E-Mail, Teams, OneDrive' }), { label: 'Kurzbeschreibung' }),
    h('div', { class: 'grid-2' },
      fieldWrap(select(v.manualStatus, (['maintenance', 'degraded', 'partial_outage', 'major_outage'] as const).map((x) => ({ value: x, label: SERVICE_STATUS_LABEL[x] })), (x) => { v.manualStatus = x; }, { empty: 'Automatisch (aus Störungen und Wartungen)' }), { label: 'Zustand von Hand', help: 'Gilt zusätzlich, der schlimmere Zustand gewinnt.' }),
      fieldWrap(input(String(v.sort), (x) => { v.sort = Number(x) || 0; }, { type: 'number' }), { label: 'Reihenfolge' })),
    fieldWrap(input(v.manualNote, (x) => { v.manualNote = x; }, { maxlength: 500 }), { label: 'Hinweis zum Zustand', help: 'Nur bei Zustand von Hand, erscheint im Portal.' })),
  (close) => [
    button('Abbrechen', () => close(false), { kind: 'ghost' }),
    button('Speichern', async () => {
      const payload = { name: v.name, description: v.description, manualStatus: v.manualStatus || null, manualNote: v.manualNote, sort: v.sort };
      try {
        if (existing) await put(`/api/admin/systems/${existing.systemId}/services/${existing.id}`, payload);
        else await post(`/api/admin/systems/${v.systemId}/services`, payload);
        close(true);
      } catch (err) { mount(msg, notice('error', errorText(err))); }
    }, { kind: 'primary' }),
  ]);
  return r === true;
}

async function problemDialog(d: Data): Promise<string | null> {
  const systems = d.systems.filter((s) => s.canProblems);
  const v = { systemId: systems[0]?.id ?? '', title: '', description: '', serviceId: '' };
  const svcHost = h('div');
  const drawSvc = () => mount(svcHost, fieldWrap(select(v.serviceId, d.services.filter((s) => s.systemId === v.systemId).map((s) => ({ value: s.id, label: s.name })), (x) => { v.serviceId = x; }, { empty: '–' }), { label: 'Betroffener Service' }));
  drawSvc();
  const msg = h('div');
  const r = await dialog('Problem anlegen', h('div', { class: 'stack' }, msg,
    systems.length > 1 ? fieldWrap(select(v.systemId, systems.map((s) => ({ value: s.id, label: s.name })), (x) => { v.systemId = x; v.serviceId = ''; drawSvc(); }), { label: 'Ticketsystem' }) : null,
    fieldWrap(input(v.title, (x) => { v.title = x; }, { maxlength: 200, placeholder: 'z. B. VPN bricht nach Updates ab' }), { label: 'Titel', required: true }),
    svcHost,
    fieldWrap(textarea(v.description, (x) => { v.description = x; }, { rows: 3 }), { label: 'Beschreibung' })),
  (close) => [
    button('Abbrechen', () => close(null), { kind: 'ghost' }),
    button('Anlegen', async () => {
      try {
        const res = await post<{ problem: { id: string } }>(`/api/admin/systems/${v.systemId}/problems`, { title: v.title, description: v.description, serviceId: v.serviceId || null });
        close(`${v.systemId}/${res.problem.id}`);
      } catch (err) { mount(msg, notice('error', errorText(err))); }
    }, { kind: 'primary' }),
  ]);
  return typeof r === 'string' ? r : null;
}

// ------------------------------------------------------------------------------------------ Übersicht

export async function itsmAdminPage(_p: Record<string, string>, q: URLSearchParams): Promise<Child> {
  const host = h('div');
  let d: Data;
  let sys = q.get('system') ?? '';
  let tab = q.get('reiter') ?? '';
  const load = async () => { d = await get<Data>('/api/admin/itsm'); };
  try { await load(); } catch (err) { return notice('error', errorText(err)); }

  const draw = () => {
    const f = d.features;
    const multi = d.systems.length > 1;
    const canStatus = d.systems.some((s) => s.canStatus);
    const canProblems = d.systems.some((s) => s.canProblems);
    const tabList = [
      f.incidents && canStatus ? { id: 'stoerungen', label: `Störungen (${d.incidents.filter((i) => i.state !== 'resolved').length})` } : null,
      f.maintenance && canStatus ? { id: 'wartungen', label: 'Wartungen' } : null,
      canStatus ? { id: 'services', label: `Services (${d.services.length})` } : null,
      f.problems && canProblems ? { id: 'probleme', label: 'Probleme' } : null,
    ].filter((x): x is { id: string; label: string } => x !== null);
    if (!tabList.some((t) => t.id === tab)) tab = tabList[0]?.id ?? '';
    const inSys = <T extends { systemId: string }>(l: T[]) => (sys ? l.filter((x) => x.systemId === sys) : l);
    const reload = async () => { await load(); draw(); };
    const setQ = () => setUrl(`${curPath()}?${new URLSearchParams({ ...(tab ? { reiter: tab } : {}), ...(sys ? { system: sys } : {}) })}`, true);
    const names = new Map(d.services.map((s) => [s.id, s.name]));
    const svcNames = (ids: string[]) => ids.map((id) => names.get(id)).filter(Boolean).join(', ');

    let body: Child = null;
    if (tab === 'stoerungen') {
      const list = inSys(d.incidents);
      const cols = [
        { label: 'Nr.', render: (i: AdminIncident) => h('span', { class: 'num' }, i.number) },
        { label: 'Störung', render: (i: AdminIncident) => h('span', null, h('strong', null, i.title), i.major ? h('span', { class: 'inc-major' }, 'Groß') : null, i.services.length ? h('span', { class: 'muted small block' }, svcNames(i.services)) : null) },
        ...(multi ? [{ label: 'Ticketsystem', render: (i: AdminIncident) => i.systemName }] : []),
        { label: 'Auswirkung', render: (i: AdminIncident) => (i.state === 'resolved' ? statusPill('operational', 'Behoben') : statusPill(i.impact)) },
        { label: 'Stand', render: (i: AdminIncident) => INCIDENT_STATE_LABEL[i.state] },
        { label: 'Betroffen', class: 'num', render: (i: AdminIncident) => String(i.affected ?? '–') },
        { label: 'Beginn', render: (i: AdminIncident) => relTime(i.startedAt) },
      ];
      const open = list.filter((i) => i.state !== 'resolved');
      const done = list.filter((i) => i.state === 'resolved');
      body = h('div', { class: 'stack' },
        h('div', { class: 'row' }, button('Störung melden', async () => { if (await incidentDialog(d)) { toast('Störung veröffentlicht'); await reload(); } }, { kind: 'primary', icon: 'plus' })),
        table(open, cols, { onRow: (i) => navigate(`/admin/status/stoerung/${i.systemId}/${i.id}`), empty: 'Keine offenen Störungen.' }),
        done.length ? h('details', { class: 'more' }, h('summary', null, `Behoben in den letzten 30 Tagen (${done.length})`), table(done, cols, { onRow: (i) => navigate(`/admin/status/stoerung/${i.systemId}/${i.id}`) })) : null);
    } else if (tab === 'wartungen') {
      const now = Date.now();
      const list = inSys(d.maintenances);
      const stateOf = (m: (typeof list)[number]) => (m.cancelled ? badge('abgesagt') : m.endsAt <= now ? badge('vorbei') : m.startsAt <= now ? badge('läuft', 'warn') : badge('geplant', 'info'));
      body = h('div', { class: 'stack' },
        h('div', { class: 'row' }, button('Wartung planen', async () => { if (await maintenanceDialog(d)) { toast('Wartung geplant'); await reload(); } }, { kind: 'primary', icon: 'plus' })),
        table(list, [
          { label: 'Wartung', render: (m) => h('span', null, h('strong', null, m.title), m.services.length ? h('span', { class: 'muted small block' }, svcNames(m.services)) : null) },
          ...(multi ? [{ label: 'Ticketsystem', render: (m: (typeof list)[number]) => m.systemName }] : []),
          { label: 'Zeitraum', render: (m) => `${fmtDate(m.startsAt)} – ${fmtDate(m.endsAt)}` },
          { label: 'Stand', render: stateOf },
          { label: '', render: (m) => h('span', { class: 'row' },
            !m.cancelled && m.endsAt > now ? button('Bearbeiten', async () => { if (await maintenanceDialog(d, m)) { toast('Gespeichert'); await reload(); } }, { kind: 'ghost' }) : null,
            !m.cancelled && m.endsAt > now ? button('Absagen', async () => {
              if (!await confirmDialog('Wartung absagen?', `„${m.title}“ wird im Portal nicht mehr angezeigt.`, 'Absagen', true)) return;
              await post(`/api/admin/systems/${m.systemId}/maintenances/${m.id}/cancel`); toast('Abgesagt'); await reload();
            }, { kind: 'ghost' }) : null,
            button('Löschen', async () => {
              if (!await confirmDialog('Wartung löschen?', `„${m.title}“ wird gelöscht.`, 'Löschen', true)) return;
              await del(`/api/admin/systems/${m.systemId}/maintenances/${m.id}`); toast('Gelöscht'); await reload();
            }, { kind: 'ghost', icon: 'trash' })) },
        ], { empty: 'Keine Wartungen.' }));
    } else if (tab === 'services') {
      const groups = d.systems.filter((s) => s.canStatus && (!sys || s.id === sys));
      body = h('div', { class: 'stack' },
        h('div', { class: 'row' }, button('Service anlegen', async () => { if (await serviceDialog(d, undefined, sys || undefined)) { toast('Angelegt'); await reload(); } }, { kind: 'primary', icon: 'plus' })),
        h('p', { class: 'muted small' }, 'Der Zustand ergibt sich aus offenen Störungen und laufenden Wartungen; von Hand gesetzte Zustände gelten zusätzlich. Formulare lassen sich Services zuordnen (Formular → Ticket).'),
        ...groups.map((g) => h('section', { class: 'panel' },
          multi ? h('h2', null, g.name) : null,
          table(d.services.filter((s) => s.systemId === g.id), [
            { label: 'Service', render: (s) => h('span', null, h('strong', null, s.name), s.description ? h('span', { class: 'muted small block' }, s.description) : null) },
            { label: 'Zustand', render: (s) => h('span', null, statusPill(s.status), s.manualStatus ? h('span', { class: 'muted small block' }, `von Hand${s.manualNote ? `: ${s.manualNote}` : ''}`) : null) },
            { label: '', render: (s) => h('span', { class: 'row' },
              button('Bearbeiten', async () => { if (await serviceDialog(d, s)) { toast('Gespeichert'); await reload(); } }, { kind: 'ghost' }),
              button('Löschen', async () => {
                if (!await confirmDialog('Service löschen?', `„${s.name}“ wird aus Störungen, Wartungen und Formularen entfernt.`, 'Löschen', true)) return;
                await del(`/api/admin/systems/${s.systemId}/services/${s.id}`); toast('Gelöscht'); await reload();
              }, { kind: 'ghost', icon: 'trash' })) },
          ], { empty: 'Noch keine Services. Typisch: Microsoft 365, VPN, Netzwerk, Drucker, Fachanwendungen.' }))));
    } else if (tab === 'probleme') {
      const list = inSys(d.problems);
      body = h('div', { class: 'stack' },
        h('div', { class: 'row' }, button('Problem anlegen', async () => { const r = await problemDialog(d); if (r) navigate(`/admin/status/problem/${r}`); }, { kind: 'primary', icon: 'plus' })),
        table(list, [
          { label: 'Nr.', render: (p) => h('span', { class: 'num' }, p.number) },
          { label: 'Problem', render: (p) => h('span', null, h('strong', null, p.title), p.serviceId ? h('span', { class: 'muted small block' }, names.get(p.serviceId) ?? '') : null) },
          ...(multi ? [{ label: 'Ticketsystem', render: (p: AdminProblem) => p.systemName }] : []),
          { label: 'Stand', render: (p) => badge(PROBLEM_STATE_LABEL[p.state], p.state === 'known_error' ? 'warn' : p.state === 'resolved' || p.state === 'closed' ? 'ok' : 'info') },
          { label: 'Im Portal', render: (p) => (p.public ? badge('sichtbar', 'ok') : '–') },
          { label: 'Tickets', class: 'num', render: (p) => String(p.tickets) },
          { label: 'Störungen', class: 'num', render: (p) => String(p.incidents.length) },
          { label: 'Verantwortlich', render: (p) => p.owner || '–' },
        ], { onRow: (p) => navigate(`/admin/status/problem/${p.systemId}/${p.id}`), empty: 'Keine Probleme erfasst.' }));
    }

    mount(host,
      pageHead('Status und Störungen', multi ? 'Alle Ticketsysteme auf einer Seite' : undefined, [
        multi ? select(sys, d.systems.map((s) => ({ value: s.id, label: s.name })), (x) => { sys = x; setQ(); draw(); }, { empty: 'Alle Ticketsysteme', ariaLabel: 'Ticketsystem' }) : null,
        link('/status', icon('eye', 16), 'Status im Portal'),
      ].filter(Boolean) as HTMLElement[]),
      !tabList.length ? notice('info', 'Unter ', link('/admin/funktionen', 'Funktionen'), ' lassen sich Service-Status, Störungen, Wartungen und Probleme einschalten.') : null,
      tabList.length > 1 ? tabs(tabList, tab, (t) => { tab = t; setQ(); draw(); }) : null,
      body);
  };
  draw();
  return host;
}

// ------------------------------------------------------------------------------------------ Störung

export async function incidentAdminPage(p: Record<string, string>): Promise<Child> {
  const base = `/api/admin/systems/${p.systemId}/incidents/${p.incidentId}`;
  const host = h('div');
  const draw = async () => {
    let r: { incident: AdminIncident & { createdBy: string }; updates: { id: string; state: IncidentState; body: string; at: number; by: string }[]; affected: { name: string; email: string | null; department: string | null; at: number }[] };
    let d: Data;
    try { [r, d] = await Promise.all([get<typeof r>(base), get<Data>('/api/admin/itsm')]); } catch (err) { mount(host, notice('error', errorText(err))); return; }
    const i = r.incident;
    const names = new Map(d.services.map((s) => [s.id, s.name]));
    const upd = { state: i.state === 'resolved' ? 'resolved' : i.state as IncidentState, body: '' };
    const msg = h('div');
    const problems = d.problems.filter((x) => x.systemId === i.systemId);
    mount(host,
      h('nav', { class: 'crumbs' }, link('/admin/status?reiter=stoerungen', icon('back', 14), 'Störungen')),
      pageHead(`${i.number}: ${i.title}`, h('span', { class: 'row' }, i.state === 'resolved' ? statusPill('operational', 'Behoben') : statusPill(i.impact), i.major ? h('span', { class: 'inc-major' }, 'Große Störung') : null, h('span', { class: 'muted' }, `${i.systemName}, seit ${fmtDate(i.startedAt)}`)), [
        button('Bearbeiten', async () => { if (await incidentDialog(d, i)) { toast('Gespeichert'); await draw(); } }),
        link(`/stoerungen/${i.id}`, icon('eye', 16), 'Im Portal'),
        button('Löschen', async () => {
          if (!await confirmDialog('Störung löschen?', 'Nur für Fehleinträge. Verlauf und Betroffene werden gelöscht, das Audit-Log behält den Vorgang.', 'Löschen', true)) return;
          await del(base); toast('Gelöscht'); navigate('/admin/status?reiter=stoerungen');
        }, { kind: 'danger' }),
      ]),
      msg,
      h('div', { class: 'grid-2 itsm-detail' },
        h('div', { class: 'stack' },
          h('section', { class: 'panel stack' },
            h('h2', null, i.state === 'resolved' ? 'Nachtrag schreiben' : 'Update schreiben'),
            fieldWrap(select(upd.state, INCIDENT_STATES.map((x) => ({ value: x, label: INCIDENT_STATE_LABEL[x] })), (x) => { upd.state = x as IncidentState; }), { label: 'Stand' }),
            fieldWrap(textarea('', (x) => { upd.body = x; }, { rows: 4, placeholder: 'Was ist neu? Was sollen die Mitarbeitenden tun?' }), { label: 'Text', help: i.affected ? `Geht als Benachrichtigung an ${i.affected} ${i.affected === 1 ? 'betroffene Person' : 'betroffene Personen'}.` : 'Betroffene bekommen jedes Update unter der Glocke.' }),
            h('div', { class: 'row' }, button('Veröffentlichen', async () => {
              try { await post(`${base}/updates`, upd); toast(upd.state === 'resolved' ? 'Als behoben gemeldet' : 'Update veröffentlicht'); await draw(); } catch (err) { mount(msg, notice('error', errorText(err))); }
            }, { kind: 'primary' }))),
          h('section', { class: 'panel' },
            h('h2', null, 'Verlauf'),
            h('ol', { class: 'inc-timeline' }, ...r.updates.map((u) => h('li', { class: `tl-${u.state}` },
              h('div', { class: 'tl-head' }, h('strong', null, INCIDENT_STATE_LABEL[u.state]), h('span', { class: 'muted small' }, `${fmtDate(u.at)}${u.by ? `, ${u.by}` : ''}`)),
              h('p', null, u.body)))))),
        h('div', { class: 'stack' },
          h('section', { class: 'panel' },
            h('h2', null, 'Angaben'),
            h('dl', { class: 'inc-facts' },
              h('div', null, h('dt', null, 'Services'), h('dd', null, i.services.map((s) => names.get(s)).filter(Boolean).join(', ') || '–')),
              h('div', null, h('dt', null, 'Standorte'), h('dd', null, i.locations.join(', ') || '–')),
              h('div', null, h('dt', null, 'Zammad'), h('dd', null, i.zammadTicket ? `Ticket ${i.zammadTicket}, ` : '', 'Tag ', h('code', null, i.tag))),
              h('div', null, h('dt', null, 'Gemeldet von'), h('dd', null, i.createdBy || '–'))),
            d.features.problems && problems.length ? fieldWrap(select(i.problemId ?? '', problems.map((x) => ({ value: x.id, label: `${x.number}: ${x.title}` })), async (x) => {
              try { await put(base, { problemId: x || null }); toast('Gespeichert'); } catch (err) { toast(errorText(err), 'error'); }
            }, { empty: 'kein Problem zugeordnet' }), { label: 'Problem' }) : null),
          h('section', { class: 'panel' },
            h('h2', null, `Betroffen (${r.affected.length})`),
            r.affected.length ? table(r.affected, [
              { label: 'Name', render: (a) => a.name },
              { label: 'E-Mail', render: (a) => a.email ?? '' },
              { label: 'Abteilung', render: (a) => a.department ?? '' },
              { label: 'Gemeldet', render: (a) => relTime(a.at) },
            ]) : h('p', { class: 'muted' }, 'Noch niemand hat „Ich bin auch betroffen“ geklickt.')))));
  };
  await draw();
  return host;
}

// ------------------------------------------------------------------------------------------ Problem

export async function problemAdminPage(p: Record<string, string>): Promise<Child> {
  const base = `/api/admin/systems/${p.systemId}/problems/${p.problemId}`;
  const host = h('div');
  const draw = async () => {
    let r: { problem: AdminProblem & { createdBy: string }; tickets: { id: number; number: string; title: string; state: string | null; closed: boolean | null; unavailable?: boolean }[] };
    let services: { id: string; name: string }[];
    try { [r, services] = await Promise.all([get<typeof r>(base), get<{ services: { id: string; name: string }[] }>(`/api/admin/systems/${p.systemId}/services`).then((x) => x.services)]); }
    catch (err) { mount(host, notice('error', errorText(err))); return; }
    const pr = r.problem;
    const v = { title: pr.title, state: pr.state, serviceId: pr.serviceId ?? '', owner: pr.owner, description: pr.description, rootCause: pr.rootCause, workaround: pr.workaround, public: pr.public };
    const msg = h('div');
    let ticketNo = '';
    mount(host,
      h('nav', { class: 'crumbs' }, link('/admin/status?reiter=probleme', icon('back', 14), 'Probleme')),
      pageHead(`${pr.number}: ${pr.title}`, `${pr.systemName}, angelegt ${fmtDate(pr.createdAt)}${pr.createdBy ? ` von ${pr.createdBy}` : ''}`, [
        button('Löschen', async () => {
          if (!await confirmDialog('Problem löschen?', 'Verknüpfungen zu Störungen werden gelöst. Tags in Zammad bleiben.', 'Löschen', true)) return;
          await del(base); toast('Gelöscht'); navigate('/admin/status?reiter=probleme');
        }, { kind: 'danger' }),
      ]),
      msg,
      h('div', { class: 'grid-2 itsm-detail' },
        h('section', { class: 'panel stack' },
          h('h2', null, 'Problem'),
          fieldWrap(input(v.title, (x) => { v.title = x; }, { maxlength: 200 }), { label: 'Titel', required: true }),
          h('div', { class: 'grid-2' },
            fieldWrap(select(v.state, PROBLEM_STATES.map((x) => ({ value: x, label: PROBLEM_STATE_LABEL[x] })), (x) => { v.state = x as ProblemState; }), { label: 'Stand' }),
            fieldWrap(select(v.serviceId, services.map((s) => ({ value: s.id, label: s.name })), (x) => { v.serviceId = x; }, { empty: '–' }), { label: 'Service' })),
          fieldWrap(input(v.owner, (x) => { v.owner = x; }, { maxlength: 120, placeholder: 'Name oder Team' }), { label: 'Verantwortlich' }),
          fieldWrap(textarea(v.description, (x) => { v.description = x; }, { rows: 3 }), { label: 'Beschreibung' }),
          fieldWrap(textarea(v.rootCause, (x) => { v.rootCause = x; }, { rows: 3 }), { label: 'Ursache (Root Cause)', help: 'Bleibt intern.' }),
          fieldWrap(textarea(v.workaround, (x) => { v.workaround = x; }, { rows: 3 }), { label: 'Workaround', help: 'Was die Mitarbeitenden in der Zwischenzeit tun können.' }),
          checkbox(v.public, 'Als bekannten Fehler im Portal zeigen (Titel, Beschreibung, Workaround)', (x) => { v.public = x; }),
          h('div', { class: 'row' }, button('Speichern', async () => {
            try { await put(base, { ...v, serviceId: v.serviceId || null }); toast('Gespeichert'); await draw(); } catch (err) { mount(msg, notice('error', errorText(err))); }
          }, { kind: 'primary' }))),
        h('div', { class: 'stack' },
          h('section', { class: 'panel stack' },
            h('h2', null, `Tickets in Zammad (${r.tickets.length})`),
            h('p', { class: 'muted small' }, 'Verknüpfte Tickets bekommen in Zammad den Tag ', h('code', null, pr.tag), '. Die Liste zeigt den aktuellen Stand aus Zammad.'),
            r.tickets.length ? table(r.tickets, [
              { label: 'Nr.', render: (t) => h('span', { class: 'num' }, `#${t.number}`) },
              { label: 'Titel', render: (t) => t.unavailable ? h('span', { class: 'muted' }, 'Zammad nicht erreichbar') : t.title },
              { label: 'Stand', render: (t) => (t.state ? badge(t.state, t.closed ? 'ok' : 'info') : '–') },
              { label: '', render: (t) => button('Lösen', async () => {
                try { await del(`${base}/tickets/${t.id}`); toast('Verknüpfung gelöst'); await draw(); } catch (err) { toast(errorText(err), 'error'); }
              }, { kind: 'ghost' }) },
            ]) : null,
            h('div', { class: 'row' },
              input('', (x) => { ticketNo = x; }, { inputmode: 'numeric', placeholder: 'Ticketnummer', 'aria-label': 'Ticketnummer' }),
              button('Verknüpfen', async () => {
                try { await post(`${base}/tickets`, { number: ticketNo }); toast('Verknüpft – Tag in Zammad gesetzt'); await draw(); } catch (err) { mount(msg, notice('error', errorText(err))); }
              }, { icon: 'link' }))),
          h('section', { class: 'panel' },
            h('h2', null, `Störungen (${pr.incidents.length})`),
            pr.incidents.length ? h('ul', { class: 'plain-list' }, ...pr.incidents.map((i) => h('li', null, link(`/admin/status/stoerung/${pr.systemId}/${i.id}`, `${i.number}: ${i.title}`), ' ', i.state === 'resolved' ? badge('behoben', 'ok') : badge('offen', 'warn'))))
              : h('p', { class: 'muted' }, 'Störungen ordnen Sie in der Störung selbst diesem Problem zu.')))));
  };
  await draw();
  return host;
}
