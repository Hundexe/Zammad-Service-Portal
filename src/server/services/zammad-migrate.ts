// Übernahme aus 1.x: Störungen, Wartungen und Probleme aus den alten Portal-Tabellen werden Tickets in Zammad.
// Aufruf über die Kommandozeile („zammad:migrate“, erst mit --dry-run ansehen). Jede Zeile wird nur einmal übernommen
// (legacy_migrated); ein zweiter Lauf setzt nach einem Abbruch fort. Die alten Tabellen bleiben unverändert stehen.
import type { App } from '../app.ts';
import { parseJson } from '../db/db.ts';
import { log } from '../log.ts';
import { connectorFor, getSystem, listSystems, type SystemRow } from './systems.ts';
import { applySetup, checkSetup, getMapping, listValue, locationChoices } from './zammad-setup.ts';
import { createKindTicket, invalidate, serviceKeys } from './itsm.ts';
import { resolveState } from './zammad-states.ts';
import { customerFor } from './requests.ts';
import { escapeHtml, textToHtml } from '../../shared/template.ts';
import { INCIDENT_STATE_LABEL, incidentNumber, problemNumber, type IncidentState } from '../../shared/itsm.ts';

const fmt = (t: number) => new Date(t).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

export interface MigrationPlan { system: string; incidents: number; maintenances: number; problems: number; ready: boolean; issues: string[] }
export interface MigrationResult { system: string; incidents: number; maintenances: number; problems: number; errors: string[] }

const done = (app: App, kind: string, id: string) => Boolean(app.db.get('SELECT 1 FROM legacy_migrated WHERE kind = ? AND legacy_id = ?', kind, id));
const mark = (app: App, kind: string, id: string, sys: string, ticket: number) =>
  app.db.run('INSERT INTO legacy_migrated (kind, legacy_id, system_id, ticket_id, migrated_at) VALUES (?, ?, ?, ?, ?)', kind, id, sys, ticket, Date.now());
const ticketOf = (app: App, kind: string, id: string) => app.db.get<{ ticket_id: number }>('SELECT ticket_id FROM legacy_migrated WHERE kind = ? AND legacy_id = ?', kind, id)?.ticket_id ?? null;
const hasTable = (app: App, name: string) => Boolean(app.db.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", name));

function locationKeys(app: App, sys: SystemRow, labels: string[]): string[] {
  const choices = locationChoices(app, sys);
  return labels.map((l) => choices.find((c) => c.label === l || c.value === l)?.value).filter((x): x is string => Boolean(x));
}

/** Was übernommen würde (ohne etwas zu ändern) */
export async function planMigration(app: App): Promise<MigrationPlan[]> {
  if (!hasTable(app, 'incidents')) return [];
  const out: MigrationPlan[] = [];
  for (const sys of listSystems(app)) {
    const count = (table: string, kind: string) => app.db.all<{ id: string }>(`SELECT id FROM ${table} WHERE system_id = ?`, sys.id).filter((r) => !done(app, kind, r.id)).length;
    const plan = { system: sys.name, incidents: count('incidents', 'incident'), maintenances: count('maintenances', 'maintenance'), problems: count('problems', 'problem'), ready: true, issues: [] as string[] };
    if (plan.incidents + plan.maintenances + plan.problems === 0) continue;
    const r = await checkSetup(app, sys);
    // Fehlende Auswahlwerte (z. B. neue Services) ergänzt der Lauf selbst; Gruppen, Status und Attribute nicht
    if (r.error || r.missing.groups.length || r.missing.states.length || r.missing.attributes.length) {
      plan.ready = false;
      plan.issues.push(r.error ?? 'Zammad ist noch nicht eingerichtet – zuerst „In Zammad einrichten“ (Verwaltung → Ticketsysteme → Zammad-Zuordnung).');
    }
    out.push(plan);
  }
  return out;
}

export async function runMigration(app: App): Promise<MigrationResult[]> {
  const out: MigrationResult[] = [];
  for (const plan of await planMigration(app)) {
    const sys = listSystems(app).find((s) => s.name === plan.system)!;
    const res: MigrationResult = { system: sys.name, incidents: 0, maintenances: 0, problems: 0, errors: [] };
    out.push(res);
    if (!plan.ready) { res.errors.push(...plan.issues); continue; }
    if (!(await checkSetup(app, sys)).ready) await applySetup(app, sys).catch((err) => res.errors.push(`Einrichtung: ${(err as Error).message}`));
    const m = getMapping(app, sys);
    const c = connectorFor(app, sys);
    const svc = (ids: (string | null)[]) => listValue(app, sys, 'services', serviceKeys(app, sys.id, ids.filter((x): x is string => Boolean(x))));

    // Probleme zuerst – Störungen verweisen darauf
    for (const pr of app.db.all<{ id: string; number: number; title: string; state: string; service_id: string | null; description: string; root_cause: string; workaround: string; public: number; owner: string; created_at: number }>(
      'SELECT * FROM problems WHERE system_id = ? ORDER BY number', sys.id)) {
      if (done(app, 'problem', pr.id)) continue;
      try {
        const t = await createKindTicket(app, sys, 'problem', pr.title, 'Beschreibung', pr.description || pr.title, {
          [m.attrs.problemStatus]: pr.state === 'closed' ? 'resolved' : pr.state, [m.attrs.public]: pr.public === 1,
          [m.attrs.workaround]: pr.workaround, [m.attrs.rootCause]: pr.root_cause, [m.attrs.services]: svc([pr.service_id]),
        });
        mark(app, 'problem', pr.id, sys.id, t.id);
        await c.addArticle(t.id, { type: 'note', internal: true, subject: 'Übernommen aus dem Portal', body: `<p>${escapeHtml(problemNumber(pr.number))}, angelegt am ${escapeHtml(fmt(pr.created_at))}${pr.owner ? `, verantwortlich: ${escapeHtml(pr.owner)}` : ''}.</p>` });
        for (const lt of app.db.all<{ ticket_id: number }>('SELECT ticket_id FROM problem_tickets WHERE problem_id = ?', pr.id)) {
          await c.addLink(t.number, lt.ticket_id, 'normal').catch(() => undefined);
          await c.updateTicket(lt.ticket_id, { fields: { [m.attrs.problemRef]: t.id } }).catch(() => undefined);
        }
        if (pr.state === 'closed') await c.updateTicket(t.id, { state: await resolveState(app, sys, m, 'closed') });
        res.problems++;
      } catch (err) { res.errors.push(`${problemNumber(pr.number)}: ${(err as Error).message}`); }
    }

    for (const inc of app.db.all<{ id: string; number: number; title: string; impact: string; major: number; state: IncidentState; locations: string; started_at: number; resolved_at: number | null; zammad_ticket_id: number | null; problem_id: string | null }>(
      'SELECT * FROM incidents WHERE system_id = ? ORDER BY number', sys.id)) {
      if (done(app, 'incident', inc.id)) continue;
      try {
        const updates = app.db.all<{ state: IncidentState; body: string; created_at: number }>('SELECT state, body, created_at FROM incident_updates WHERE incident_id = ? ORDER BY created_at', inc.id);
        const first = updates.shift();
        const services = app.db.all<{ service_id: string }>('SELECT service_id FROM incident_services WHERE incident_id = ?', inc.id).map((r) => r.service_id);
        const problemTicket = inc.problem_id ? ticketOf(app, 'problem', inc.problem_id) : null;
        const t = await createKindTicket(app, sys, 'incident', inc.title, INCIDENT_STATE_LABEL[first?.state ?? 'investigating'], first ? `${first.body}\n\n(${fmt(first.created_at)})` : inc.title, {
          [m.attrs.public]: true, [m.attrs.impact]: inc.impact, [m.attrs.major]: inc.major === 1,
          [m.attrs.phase]: inc.state === 'resolved' ? 'monitoring' : inc.state, [m.attrs.incidentStart]: new Date(inc.started_at).toISOString(),
          [m.attrs.services]: svc(services), [m.attrs.locations]: listValue(app, sys, 'locations', locationKeys(app, sys, parseJson<string[]>(inc.locations, []))),
          ...(inc.resolved_at ? { [m.attrs.incidentEnd]: new Date(inc.resolved_at).toISOString() } : {}),
          ...(problemTicket ? { [m.attrs.problemRef]: problemTicket } : {}),
        });
        mark(app, 'incident', inc.id, sys.id, t.id);
        for (const u of updates) await c.addArticle(t.id, { type: 'note', internal: false, subject: INCIDENT_STATE_LABEL[u.state], body: textToHtml(`${u.body}\n\n(${fmt(u.created_at)})`) });
        const affected = app.db.get<{ n: number }>('SELECT COUNT(*) n FROM incident_affected WHERE incident_id = ?', inc.id)!.n;
        await c.addArticle(t.id, { type: 'note', internal: true, subject: 'Übernommen aus dem Portal', body: `<p>${escapeHtml(incidentNumber(inc.number))}; ${affected} Personen hatten sich als betroffen gemeldet.</p>` });
        if (inc.zammad_ticket_id) await c.addLink(t.number, inc.zammad_ticket_id, 'normal').catch(() => undefined);
        if (problemTicket) {
          const pt = await c.getTicketFull(problemTicket);
          if (pt) await c.addLink(pt.number, t.id, 'normal').catch(() => undefined);
        }
        if (inc.state === 'resolved') await c.updateTicket(t.id, { state: await resolveState(app, sys, m, 'closed') });
        else {
          // Noch offen: Betroffene bekommen ihr Ticket wie bei „Ich bin auch betroffen“
          for (const a of app.db.all<{ id: string; email: string | null; display_name: string }>('SELECT u.id, u.email, u.display_name FROM incident_affected a JOIN users u ON u.id = a.user_id WHERE a.incident_id = ?', inc.id)) {
            if (!a.email) continue;
            const customer = await customerFor(app, sys, a.id, a.email, a.display_name, true);
            const child = await c.createTicket({
              customer: customer!, title: `Betroffen: ${inc.title}`, group: t.group ?? sys.default_group ?? '', state: await resolveState(app, sys, m, 'new'),
              bodyHtml: `<p>${escapeHtml(a.display_name)} ist von der Störung „${escapeHtml(inc.title)}“ betroffen (übernommen aus dem Portal).</p>`,
              attachments: [], fields: { [m.attrs.incidentRef]: t.id }, tags: m.affectedTags,
            });
            await c.addLink(t.number, child.id, 'parent').catch(() => undefined);
          }
        }
        res.incidents++;
      } catch (err) { res.errors.push(`${incidentNumber(inc.number)}: ${(err as Error).message}`); }
    }

    for (const mt of app.db.all<{ id: string; title: string; body: string; starts_at: number; ends_at: number; locations: string; cancelled: number }>(
      'SELECT * FROM maintenances WHERE system_id = ? ORDER BY starts_at', sys.id)) {
      if (done(app, 'maintenance', mt.id)) continue;
      try {
        const services = app.db.all<{ service_id: string }>('SELECT service_id FROM maintenance_services WHERE maintenance_id = ?', mt.id).map((r) => r.service_id);
        const t = await createKindTicket(app, sys, 'maintenance', mt.title, 'Wartung angekündigt', mt.body, {
          [m.attrs.public]: true, [m.attrs.maintStart]: new Date(mt.starts_at).toISOString(), [m.attrs.maintEnd]: new Date(mt.ends_at).toISOString(),
          [m.attrs.services]: svc(services), [m.attrs.locations]: listValue(app, sys, 'locations', locationKeys(app, sys, parseJson<string[]>(mt.locations, []))),
        });
        mark(app, 'maintenance', mt.id, sys.id, t.id);
        if (mt.cancelled) await c.addArticle(t.id, { type: 'note', internal: false, subject: 'Wartung abgesagt', body: '<p>Die Wartung findet nicht statt.</p>' });
        if (mt.cancelled || mt.ends_at <= Date.now()) await c.updateTicket(t.id, { state: await resolveState(app, sys, m, 'closed') });
        res.maintenances++;
      } catch (err) { res.errors.push(`Wartung „${mt.title}“: ${(err as Error).message}`); }
    }
    invalidate(sys.id);
    log.info('Übernahme nach Zammad', { ...res, errors: res.errors.length });
  }
  return out;
}

export { getSystem };
