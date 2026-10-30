// Status-Seite, Störungen, Wartungen, Probleme und Funktionsschalter.
// Portal: eine Seite für alle Ticketsysteme, die die Person sieht. Verwaltung: eine Seite für alle Ticketsysteme,
// in denen die Person „Services, Störungen und Wartungen verwalten“ bzw. „Probleme verwalten“ darf.
import type { App } from '../app.ts';
import { HttpError, type Router, type RouteOptions } from '../http/core.ts';
import type { AppCtx } from '../server.ts';
import { audit, diff } from '../services/audit.ts';
import { can } from '../services/rbac.ts';
import { getSystem, listSystems, systemVisibleTo, type SystemRow } from '../services/systems.ts';
import { getFeatures, saveFeatures } from '../services/features.ts';
import {
  addIncidentUpdate, createIncident, getIncident, getMaintenance, getProblem, incidentPublic, linkProblemTicket, maintenancePublic,
  problemTickets, saveMaintenance, saveProblem, saveService, serviceStates, servicesOf, setAffected, statusBanner, statusOverview,
  unlinkProblemTicket, updateIncident, type IncidentRow, type MaintenanceRow, type ProblemRow, type ServiceRow,
} from '../services/itsm.ts';
import { FEATURE_INFO, incidentNumber, incidentTag, itsmEnabled, normalizeFeatures, problemNumber, problemTag } from '../../shared/itsm.ts';

type Body = Record<string, unknown>;
const actor = (ctx: AppCtx) => ({ id: ctx.user!.id, name: ctx.user!.displayName, ip: ctx.ip });
const body = (ctx: AppCtx): Body => (ctx.body && typeof ctx.body === 'object' && !Array.isArray(ctx.body) ? ctx.body as Body : {});

export function registerItsmRoutes(router: Router, app: App): void {
  const user = { auth: 'user' as const };
  const admin = (permission?: string | string[], extra: Partial<RouteOptions> = {}): RouteOptions => ({ auth: 'user', adminNet: true, permission, ...extra });

  function needFeature(key: 'status' | 'incidents' | 'maintenance' | 'problems'): void {
    if (!getFeatures(app)[key]) throw new HttpError(404, 'Diese Funktion ist ausgeschaltet', 'feature_off');
  }
  function sysOr404(id: string): SystemRow {
    const s = getSystem(app, id);
    if (!s) throw new HttpError(404, 'Ticketsystem nicht gefunden', 'not_found');
    return s;
  }
  const names = () => new Map(listSystems(app).map((s) => [s.id, s.name]));
  const userName = (id: string | null) => (id ? app.db.get<{ display_name: string }>('SELECT display_name FROM users WHERE id = ?', id)?.display_name ?? '' : '');

  // =========================================================================================== Portal

  router.get('/api/portal/status', user, (ctx: AppCtx) => {
    if (!itsmEnabled(getFeatures(app))) throw new HttpError(404, 'Diese Funktion ist ausgeschaltet', 'feature_off');
    return statusOverview(app, ctx.user!);
  });

  router.get('/api/portal/status/banner', user, (ctx: AppCtx) => statusBanner(app, ctx.user!));

  function visibleIncident(ctx: AppCtx): IncidentRow {
    needFeature('incidents');
    const inc = getIncident(app, ctx.params.incidentId);
    const sys = inc ? getSystem(app, inc.system_id) : undefined;
    if (!inc || !sys || !systemVisibleTo(sys, ctx.user!)) throw new HttpError(404, 'Störung nicht gefunden', 'not_found');
    return inc;
  }

  router.get('/api/portal/incidents/:incidentId', user, (ctx: AppCtx) => {
    const inc = visibleIncident(ctx);
    const sys = getSystem(app, inc.system_id)!;
    const services = servicesOf(app, [sys.id]);
    const problem = inc.problem_id && getFeatures(app).problems ? getProblem(app, inc.problem_id) : undefined;
    return {
      incident: incidentPublic(app, inc, sys.name, ctx.user!.id),
      // Updates ohne Namen der Bearbeiter – im Portal spricht „die IT“
      updates: app.db.all<{ state: string; body: string; created_at: number }>('SELECT state, body, created_at FROM incident_updates WHERE incident_id = ? ORDER BY created_at DESC', inc.id)
        .map((u) => ({ state: u.state, body: u.body, at: u.created_at })),
      serviceNames: Object.fromEntries(services.map((s) => [s.id, s.name])),
      problem: problem && problem.public ? { number: problemNumber(problem.number), title: problem.title, workaround: problem.workaround } : null,
    };
  });

  router.post('/api/portal/incidents/:incidentId/affected', user, (ctx: AppCtx) => {
    const inc = visibleIncident(ctx);
    const affected = body(ctx).affected !== false;
    const count = setAffected(app, inc, ctx.user!, affected);
    return { affected, count: getFeatures(app).showAffectedCount ? count : null };
  });

  // =========================================================================================== Verwaltung

  router.get('/api/admin/settings/features', admin('settings.manage'), () => ({ features: getFeatures(app), info: FEATURE_INFO }));
  router.put('/api/admin/settings/features', admin('settings.manage'), (ctx: AppCtx) => {
    const before = getFeatures(app);
    let next;
    try { next = normalizeFeatures(body(ctx).features, before); } catch (err) { throw new HttpError(422, (err as Error).message, 'validation'); }
    saveFeatures(app, next);
    audit(app.db, actor(ctx), { action: 'settings.features', details: diff(before as any, next as any) });
    return { features: next };
  });

  /** Ticketsysteme, in denen die Person etwas pflegen darf */
  function manageable(ctx: AppCtx) {
    return listSystems(app).map((s) => ({ s, status: can(ctx.user, 'status.manage', s.id), problems: can(ctx.user, 'problem.manage', s.id) }))
      .filter((x) => x.status || x.problems);
  }

  /** Alles auf einer Seite: Services, Störungen, Wartungen und Probleme aller Ticketsysteme, die man pflegen darf */
  router.get('/api/admin/itsm', admin(), (ctx: AppCtx) => {
    const list = manageable(ctx);
    if (!list.length) throw new HttpError(403, 'Keine Berechtigung', 'forbidden');
    const f = getFeatures(app);
    const statusIds = list.filter((x) => x.status).map((x) => x.s.id);
    const problemIds = list.filter((x) => x.problems).map((x) => x.s.id);
    const n = names();
    const now = Date.now();
    const inList = (ids: string[]) => ids.map(() => '?').join(',') || "''";
    const services = servicesOf(app, [...new Set([...statusIds, ...problemIds])]);
    const states = serviceStates(app, services, now);
    const incidents = statusIds.length ? app.db.all<IncidentRow>(`SELECT * FROM incidents WHERE system_id IN (${inList(statusIds)}) AND (state != 'resolved' OR resolved_at > ?) ORDER BY state = 'resolved', started_at DESC LIMIT 200`, ...statusIds, now - 30 * 86400_000) : [];
    const maintenances = statusIds.length ? app.db.all<MaintenanceRow>(`SELECT * FROM maintenances WHERE system_id IN (${inList(statusIds)}) AND ends_at > ? ORDER BY starts_at DESC LIMIT 200`, ...statusIds, now - 30 * 86400_000) : [];
    const problems = problemIds.length ? app.db.all<ProblemRow>(`SELECT * FROM problems WHERE system_id IN (${inList(problemIds)}) ORDER BY state IN ('resolved', 'closed'), updated_at DESC LIMIT 300`, ...problemIds) : [];
    return {
      features: f,
      systems: list.map((x) => ({ id: x.s.id, name: x.s.name, canStatus: x.status, canProblems: x.problems })),
      services: services.map((s) => ({ ...servicePublic(s), ...states.get(s.id)! })),
      incidents: incidents.map((i) => ({ ...incidentPublic(app, i, n.get(i.system_id) ?? ''), problemId: i.problem_id, zammadTicket: i.zammad_ticket_number, tag: incidentTag(i.number) })),
      maintenances: maintenances.map((m) => maintenancePublic(app, m, n.get(m.system_id) ?? '')),
      problems: problems.map((p) => problemAdmin(p, n.get(p.system_id) ?? '')),
    };
  });

  const servicePublic = (s: ServiceRow) => ({ id: s.id, systemId: s.system_id, name: s.name, description: s.description, manualStatus: s.manual_status, manualNote: s.manual_note, sort: s.sort });
  const problemAdmin = (p: ProblemRow, sysName: string) => ({
    id: p.id, number: problemNumber(p.number), tag: problemTag(p.number), systemId: p.system_id, systemName: sysName, title: p.title, state: p.state,
    serviceId: p.service_id, description: p.description, rootCause: p.root_cause, workaround: p.workaround, public: p.public === 1, owner: p.owner,
    updatedAt: p.updated_at, createdAt: p.created_at,
    tickets: app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM problem_tickets WHERE problem_id = ?', p.id)!.n,
    incidents: app.db.all<{ id: string; number: number; title: string; state: string }>('SELECT id, number, title, state FROM incidents WHERE problem_id = ? ORDER BY started_at DESC', p.id)
      .map((i) => ({ id: i.id, number: incidentNumber(i.number), title: i.title, state: i.state })),
  });

  // ---------------------------------------------------------------- Services
  // Für den Formular-Editor („Betroffene Services“) – auch ohne Recht, Services zu pflegen
  router.get('/api/admin/systems/:systemId/services', admin(['form.edit', 'form.publish', 'form.approve', 'status.manage', 'problem.manage']), (ctx: AppCtx) => {
    const sys = sysOr404(ctx.params.systemId);
    return { services: servicesOf(app, [sys.id]).map(servicePublic) };
  });
  router.post('/api/admin/systems/:systemId/services', admin('status.manage'), (ctx: AppCtx) => {
    const sys = sysOr404(ctx.params.systemId);
    const s = saveService(app, sys.id, body(ctx));
    audit(app.db, actor(ctx), { action: 'service.created', targetType: 'service', targetId: s.id, systemId: sys.id, details: { name: s.name } });
    return { created: true, service: servicePublic(s) };
  });
  function serviceOr404(ctx: AppCtx): ServiceRow {
    const s = app.db.get<ServiceRow>('SELECT * FROM services WHERE id = ? AND system_id = ?', ctx.params.serviceId, ctx.params.systemId);
    if (!s) throw new HttpError(404, 'Service nicht gefunden', 'not_found');
    return s;
  }
  router.put('/api/admin/systems/:systemId/services/:serviceId', admin('status.manage'), (ctx: AppCtx) => {
    const before = serviceOr404(ctx);
    const s = saveService(app, before.system_id, body(ctx), before);
    audit(app.db, actor(ctx), { action: 'service.updated', targetType: 'service', targetId: s.id, systemId: s.system_id, details: diff(servicePublic(before) as any, servicePublic(s) as any) });
    return { service: servicePublic(s) };
  });
  router.delete('/api/admin/systems/:systemId/services/:serviceId', admin('status.manage'), (ctx: AppCtx) => {
    const s = serviceOr404(ctx);
    app.db.run('DELETE FROM services WHERE id = ?', s.id);
    audit(app.db, actor(ctx), { action: 'service.deleted', targetType: 'service', targetId: s.id, systemId: s.system_id, details: { name: s.name } });
    return { ok: true };
  });

  // ---------------------------------------------------------------- Störungen
  function incidentOr404(ctx: AppCtx): IncidentRow {
    const i = getIncident(app, ctx.params.incidentId);
    if (!i || i.system_id !== ctx.params.systemId) throw new HttpError(404, 'Störung nicht gefunden', 'not_found');
    return i;
  }
  router.post('/api/admin/systems/:systemId/incidents', admin('status.manage'), async (ctx: AppCtx) => {
    const sys = sysOr404(ctx.params.systemId);
    const i = await createIncident(app, sys, ctx.user!, body(ctx));
    audit(app.db, actor(ctx), { action: 'incident.created', targetType: 'incident', targetId: i.id, systemId: sys.id, details: { number: incidentNumber(i.number), title: i.title, impact: i.impact, major: i.major === 1 } });
    return { created: true, incident: incidentPublic(app, i, sys.name) };
  });
  router.get('/api/admin/systems/:systemId/incidents/:incidentId', admin('status.manage'), (ctx: AppCtx) => {
    const i = incidentOr404(ctx);
    const sys = sysOr404(i.system_id);
    return {
      incident: { ...incidentPublic(app, i, sys.name), problemId: i.problem_id, zammadTicket: i.zammad_ticket_number, tag: incidentTag(i.number), createdBy: userName(i.created_by) },
      updates: app.db.all<{ id: string; state: string; body: string; created_by: string | null; created_at: number }>('SELECT * FROM incident_updates WHERE incident_id = ? ORDER BY created_at DESC', i.id)
        .map((u) => ({ id: u.id, state: u.state, body: u.body, at: u.created_at, by: userName(u.created_by) })),
      affected: app.db.all<{ display_name: string; email: string | null; department: string | null; created_at: number }>(
        'SELECT u.display_name, u.email, u.department, a.created_at FROM incident_affected a JOIN users u ON u.id = a.user_id WHERE a.incident_id = ? ORDER BY a.created_at', i.id,
      ).map((a) => ({ name: a.display_name, email: a.email, department: a.department, at: a.created_at })),
    };
  });
  router.put('/api/admin/systems/:systemId/incidents/:incidentId', admin('status.manage'), async (ctx: AppCtx) => {
    const before = incidentOr404(ctx);
    const sys = sysOr404(before.system_id);
    const i = await updateIncident(app, sys, before, body(ctx));
    audit(app.db, actor(ctx), { action: 'incident.updated', targetType: 'incident', targetId: i.id, systemId: sys.id, details: diff(
      { title: before.title, impact: before.impact, major: before.major, started: before.started_at, ticket: before.zammad_ticket_number, problem: before.problem_id, locations: before.locations } as any,
      { title: i.title, impact: i.impact, major: i.major, started: i.started_at, ticket: i.zammad_ticket_number, problem: i.problem_id, locations: i.locations } as any) });
    return { incident: incidentPublic(app, i, sys.name) };
  });
  router.post('/api/admin/systems/:systemId/incidents/:incidentId/updates', admin('status.manage'), (ctx: AppCtx) => {
    const before = incidentOr404(ctx);
    const i = addIncidentUpdate(app, before, ctx.user!, body(ctx));
    audit(app.db, actor(ctx), { action: i.state === 'resolved' && before.state !== 'resolved' ? 'incident.resolved' : 'incident.update', targetType: 'incident', targetId: i.id, systemId: i.system_id, details: { state: i.state } });
    return { incident: incidentPublic(app, i, sysOr404(i.system_id).name) };
  });
  router.delete('/api/admin/systems/:systemId/incidents/:incidentId', admin('status.manage'), (ctx: AppCtx) => {
    const i = incidentOr404(ctx);
    app.db.run('DELETE FROM incidents WHERE id = ?', i.id);
    audit(app.db, actor(ctx), { action: 'incident.deleted', targetType: 'incident', targetId: i.id, systemId: i.system_id, details: { number: incidentNumber(i.number), title: i.title } });
    return { ok: true };
  });

  // ---------------------------------------------------------------- Wartungen
  function maintenanceOr404(ctx: AppCtx): MaintenanceRow {
    const m = getMaintenance(app, ctx.params.maintenanceId);
    if (!m || m.system_id !== ctx.params.systemId) throw new HttpError(404, 'Wartung nicht gefunden', 'not_found');
    return m;
  }
  router.post('/api/admin/systems/:systemId/maintenances', admin('status.manage'), (ctx: AppCtx) => {
    const sys = sysOr404(ctx.params.systemId);
    const m = saveMaintenance(app, sys, ctx.user!, body(ctx));
    audit(app.db, actor(ctx), { action: 'maintenance.created', targetType: 'maintenance', targetId: m.id, systemId: sys.id, details: { title: m.title, from: m.starts_at, to: m.ends_at } });
    return { created: true, maintenance: maintenancePublic(app, m, sys.name) };
  });
  router.put('/api/admin/systems/:systemId/maintenances/:maintenanceId', admin('status.manage'), (ctx: AppCtx) => {
    const before = maintenanceOr404(ctx);
    const sys = sysOr404(before.system_id);
    const m = saveMaintenance(app, sys, ctx.user!, body(ctx), before);
    audit(app.db, actor(ctx), { action: 'maintenance.updated', targetType: 'maintenance', targetId: m.id, systemId: sys.id, details: diff(
      { title: before.title, from: before.starts_at, to: before.ends_at } as any, { title: m.title, from: m.starts_at, to: m.ends_at } as any) });
    return { maintenance: maintenancePublic(app, m, sys.name) };
  });
  router.post('/api/admin/systems/:systemId/maintenances/:maintenanceId/cancel', admin('status.manage'), (ctx: AppCtx) => {
    const m = maintenanceOr404(ctx);
    app.db.run('UPDATE maintenances SET cancelled = 1, updated_at = ? WHERE id = ?', Date.now(), m.id);
    audit(app.db, actor(ctx), { action: 'maintenance.cancelled', targetType: 'maintenance', targetId: m.id, systemId: m.system_id, details: { title: m.title } });
    return { ok: true };
  });
  router.delete('/api/admin/systems/:systemId/maintenances/:maintenanceId', admin('status.manage'), (ctx: AppCtx) => {
    const m = maintenanceOr404(ctx);
    app.db.run('DELETE FROM maintenances WHERE id = ?', m.id);
    audit(app.db, actor(ctx), { action: 'maintenance.deleted', targetType: 'maintenance', targetId: m.id, systemId: m.system_id, details: { title: m.title } });
    return { ok: true };
  });

  // ---------------------------------------------------------------- Probleme
  function problemOr404(ctx: AppCtx): ProblemRow {
    const p = getProblem(app, ctx.params.problemId);
    if (!p || p.system_id !== ctx.params.systemId) throw new HttpError(404, 'Problem nicht gefunden', 'not_found');
    return p;
  }
  router.post('/api/admin/systems/:systemId/problems', admin('problem.manage'), (ctx: AppCtx) => {
    const sys = sysOr404(ctx.params.systemId);
    const p = saveProblem(app, sys, ctx.user!, body(ctx));
    audit(app.db, actor(ctx), { action: 'problem.created', targetType: 'problem', targetId: p.id, systemId: sys.id, details: { number: problemNumber(p.number), title: p.title } });
    return { created: true, problem: problemAdmin(p, sys.name) };
  });
  router.get('/api/admin/systems/:systemId/problems/:problemId', admin('problem.manage'), async (ctx: AppCtx) => {
    const p = problemOr404(ctx);
    const sys = sysOr404(p.system_id);
    return { problem: { ...problemAdmin(p, sys.name), createdBy: userName(p.created_by) }, tickets: await problemTickets(app, sys, p) };
  });
  router.put('/api/admin/systems/:systemId/problems/:problemId', admin('problem.manage'), (ctx: AppCtx) => {
    const before = problemOr404(ctx);
    const sys = sysOr404(before.system_id);
    const p = saveProblem(app, sys, ctx.user!, body(ctx), before);
    audit(app.db, actor(ctx), { action: 'problem.updated', targetType: 'problem', targetId: p.id, systemId: sys.id, details: diff(
      { title: before.title, state: before.state, public: before.public, owner: before.owner, service: before.service_id } as any,
      { title: p.title, state: p.state, public: p.public, owner: p.owner, service: p.service_id } as any) });
    return { problem: problemAdmin(p, sys.name) };
  });
  router.post('/api/admin/systems/:systemId/problems/:problemId/tickets', admin('problem.manage'), async (ctx: AppCtx) => {
    const p = problemOr404(ctx);
    const sys = sysOr404(p.system_id);
    const t = await linkProblemTicket(app, sys, p, ctx.user!, body(ctx).number);
    audit(app.db, actor(ctx), { action: 'problem.ticket_linked', targetType: 'problem', targetId: p.id, systemId: sys.id, details: { ticket: t.number, tag: problemTag(p.number) } });
    return { ticket: t };
  });
  router.delete('/api/admin/systems/:systemId/problems/:problemId/tickets/:ticketId', admin('problem.manage'), async (ctx: AppCtx) => {
    const p = problemOr404(ctx);
    const sys = sysOr404(p.system_id);
    const id = Number(ctx.params.ticketId);
    if (!Number.isSafeInteger(id)) throw new HttpError(404, 'Ticket ist nicht verknüpft', 'not_found');
    await unlinkProblemTicket(app, sys, p, id);
    audit(app.db, actor(ctx), { action: 'problem.ticket_unlinked', targetType: 'problem', targetId: p.id, systemId: sys.id, details: { ticketId: id } });
    return { ok: true };
  });
  router.delete('/api/admin/systems/:systemId/problems/:problemId', admin('problem.manage'), (ctx: AppCtx) => {
    const p = problemOr404(ctx);
    app.db.run('DELETE FROM problems WHERE id = ?', p.id);
    audit(app.db, actor(ctx), { action: 'problem.deleted', targetType: 'problem', targetId: p.id, systemId: p.system_id, details: { number: problemNumber(p.number), title: p.title } });
    return { ok: true };
  });

}
