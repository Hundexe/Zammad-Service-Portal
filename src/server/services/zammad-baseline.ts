// Zammad-Grundausstattung nach ITSM-Praxis – Vorschau und Anlegen (siehe shared/zammad-baseline.ts).
// Jedes Element wird über seinen Namen erkannt: Vorhandenes bleibt unverändert, ähnlich benannte Felder werden
// gemeldet und übersprungen. Es wird nie etwas gelöscht oder überschrieben.
import type { App } from '../app.ts';
import { log } from '../log.ts';
import { connectorFor, type SystemRow } from './systems.ts';
import { getMapping } from './zammad-setup.ts';
import type { AdminKind, Connector, SetupInfo, StateType } from '../connectors/types.ts';
import { pickState } from './zammad-states.ts';
import { optionKey } from '../../shared/zammad-model.ts';
import {
  BASELINE_PART_INFO, IMPACTS, MATRIX, PRIORITY_NAMES, STATE_NAMES, TICKET_TYPES, URGENCIES, WEEKDAYS,
  type BaselineOptions, type BaselinePart,
} from '../../shared/zammad-baseline.ts';

export type ItemKind = 'attribute' | 'state' | 'priority' | 'calendar' | 'sla' | 'trigger' | 'job' | 'overview';
export interface BaselineItem {
  part: BaselinePart;
  kind: ItemKind;
  name: string;
  /** neu = wird angelegt; vorhanden = gleicher Name existiert; übersprungen = Ähnliches vorhanden oder Voraussetzung fehlt */
  status: 'neu' | 'vorhanden' | 'übersprungen';
  note?: string;
}

const KIND_LABEL: Record<ItemKind, string> = {
  attribute: 'Feld', state: 'Status', priority: 'Priorität', calendar: 'Kalender', sla: 'SLA', trigger: 'Trigger', job: 'Automatisierung', overview: 'Übersicht',
};
export const itemLabel = (i: BaselineItem) => `${KIND_LABEL[i.kind]} „${i.name}“`;

const ATTR = { type: 'itsm_ticketart', impact: 'itsm_auswirkung', urgency: 'itsm_dringlichkeit' } as const;
const ATTR_DISPLAY = { type: 'Ticketart', impact: 'Auswirkung', urgency: 'Dringlichkeit' } as const;
const TAG = { escalated: 'eskaliert', escalated2: 'eskaliert-stufe-2', reminded: 'erinnert' } as const;
/** Absender und Artikeltypen in Zammad (feste IDs aus der Grundinstallation) */
const SENDER = { agent: '1', customer: '2' } as const;
const TYPE = { email: '1', phone: '5', note: '10', web: '11' } as const;

const T = (s: string) => `ITSM – ${s}`;
const NAMES = {
  ack: T('Eingangsbestätigung'), reply: T('Antwort der IT per E-Mail'), resolved: T('Mitteilung bei „Gelöst“'), reopen: T('Antwort des Kunden öffnet wieder'),
  esc1: T('Eskalation Stufe 1'), escReset: T('Eskalation zurücksetzen'), esc2: T('Eskalation Stufe 2'),
  close: T('Gelöst nach Frist schließen'), remind: T('Erinnerung bei Warten auf Rückmeldung'), closeWaiting: T('Ohne Rückmeldung schließen'),
  matrix: (i: string, u: string) => T(`Priorität ${IMPACTS[i as keyof typeof IMPACTS].split(' /')[0]} + ${URGENCIES[u as keyof typeof URGENCIES].split(' –')[0]}`),
};
const OVERVIEWS = {
  open: 'Neu und in Bearbeitung', mine: 'Meine offenen Tickets', waiting: 'Warten', resolved: 'Gelöst', escalated: 'Eskaliert', incidents: 'Offene Störungen',
};
// „Wartet auf Freigabe“, „Störungen“, „Wartungen“ und „Probleme“ pflegt die Zammad-Einrichtung des Portals selbst

const norm = (s: string) => optionKey(s);

interface Ctx {
  info: SetupInfo;
  existing: Record<AdminKind, { id: number; name: string; [k: string]: unknown }[]>;
  priorities: { id: number; name: string }[];
}

async function context(c: Connector): Promise<Ctx> {
  const info = await c.setupInfo();
  const kinds: AdminKind[] = ['calendars', 'slas', 'triggers', 'jobs', 'overviews', 'roles'];
  const lists = await Promise.all(kinds.map((k) => c.adminList(k)));
  const meta = await c.metadata();
  return { info, existing: Object.fromEntries(kinds.map((k, i) => [k, lists[i]])) as Ctx['existing'], priorities: meta.priorities };
}

/** Vorhandenes Feld mit gleicher Bedeutung (Anzeige oder Name), aber anderem Namen */
function similarAttr(info: SetupInfo, own: string, display: string) {
  return info.attributes.find((a) => a.name !== own && (norm(a.display) === norm(display) || norm(a.name) === norm(display)));
}

/** Was die Grundausstattung anlegen würde – mit Stand in Zammad */
export function plan(ctx: Ctx, o: BaselineOptions): BaselineItem[] {
  const items: BaselineItem[] = [];
  const add = (part: BaselinePart, kind: ItemKind, name: string, exists: boolean, skip?: string) => {
    if (o.parts[part]) items.push({ part, kind, name, status: skip ? 'übersprungen' : exists ? 'vorhanden' : 'neu', ...(skip ? { note: skip } : {}) });
  };
  const attrExists = (n: string) => ctx.info.attributes.some((a) => a.name === n);
  const has = (k: AdminKind, n: string) => ctx.existing[k].some((x) => x.name === n);

  const typeSimilar = similarAttr(ctx.info, ATTR.type, ATTR_DISPLAY.type);
  add('types', 'attribute', ATTR_DISPLAY.type, attrExists(ATTR.type), !attrExists(ATTR.type) && typeSimilar ? `Es gibt schon „${typeSimilar.display}“ (${typeSimilar.name}) – wird genutzt statt doppelt angelegt.` : undefined);

  const impSimilar = similarAttr(ctx.info, ATTR.impact, ATTR_DISPLAY.impact);
  const urgSimilar = similarAttr(ctx.info, ATTR.urgency, ATTR_DISPLAY.urgency);
  const matrixSkip = (!attrExists(ATTR.impact) && impSimilar) || (!attrExists(ATTR.urgency) && urgSimilar)
    ? `Es gibt schon ${[impSimilar && `„${impSimilar.display}“`, urgSimilar && `„${urgSimilar.display}“`].filter(Boolean).join(' und ')} – die Prioritätsmatrix wird übersprungen, damit nichts doppelt ist.` : undefined;
  add('priority', 'attribute', ATTR_DISPLAY.impact, attrExists(ATTR.impact), matrixSkip);
  add('priority', 'attribute', ATTR_DISPLAY.urgency, attrExists(ATTR.urgency), matrixSkip);
  for (const p of PRIORITY_NAMES) add('priority', 'priority', p, ctx.priorities.some((x) => x.name === p), matrixSkip);
  for (const i of Object.keys(IMPACTS)) for (const u of Object.keys(URGENCIES)) add('priority', 'trigger', NAMES.matrix(i, u), has('triggers', NAMES.matrix(i, u)), matrixSkip);

  for (const s of Object.values(STATE_NAMES)) add('states', 'state', s, ctx.info.states.some((x) => x.name === s));

  add('sla', 'calendar', o.calendar.name, has('calendars', o.calendar.name));
  PRIORITY_NAMES.forEach((p) => add('sla', 'sla', `SLA ${p}`, has('slas', `SLA ${p}`), !o.parts.priority && !ctx.priorities.some((x) => x.name === p) ? 'Braucht die Prioritäten P1 bis P4 (Teil „Priorität“).' : undefined));

  add('messages', 'trigger', NAMES.ack, has('triggers', NAMES.ack));
  add('messages', 'trigger', NAMES.reply, has('triggers', NAMES.reply));
  add('messages', 'trigger', NAMES.resolved, has('triggers', NAMES.resolved));
  add('messages', 'trigger', NAMES.reopen, has('triggers', NAMES.reopen));

  add('autoClose', 'job', NAMES.close, has('jobs', NAMES.close));
  add('autoClose', 'job', NAMES.remind, has('jobs', NAMES.remind));
  add('autoClose', 'job', NAMES.closeWaiting, has('jobs', NAMES.closeWaiting));

  add('escalation', 'trigger', NAMES.esc1, has('triggers', NAMES.esc1));
  add('escalation', 'trigger', NAMES.escReset, has('triggers', NAMES.escReset));
  add('escalation', 'job', NAMES.esc2, has('jobs', NAMES.esc2), !o.escalation.stage2Email ? 'Keine Adresse für Stufe 2 angegeben.' : undefined);

  for (const n of Object.values(OVERVIEWS)) add('overviews', 'overview', n, has('overviews', n));
  // Status-Abhängigkeiten: ohne eigene Status nutzen Nachrichten, Schließen und Übersichten die vorhandenen
  return items;
}

export async function previewBaseline(app: App, sys: SystemRow, o: BaselineOptions): Promise<BaselineItem[]> {
  return plan(await context(connectorFor(app, sys)), o);
}

// ------------------------------------------------------------------------------------------ Anlegen

const mail = (subject: string, body: string, recipient: string[]) => ({
  'notification.email': { recipient, subject, body, internal: 'false', include_attachments: 'false' },
});
const days = (list: readonly string[]) => Object.fromEntries(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => [d, list.includes(d)]));
const HOURLY = { days: days(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']), hours: Object.fromEntries(Array.from({ length: 24 }, (_, i) => [String(i), true])), minutes: { 0: true } };

function texts(o: BaselineOptions) {
  const link = o.customerLink ? `<p><a href="${o.customerLink}">Ihre Tickets im Self-Service-Portal</a></p>` : '';
  const sig = '<p>Ihr IT-Service</p>';
  return {
    ack: { s: 'Ihre Anfrage ist eingegangen [Ticket##{ticket.number}]', b: '<p>Guten Tag #{ticket.customer.firstname} #{ticket.customer.lastname},</p><p>wir haben Ihre Anfrage „#{ticket.title}“ erhalten und kümmern uns darum. Ihre Ticketnummer lautet <b>#{ticket.number}</b>.</p>' + link + sig },
    reply: { s: 'Neue Nachricht zu Ihrem Ticket [Ticket##{ticket.number}]', b: '<p>Guten Tag #{ticket.customer.firstname} #{ticket.customer.lastname},</p><p>zu Ihrem Ticket „#{ticket.title}“ gibt es eine neue Nachricht:</p><blockquote>#{article.body_as_html}</blockquote><p>Sie können einfach auf diese E-Mail antworten.</p>' + link + sig },
    resolved: { s: 'Ihr Ticket ist gelöst [Ticket##{ticket.number}]', b: `<p>Guten Tag #{ticket.customer.firstname} #{ticket.customer.lastname},</p><p>wir haben Ihr Ticket „#{ticket.title}“ als gelöst markiert. Falls noch etwas offen ist, antworten Sie einfach auf diese E-Mail – dann öffnen wir es wieder. Ohne Antwort schließen wir es nach ${o.autoClose.resolvedDays} Tagen.</p>` + link + sig },
    remind: { s: 'Wir warten auf Ihre Rückmeldung [Ticket##{ticket.number}]', b: `<p>Guten Tag #{ticket.customer.firstname} #{ticket.customer.lastname},</p><p>für Ihr Ticket „#{ticket.title}“ brauchen wir noch eine Rückmeldung von Ihnen. Bitte antworten Sie auf diese E-Mail. Ohne Antwort schließen wir das Ticket in ${o.autoClose.closeDays - o.autoClose.remindDays} Tagen.</p>` + link + sig },
    closedWaiting: { s: 'Ihr Ticket wurde geschlossen [Ticket##{ticket.number}]', b: '<p>Guten Tag #{ticket.customer.firstname} #{ticket.customer.lastname},</p><p>da wir keine Rückmeldung erhalten haben, haben wir Ihr Ticket „#{ticket.title}“ geschlossen. Wenn das Anliegen noch besteht, antworten Sie einfach auf diese E-Mail.</p>' + link + sig },
    esc1: { s: 'Eskalation: Ticket ##{ticket.number} – SLA-Zeit abgelaufen', b: '<p>Für das Ticket „#{ticket.title}“ (Priorität #{ticket.priority.name}, Gruppe #{ticket.group.name}) ist eine SLA-Zeit abgelaufen.</p><p><a href="#{config.http_type}://#{config.fqdn}/#ticket/zoom/#{ticket.id}">Ticket öffnen</a></p>' },
    esc2: { s: 'Eskalation Stufe 2: Ticket ##{ticket.number}', b: `<p>Das Ticket „#{ticket.title}“ (Priorität #{ticket.priority.name}, Gruppe #{ticket.group.name}, Besitzer #{ticket.owner.fullname}) ist seit über ${o.escalation.stage2Hours} Stunden eskaliert.</p><p><a href="#{config.http_type}://#{config.fqdn}/#ticket/zoom/#{ticket.id}">Ticket öffnen</a></p>` },
  };
}

export async function applyBaseline(app: App, sys: SystemRow, o: BaselineOptions): Promise<{ items: BaselineItem[]; created: string[]; errors: string[] }> {
  const c = connectorFor(app, sys);
  let ctx = await context(c);
  const items = plan(ctx, o);
  const todo = (kind: ItemKind, name: string) => items.some((i) => i.kind === kind && i.name === name && i.status === 'neu');
  const created: string[] = [];
  const errors: string[] = [];
  const step = async (label: string, fn: () => Promise<unknown>) => {
    try { await fn(); created.push(label); } catch (err) { errors.push(`${label}: ${(err as Error).message}`); }
  };
  const tx = texts(o);

  // 1. Felder
  let migrate = false;
  const attr = async (name: string, display: string, options: Record<string, string>, position: number) => {
    if (!todo('attribute', display)) return;
    await step(`Feld „${display}“`, () => c.saveAttribute({ name, display, dataType: 'select', options, position }));
    migrate = true;
  };
  await attr(ATTR.type, ATTR_DISPLAY.type, { ...TICKET_TYPES }, 1100);
  await attr(ATTR.impact, ATTR_DISPLAY.impact, { ...IMPACTS }, 1110);
  await attr(ATTR.urgency, ATTR_DISPLAY.urgency, { ...URGENCIES }, 1120);
  if (migrate) await c.executeMigrations().catch((err) => errors.push(`Felder aktivieren: ${(err as Error).message}`));

  // 2. Status und Prioritäten
  const stateOpts: Record<string, [StateType, boolean]> = {
    [STATE_NAMES.working]: ['open', false], [STATE_NAMES.waitingCustomer]: ['open', true], [STATE_NAMES.waitingThird]: ['open', true], [STATE_NAMES.resolved]: ['closed', false],
  };
  for (const [name, [like, ignore]] of Object.entries(stateOpts)) if (todo('state', name)) await step(`Status „${name}“`, () => c.createState(name, like, { ignoreEscalation: ignore }));
  for (const p of PRIORITY_NAMES) if (todo('priority', p)) await step(`Priorität „${p}“`, () => c.adminCreate('ticket_priorities', { name: p, active: true, note: 'ITSM-Grundausstattung (Self-Service-Portal)' }));
  ctx = await context(c);
  const stateId = (n: string) => ctx.info.states.find((s) => s.name === n)?.id;
  const prioId = (n: string) => ctx.priorities.find((x) => x.name === n)?.id;
  const ids = (...list: (number | undefined)[]) => list.filter((x): x is number => x !== undefined).map(String);
  // Status nach Typ statt Namen – Installationen benennen sie oft um
  const m = getMapping(app, sys);
  const waitingNames: string[] = [STATE_NAMES.waitingCustomer, STATE_NAMES.waitingThird, m.approval.state];
  const active = ctx.info.states.filter((s) => s.active);
  const open = ids(...active.filter((s) => (s.type === 'new' || s.type === 'open') && !waitingNames.includes(s.name)).map((s) => s.id));
  const waiting = ids(stateId(STATE_NAMES.waitingCustomer), stateId(STATE_NAMES.waitingThird));
  const resolvedId = stateId(STATE_NAMES.resolved);
  const closedName = pickState(ctx.info.states.filter((s) => s.name !== STATE_NAMES.resolved), 'closed', m);
  const closedId = closedName ? stateId(closedName) : undefined;
  const notClosed = ids(...active.filter((s) => s.type !== 'closed' && s.type !== 'merged' && s.type !== 'removed').map((s) => s.id));

  // 3. Prioritätsmatrix
  for (const [i, row] of Object.entries(MATRIX)) for (const [u, idx] of Object.entries(row)) {
    const name = NAMES.matrix(i, u);
    const pid = prioId(PRIORITY_NAMES[idx]);
    if (!todo('trigger', name) || !pid) continue;
    await step(`Trigger „${name}“`, () => c.adminCreate('triggers', {
      name, active: true, activator: 'action', execution_condition_mode: 'selective',
      condition: { [`ticket.${ATTR.impact}`]: { operator: 'is', value: [i] }, [`ticket.${ATTR.urgency}`]: { operator: 'is', value: [u] } },
      perform: { 'ticket.priority_id': { value: String(pid) } },
      note: `Prioritätsmatrix: ${IMPACTS[i as keyof typeof IMPACTS]} × ${URGENCIES[u as keyof typeof URGENCIES]} → ${PRIORITY_NAMES[idx]}`,
    }));
  }

  // 4. Kalender und SLAs
  let calendarId = (ctx.existing.calendars.find((x) => x.name === o.calendar.name)?.id);
  if (todo('calendar', o.calendar.name)) {
    await step(`Kalender „${o.calendar.name}“`, async () => {
      calendarId = (await c.adminCreate('calendars', {
        name: o.calendar.name, timezone: o.calendar.timezone, default: false, ical_url: '', public_holidays: {},
        business_hours: Object.fromEntries(WEEKDAYS.map((d) => [d, { active: o.calendar.days.includes(d), timeframes: [[o.calendar.from, o.calendar.to]] }])),
      })).id;
    });
  }
  for (const [idx, p] of PRIORITY_NAMES.entries()) {
    const name = `SLA ${p}`;
    const pid = prioId(p);
    if (!todo('sla', name) || !pid || !calendarId) continue;
    await step(`SLA „${name}“`, () => c.adminCreate('slas', {
      name, calendar_id: calendarId, condition: { 'ticket.priority_id': { operator: 'is', value: [String(pid)] } },
      first_response_time: o.sla.response[idx], solution_time: o.sla.solution[idx], update_time: null,
    }));
  }

  // 5. Automatische Nachrichten
  const trigger = (name: string, condition: Record<string, unknown>, perform: Record<string, unknown>, activator: 'action' | 'time' = 'action') =>
    todo('trigger', name) ? step(`Trigger „${name}“`, () => c.adminCreate('triggers', { name, active: true, activator, execution_condition_mode: 'selective', condition, perform, note: 'ITSM-Grundausstattung (Self-Service-Portal)' })) : Promise.resolve();
  await trigger(NAMES.ack,
    { 'ticket.action': { operator: 'is', value: 'create' }, 'article.sender_id': { operator: 'is', value: [SENDER.customer] }, 'article.type_id': { operator: 'is', value: [TYPE.email, TYPE.phone, TYPE.web] } },
    mail(tx.ack.s, tx.ack.b, ['ticket_customer']));
  await trigger(NAMES.reply,
    { 'ticket.action': { operator: 'is', value: 'update' }, 'article.sender_id': { operator: 'is', value: [SENDER.agent] }, 'article.internal': { operator: 'is', value: 'false' }, 'article.type_id': { operator: 'is', value: [TYPE.note, TYPE.web] } },
    mail(tx.reply.s, tx.reply.b, ['ticket_customer']));
  if (resolvedId) await trigger(NAMES.resolved,
    { 'ticket.action': { operator: 'is', value: 'update' }, 'ticket.state_id': { operator: 'is', value: [String(resolvedId)] } },
    mail(tx.resolved.s, tx.resolved.b, ['ticket_customer']));
  const workingName = stateId(STATE_NAMES.working) ? STATE_NAMES.working : pickState(ctx.info.states, 'open', m);
  const working = workingName ? stateId(workingName) : undefined;
  if (working) await trigger(NAMES.reopen,
    { 'ticket.action': { operator: 'is', value: 'update' }, 'article.sender_id': { operator: 'is', value: [SENDER.customer] }, 'ticket.state_id': { operator: 'is', value: [...waiting, ...(resolvedId ? [String(resolvedId)] : [])] } },
    { 'ticket.state_id': { value: String(working) }, 'ticket.tags': { operator: 'remove', value: TAG.reminded } });

  // 6. Automatisch schließen
  const job = (name: string, condition: Record<string, unknown>, perform: Record<string, unknown>) =>
    todo('job', name) ? step(`Automatisierung „${name}“`, () => c.adminCreate('jobs', { name, active: true, timeplan: HOURLY, condition, perform, note: 'ITSM-Grundausstattung (Self-Service-Portal)' })) : Promise.resolve();
  if (resolvedId && closedId) await job(NAMES.close,
    { 'ticket.state_id': { operator: 'is', value: [String(resolvedId)] }, 'ticket.updated_at': { operator: 'before (relative)', value: String(o.autoClose.resolvedDays), range: 'day' } },
    { 'ticket.state_id': { value: String(closedId) } });
  const waitCustomer = stateId(STATE_NAMES.waitingCustomer);
  if (waitCustomer) await job(NAMES.remind,
    { 'ticket.state_id': { operator: 'is', value: [String(waitCustomer)] }, 'ticket.last_contact_agent_at': { operator: 'before (relative)', value: String(o.autoClose.remindDays), range: 'day' }, 'ticket.tags': { operator: 'contains none', value: TAG.reminded } },
    { ...mail(tx.remind.s, tx.remind.b, ['ticket_customer']), 'ticket.tags': { operator: 'add', value: TAG.reminded } });
  if (waitCustomer && closedId) await job(NAMES.closeWaiting,
    { 'ticket.state_id': { operator: 'is', value: [String(waitCustomer)] }, 'ticket.last_contact_agent_at': { operator: 'before (relative)', value: String(o.autoClose.closeDays), range: 'day' } },
    { ...mail(tx.closedWaiting.s, tx.closedWaiting.b, ['ticket_customer']), 'ticket.state_id': { value: String(closedId) } });

  // 7. Eskalation
  await trigger(NAMES.esc1,
    { 'ticket.escalation_at': { operator: 'has reached' }, 'ticket.state_id': { operator: 'is', value: notClosed } },
    { 'ticket.tags': { operator: 'add', value: TAG.escalated }, ...mail(tx.esc1.s, tx.esc1.b, ['ticket_owner', 'ticket_agents']) }, 'time');
  await trigger(NAMES.escReset,
    { 'ticket.action': { operator: 'is', value: 'update' }, 'article.sender_id': { operator: 'is', value: [SENDER.agent] }, 'article.internal': { operator: 'is', value: 'false' }, 'ticket.tags': { operator: 'contains one', value: TAG.escalated } },
    { 'ticket.tags': { operator: 'remove', value: `${TAG.escalated}, ${TAG.escalated2}` } });
  if (o.escalation.stage2Email && todo('job', NAMES.esc2)) {
    const ref = await c.findCustomer(o.escalation.stage2Email).catch(() => null);
    if (!ref) errors.push(`Eskalation Stufe 2: ${o.escalation.stage2Email} ist kein Benutzer in Zammad – bitte dort anlegen und erneut ausführen.`);
    else await job(NAMES.esc2,
      { 'ticket.tags': { operator: 'contains all', value: TAG.escalated }, 'ticket.escalation_at': { operator: 'before (relative)', value: String(o.escalation.stage2Hours), range: 'hour' }, 'ticket.state_id': { operator: 'is', value: notClosed } },
      { ...mail(tx.esc2.s, tx.esc2.b, [`userid_${ref.customerId}`]), 'ticket.tags': { operator: 'add', value: TAG.escalated2 } });
  }

  // 8. Übersichten für Agenten
  const agentRole = ctx.existing.roles.find((r) => r.name === 'Agent')?.id;
  const typeAttr = ctx.info.attributes.find((a) => a.name === ATTR.type) ?? similarAttr(ctx.info, ATTR.type, ATTR_DISPLAY.type);
  const incidentValue = typeAttr ? Object.entries(typeAttr.options).find(([k, l]) => k === 'stoerung' || norm(l) === 'stoerung')?.[0] : undefined;
  let prio = 100;
  const overview = (name: string, condition: Record<string, unknown>) => {
    prio += 10;
    if (!todo('overview', name) || !agentRole) return Promise.resolve();
    const p = prio;
    return step(`Übersicht „${name}“`, () => c.adminCreate('overviews', {
      name, link: optionKey(name), prio: p, active: true, role_ids: [agentRole], condition,
      order: { by: 'created_at', direction: 'ASC' }, group_by: '',
      view: { d: ['title', 'customer', 'group', 'state', 'priority', 'created_at'], s: ['number', 'title', 'customer', 'group', 'state', 'priority', 'escalation_at', 'created_at'], m: ['number', 'title', 'customer', 'group', 'state', 'priority', 'created_at'], view_mode_default: 's' },
    }));
  };
  await overview(OVERVIEWS.open, { 'ticket.state_id': { operator: 'is', value: open } });
  await overview(OVERVIEWS.mine, { 'ticket.state_id': { operator: 'is', value: notClosed }, 'ticket.owner_id': { operator: 'is', pre_condition: 'current_user.id', value: [] } });
  if (waiting.length) await overview(OVERVIEWS.waiting, { 'ticket.state_id': { operator: 'is', value: waiting } });
  if (resolvedId) await overview(OVERVIEWS.resolved, { 'ticket.state_id': { operator: 'is', value: [String(resolvedId)] } });
  await overview(OVERVIEWS.escalated, { 'ticket.tags': { operator: 'contains one', value: TAG.escalated }, 'ticket.state_id': { operator: 'is', value: notClosed } });
  if (typeAttr && incidentValue) await overview(OVERVIEWS.incidents, { [`ticket.${typeAttr.name}`]: { operator: 'is', value: [incidentValue] }, 'ticket.state_id': { operator: 'is', value: notClosed } });

  log.info('ITSM-Grundausstattung', { system: sys.slug, angelegt: created.length, fehler: errors.length });
  return { items: plan(await context(c), o), created, errors };
}

export { BASELINE_PART_INFO };
