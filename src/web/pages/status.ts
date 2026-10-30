// Status-Seite (eine Seite für alle Ticketsysteme), Störungsdetails, Banner und Hinweise auf Formularen.
import { h, icon, mount, fmtDate, relTime, type Child } from '../lib/dom.ts';
import { get, post } from '../lib/api.ts';
import { feature, link } from '../lib/app.ts';
import { emptyState, errorText, notice, toast } from '../lib/ui.ts';
import { INCIDENT_STATE_LABEL, SERVICE_STATUS_LABEL, statusRank, type IncidentState, type ServiceStatus } from '../../shared/itsm.ts';

export interface PublicIncident {
  id: string; number: string; systemId: string; systemName: string; title: string; impact: ServiceStatus; major: boolean; state: IncidentState;
  locations: string[]; startedAt: number; resolvedAt: number | null; updatedAt: number; services: string[]; affected: number | null; mine: boolean;
  lastUpdate: { body: string; created_at: number } | null;
}
export interface PublicMaintenance { id: string; systemId: string; systemName: string; title: string; body: string; startsAt: number; endsAt: number; locations: string[]; services: string[] }
interface PublicService { id: string; systemId: string; name: string; description: string; status: ServiceStatus; note: string; incidents: string[]; maintenances: string[] }
interface PublicProblem { id: string; number: string; systemId: string; systemName: string; title: string; state: string; serviceId: string | null; description: string; workaround: string; updatedAt: number }
interface Overview {
  features: { status: boolean; incidents: boolean; maintenance: boolean; problems: boolean };
  systems: { id: string; name: string }[];
  services: PublicService[]; incidents: PublicIncident[]; maintenances: PublicMaintenance[]; problems: PublicProblem[];
}

export function statusPill(s: ServiceStatus, text?: string): HTMLElement {
  return h('span', { class: ['st-pill', `st-${s}`] }, h('span', { class: 'st-dot', attrs: { 'aria-hidden': 'true' } }), text ?? SERVICE_STATUS_LABEL[s]);
}

const range = (a: number, b: number) => {
  const same = new Date(a).toDateString() === new Date(b).toDateString();
  return same ? `${fmtDate(a)} – ${new Date(b).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}` : `${fmtDate(a)} – ${fmtDate(b)}`;
};

/** „heute“, „morgen“ oder „Sa., 31.10.“ */
function dayLabel(ms: number): string {
  const d = new Date(ms), today = new Date();
  const diff = Math.round((new Date(d.toDateString()).getTime() - new Date(today.toDateString()).getTime()) / 86400_000);
  return diff === 0 ? 'Heute' : diff === 1 ? 'Morgen' : d.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });
}

/** „Ich bin auch betroffen“: ein Klick statt eines eigenen Tickets; Updates kommen dann unter der Glocke. */
export function affectedControl(inc: PublicIncident, onChange?: (inc: PublicIncident) => void): HTMLElement {
  const host = h('div', { class: 'affected' });
  const draw = () => {
    if (inc.state === 'resolved') { mount(host, inc.affected ? h('span', { class: 'muted small' }, `${inc.affected} ${inc.affected === 1 ? 'Person war' : 'Personen waren'} betroffen`) : null); return; }
    const btn = h('button', {
      class: ['btn', inc.mine ? 'btn-secondary' : 'btn-primary', 'btn-sm'],
      attrs: { type: 'button', 'aria-pressed': String(inc.mine) },
      on: {
        click: async () => {
          btn.setAttribute('disabled', '');
          try {
            const r = await post<{ affected: boolean; count: number | null }>(`/api/portal/incidents/${inc.id}/affected`, { affected: !inc.mine });
            inc.mine = r.affected; inc.affected = r.count;
            toast(inc.mine ? 'Gemeldet – Sie bekommen jedes Update unter der Glocke' : 'Meldung zurückgenommen', 'ok');
            draw(); onChange?.(inc);
          } catch (err) { toast(errorText(err), 'error'); btn.removeAttribute('disabled'); }
        },
      },
    }, inc.mine ? icon('check', 16) : icon('users', 16), inc.mine ? 'Sie sind als betroffen gemeldet' : 'Ich bin auch betroffen');
    mount(host, btn,
      inc.affected !== null ? h('span', { class: 'affected-count' }, inc.affected === 0 ? 'Noch niemand gemeldet' : `${inc.affected} ${inc.affected === 1 ? 'Person' : 'Personen'} betroffen`) : null,
      inc.mine ? h('button', { class: 'link-btn small', attrs: { type: 'button' }, on: { click: () => btn.click() } }, 'Zurücknehmen') : null);
    if (inc.mine) btn.setAttribute('disabled', '');
  };
  draw();
  return host;
}

export function incidentCard(inc: PublicIncident, serviceNames: Map<string, string>, opts: { showSystem?: boolean } = {}): HTMLElement {
  const services = inc.services.map((id) => serviceNames.get(id)).filter(Boolean) as string[];
  return h('article', { class: ['inc-card', `impact-${inc.impact}`, inc.state === 'resolved' && 'resolved'] },
    h('div', { class: 'inc-head' },
      inc.state === 'resolved' ? statusPill('operational', 'Behoben') : statusPill(inc.impact),
      inc.major && inc.state !== 'resolved' ? h('span', { class: 'inc-major' }, 'Große Störung') : null,
      h('span', { class: 'inc-num' }, inc.number)),
    h('h3', { class: 'inc-title' }, link(`/stoerungen/${inc.id}`, inc.title)),
    h('p', { class: 'inc-meta' },
      opts.showSystem ? `${inc.systemName}, ` : '',
      inc.state === 'resolved' && inc.resolvedAt ? `behoben ${relTime(inc.resolvedAt)}` : `seit ${fmtDate(inc.startedAt)}`,
      inc.state !== 'resolved' ? `, ${INCIDENT_STATE_LABEL[inc.state]}` : ''),
    services.length || inc.locations.length ? h('p', { class: 'inc-tags' }, ...services.map((s) => h('span', { class: 'tag' }, s)), ...inc.locations.map((l) => h('span', { class: 'tag tag-loc' }, l))) : null,
    inc.lastUpdate ? h('p', { class: 'inc-update' }, h('span', { class: 'muted' }, `${relTime(inc.lastUpdate.created_at)}: `), inc.lastUpdate.body) : null,
    feature('incidents') ? affectedControl(inc) : null);
}

function maintenanceRow(m: PublicMaintenance, serviceNames: Map<string, string>, showSystem = true): HTMLElement {
  const now = Date.now();
  const running = m.startsAt <= now;
  const services = m.services.map((id) => serviceNames.get(id)).filter(Boolean) as string[];
  return h('li', { class: ['mnt', running && 'running'] },
    h('div', { class: 'mnt-when' }, running ? statusPill('maintenance', 'Läuft gerade') : h('span', { class: 'mnt-date' }, icon('calendar', 16), dayLabel(m.startsAt))),
    h('div', { class: 'mnt-body' },
      h('strong', null, m.title),
      h('span', { class: 'muted small' }, range(m.startsAt, m.endsAt), showSystem ? `, ${m.systemName}` : ''),
      m.body ? h('span', { class: 'mnt-text' }, m.body) : null,
      services.length || m.locations.length ? h('span', { class: 'inc-tags' }, ...services.map((s) => h('span', { class: 'tag' }, s)), ...m.locations.map((l) => h('span', { class: 'tag tag-loc' }, l))) : null));
}

// ------------------------------------------------------------------------------------------ Status-Seite

export async function statusPage(): Promise<Child> {
  let d: Overview;
  try { d = await get<Overview>('/api/portal/status'); } catch (err) { return h('div', { class: 'container' }, notice('error', errorText(err))); }
  const names = new Map(d.services.map((s) => [s.id, s.name]));
  const multi = d.systems.length > 1;
  const open = d.incidents.filter((i) => i.state !== 'resolved');
  const resolved = d.incidents.filter((i) => i.state === 'resolved');
  const worst = d.services.reduce<ServiceStatus>((a, s) => (statusRank(s.status) > statusRank(a) ? s.status : a), open.length ? open.reduce<ServiceStatus>((a, i) => (statusRank(i.impact) > statusRank(a) ? i.impact : a), 'operational') : 'operational');
  const running = d.maintenances.filter((m) => m.startsAt <= Date.now());
  const headline = open.length
    ? `${open.length} ${open.length === 1 ? 'aktuelle Störung' : 'aktuelle Störungen'}`
    : running.length ? 'Wartung läuft' : 'Alles in Betrieb';
  const sub = open.length
    ? 'Sind Sie auch betroffen? Ein Klick genügt – ein eigenes Ticket ist nicht nötig.'
    : running.length ? 'Einzelne Services sind gerade wegen Wartung eingeschränkt.' : 'Es sind keine Störungen bekannt.';

  const sections: { id: string; label: string; count?: number; el: HTMLElement }[] = [];
  if (d.features.incidents) {
    sections.push({ id: 'stoerungen', label: 'Störungen', count: open.length, el: h('section', { class: 'st-section', attrs: { id: 'stoerungen', 'aria-labelledby': 'h-st' } },
      h('h2', { id: 'h-st' }, 'Aktuelle Störungen'),
      open.length ? h('div', { class: 'inc-list' }, ...open.map((i) => incidentCard(i, names, { showSystem: multi }))) : h('p', { class: 'muted' }, 'Keine offenen Störungen.'),
      resolved.length ? h('details', { class: 'st-resolved' }, h('summary', null, `Behoben in den letzten 7 Tagen (${resolved.length})`),
        h('div', { class: 'inc-list' }, ...resolved.map((i) => incidentCard(i, names, { showSystem: multi })))) : null) });
  }
  if (d.features.maintenance) {
    sections.push({ id: 'wartungen', label: 'Wartungen', count: d.maintenances.length, el: h('section', { class: 'st-section', attrs: { id: 'wartungen', 'aria-labelledby': 'h-mnt' } },
      h('h2', { id: 'h-mnt' }, 'Geplante Wartungen'),
      d.maintenances.length ? h('ul', { class: 'mnt-list' }, ...d.maintenances.map((m) => maintenanceRow(m, names, multi))) : h('p', { class: 'muted' }, 'Keine Wartungen geplant.')) });
  }
  if (d.features.status) {
    const bySystem = d.systems.map((s) => ({ s, list: d.services.filter((x) => x.systemId === s.id) })).filter((x) => x.list.length);
    sections.push({ id: 'services', label: 'Services', el: h('section', { class: 'st-section', attrs: { id: 'services', 'aria-labelledby': 'h-svc' } },
      h('h2', { id: 'h-svc' }, 'Services'),
      bySystem.length ? h('div', { class: 'svc-groups' }, ...bySystem.map(({ s, list }) => h('div', { class: 'svc-group' },
        multi ? h('h3', null, s.name) : null,
        h('ul', { class: 'svc-list' }, ...list.map((x) => h('li', { class: ['svc', `svc-${x.status}`] },
          h('span', { class: 'svc-name' }, x.name, x.description ? h('span', { class: 'svc-desc' }, x.description) : null, x.note ? h('span', { class: 'svc-note' }, x.note) : null),
          statusPill(x.status))))))) : emptyState('Noch keine Services', 'Die IT hat noch keine Services eingetragen.')) });
  }
  if (d.features.problems) {
    sections.push({ id: 'bekannte-probleme', label: 'Bekannte Probleme', count: d.problems.length, el: h('section', { class: 'st-section', attrs: { id: 'bekannte-probleme', 'aria-labelledby': 'h-prb' } },
      h('h2', { id: 'h-prb' }, 'Bekannte Probleme'),
      h('p', { class: 'muted small' }, 'Fehler, die die IT kennt, mit einer Lösung für die Zwischenzeit.'),
      d.problems.length ? h('div', { class: 'prb-list' }, ...d.problems.map((p) => h('details', { class: 'prb' },
        h('summary', null, h('span', { class: 'prb-title' }, p.title), h('span', { class: 'muted small' }, `${p.number}${multi ? `, ${p.systemName}` : ''}${p.serviceId && names.get(p.serviceId) ? `, ${names.get(p.serviceId)}` : ''}${p.state === 'resolved' ? ', gelöst' : ''}`)),
        p.description ? h('p', null, p.description) : null,
        p.workaround ? h('div', { class: 'prb-workaround' }, h('strong', null, 'So geht es in der Zwischenzeit'), h('p', null, p.workaround)) : null))) : h('p', { class: 'muted' }, 'Keine bekannten Probleme.')) });
  }

  return h('div', { class: 'container status-page' },
    h('header', { class: ['st-hero', `st-hero-${worst}`] },
      h('span', { class: 'st-hero-icon', attrs: { 'aria-hidden': 'true' } }, icon(open.length ? 'alert' : running.length ? 'tool' : 'check', 26)),
      h('div', null, h('h1', null, headline), h('p', null, sub))),
    sections.length > 1 ? h('nav', { class: 'st-jump', attrs: { 'aria-label': 'Bereiche der Status-Seite' } },
      ...sections.map((s) => h('a', { attrs: { href: `#${s.id}` }, on: { click: (e) => { e.preventDefault(); document.getElementById(s.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); } } },
        s.label, s.count ? h('span', { class: 'count' }, String(s.count)) : null))) : null,
    ...sections.map((s) => s.el));
}

// ------------------------------------------------------------------------------------------ Störung

export async function incidentPage(p: Record<string, string>): Promise<Child> {
  let d: { incident: PublicIncident; updates: { state: IncidentState; body: string; at: number }[]; serviceNames: Record<string, string>; problem: { number: string; title: string; workaround: string } | null };
  try { d = await get(`/api/portal/incidents/${p.incidentId}`); } catch (err) { return h('div', { class: 'container narrow' }, notice('error', errorText(err))); }
  const i = d.incident;
  const services = i.services.map((id) => d.serviceNames[id]).filter(Boolean);
  return h('div', { class: 'container narrow incident-page' },
    h('nav', { class: 'crumbs' }, link('/status', icon('back', 14), 'Status')),
    h('div', { class: 'inc-head' },
      i.state === 'resolved' ? statusPill('operational', 'Behoben') : statusPill(i.impact),
      i.major && i.state !== 'resolved' ? h('span', { class: 'inc-major' }, 'Große Störung') : null,
      h('span', { class: 'inc-num' }, i.number)),
    h('h1', null, i.title),
    h('dl', { class: 'inc-facts' },
      h('div', null, h('dt', null, 'Ticketsystem'), h('dd', null, i.systemName)),
      h('div', null, h('dt', null, 'Beginn'), h('dd', null, fmtDate(i.startedAt))),
      i.resolvedAt ? h('div', null, h('dt', null, 'Behoben'), h('dd', null, fmtDate(i.resolvedAt))) : h('div', null, h('dt', null, 'Stand'), h('dd', null, INCIDENT_STATE_LABEL[i.state])),
      services.length ? h('div', null, h('dt', null, 'Betroffene Services'), h('dd', null, services.join(', '))) : null,
      i.locations.length ? h('div', null, h('dt', null, 'Standorte'), h('dd', null, i.locations.join(', '))) : null),
    affectedControl(i),
    d.problem?.workaround ? notice('info', h('strong', null, 'So geht es in der Zwischenzeit: '), d.problem.workaround) : null,
    h('h2', null, 'Verlauf'),
    h('ol', { class: 'inc-timeline' }, ...d.updates.map((u) => h('li', { class: `tl-${u.state}` },
      h('div', { class: 'tl-head' }, h('strong', null, INCIDENT_STATE_LABEL[u.state]), h('span', { class: 'muted small' }, fmtDate(u.at))),
      h('p', null, u.body)))));
}

// ------------------------------------------------------------------------------------------ Banner und Formular

let bannerCache: { at: number; data: Banner } | null = null;
interface Banner { major: PublicIncident[]; activeIncidents: number; maintenanceNow: PublicMaintenance[]; maintenanceSoon: PublicMaintenance[] }

/** Banner unter der Kopfzeile: große Störungen und laufende Wartungen – auf jeder Seite des Portals. */
export function statusBanner(path: string): HTMLElement {
  const host = h('div', { class: 'st-banner-host' });
  if (path === '/status' || path.startsWith('/stoerungen/')) return host;
  const draw = (b: Banner) => {
    const items: Child[] = [];
    for (const i of b.major) {
      items.push(h('div', { class: ['st-banner', `impact-${i.impact}`], attrs: { role: 'status' } },
        h('div', { class: 'st-banner-inner' },
          icon('alert', 20),
          h('div', { class: 'st-banner-text' },
            h('strong', null, i.title),
            h('span', null, `${i.systemName}, seit ${relTime(i.startedAt)}`)),
          link(`/stoerungen/${i.id}`, 'Details'),
          affectedControl(i))));
    }
    for (const m of b.maintenanceNow) {
      items.push(h('div', { class: ['st-banner', 'impact-maintenance'], attrs: { role: 'status' } },
        h('div', { class: 'st-banner-inner' }, icon('tool', 20),
          h('div', { class: 'st-banner-text' }, h('strong', null, `Wartung: ${m.title}`), h('span', null, `bis ${new Date(m.endsAt).toLocaleString('de-DE', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`)),
          link('/status#wartungen', 'Status'))));
    }
    const minor = b.activeIncidents - b.major.length;
    if (minor > 0 && !b.major.length) {
      items.push(h('div', { class: ['st-banner', 'st-banner-slim'] }, h('div', { class: 'st-banner-inner' }, icon('pulse', 18),
        h('span', { class: 'st-banner-text' }, `${minor} ${minor === 1 ? 'aktuelle Störung' : 'aktuelle Störungen'} bekannt.`), link('/status', 'Zum Status'))));
    }
    mount(host, ...items);
  };
  if (bannerCache && Date.now() - bannerCache.at < 30_000) draw(bannerCache.data);
  else get<Banner>('/api/portal/status/banner').then((b) => { bannerCache = { at: Date.now(), data: b }; draw(b); }).catch(() => undefined);
  return host;
}
export function invalidateBanner(): void { bannerCache = null; }

/** Auf dem Formular: bekannte Störungen und Wartungen zu den Services dieses Formulars. */
export function formNotices(n: { incidents: PublicIncident[]; maintenances: PublicMaintenance[] } | undefined): HTMLElement | null {
  if (!n || (!n.incidents.length && !n.maintenances.length)) return null;
  return h('div', { class: 'form-notices' },
    ...n.incidents.map((i) => h('div', { class: ['form-notice', `impact-${i.impact}`] },
      h('div', { class: 'form-notice-head' }, icon('alert', 20), h('div', null,
        h('strong', null, `Bekannte Störung: ${i.title}`),
        h('span', { class: 'small' }, `Die IT arbeitet daran (${INCIDENT_STATE_LABEL[i.state]}). Statt einer neuen Anfrage reicht ein Klick – Sie bekommen jedes Update.`))),
      h('div', { class: 'form-notice-actions' }, affectedControl(i), link(`/stoerungen/${i.id}`, 'Details')))),
    ...n.maintenances.map((m) => h('div', { class: ['form-notice', 'impact-maintenance'] },
      h('div', { class: 'form-notice-head' }, icon('tool', 20), h('div', null,
        h('strong', null, `${m.startsAt <= Date.now() ? 'Wartung läuft' : 'Wartung geplant'}: ${m.title}`),
        h('span', { class: 'small' }, range(m.startsAt, m.endsAt)))))));
}
