// Status-Seite, Störungen, Wartungen, Probleme und Funktionsschalter.
// Portal: eine Seite für alle Ticketsysteme, die die Person sieht. Verwaltung: eine Seite für alle Ticketsysteme,
// in denen die Person „Services, Störungen und Wartungen verwalten“ bzw. „Probleme verwalten“ darf.
// Ab 2.0 sind Störungen, Wartungen und Probleme Tickets in Zammad; ihre Kennung im Portal ist <Ticketsystem>.<Ticket-ID>.
import type { App } from '../app.ts';
import { HttpError, type Router, type RouteOptions } from '../http/core.ts';
import type { AppCtx } from '../server.ts';
import { audit, diff } from '../services/audit.ts';
import { can } from '../services/rbac.ts';
import { getSystem, listSystems, systemVisibleTo, type SystemRow } from '../services/systems.ts';
import { getFeatures, saveFeatures } from '../services/features.ts';
import {
  addIncidentUpdate, affectedPeople, cancelMaintenance, createIncident, getIncident, getMaintenance, getProblem, incidentPublic,
  incidentUpdates, incidentsOf, incidentsOfProblem, linkProblemTicket, maintenancePublic, maintenancesOf, problemPublic, problemTickets,
  problemsOf, removeFromPortal, saveMaintenance, saveProblem, saveService, serviceStates, servicesOf, setAffected, statusBanner,
  statusOverview, unlinkProblemTicket, updateIncident, type Incident, type Maintenance, type Problem, type ServiceRow,
} from '../services/itsm.ts';
import { locationChoices, syncOptions } from '../services/zammad-setup.ts';
import { FEATURE_INFO, itsmEnabled, normalizeFeatures } from '../../shared/itsm.ts';

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

  // =========================================================================================== Portal

  router.get('/api/portal/status', user, async (ctx: AppCtx) => {
    if (!itsmEnabled(getFeatures(app))) throw new HttpError(404, 'Diese Funktion ist ausgeschaltet', 'feature_off');
    return statusOverview(app, ctx.user!);
  });

  router.get('/api/portal/status/banner', user, (ctx: AppCtx) => statusBanner(app, ctx.user!));

  async function visibleIncident(ctx: AppCtx): Promise<Incident> {
    needFeature('incidents');
    const inc = await getIncident(app, ctx.params.incidentId);
    if (!inc || !inc.public || inc.sys.status === 'inactive' || !systemVisibleTo(inc.sys, ctx.user!)) throw new HttpError(404, 'Störung nicht gefunden', 'not_found');
    return inc;
  }

  router.get('/api/portal/incidents/:incidentId', user, async (ctx: AppCtx) => {
    const inc = await visibleIncident(ctx);
    const services = servicesOf(app, [inc.sys.id]);
    const problem = inc.problemRef && getFeatures(app).problems ? await getProblem(app, `${inc.sys.id}.${inc.problemRef}`) : null;
    return {
      incident: await incidentPublic(app, inc, ctx.user!),
      // Updates ohne Namen der Bearbeiter – im Portal spricht „die IT“
      updates: await incidentUpdates(app, inc),
      serviceNames: Object.fromEntries(services.map((s) => [s.id, s.name])),
      problem: problem && problem.public ? { number: problem.t.number, title: problem.title, workaround: problem.workaround } : null,
    };
  });

  router.post('/api/portal/incidents/:incidentId/affected', user, async (ctx: AppCtx) => {
    const inc = await visibleIncident(ctx);
    const affected = body(ctx).affected !== false;
    const count = await setAffected(app, inc, ctx.user!, affected);
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
    if (JSON.stringify(before.locations) !== JSON.stringify(next.locations)) void syncOptions(app, null, 'locations');
    return { features: next };
  });

  /** Ticketsysteme, in denen die Person etwas pflegen darf */
  function manageable(ctx: AppCtx) {
    return listSystems(app).filter((s) => s.status !== 'inactive')
      .map((s) => ({ s, status: can(ctx.user, 'status.manage', s.id), problems: can(ctx.user, 'problem.manage', s.id) }))
      .filter((x) => x.status || x.problems);
  }

  const servicePublic = (s: ServiceRow) => ({ id: s.id, systemId: s.system_id, name: s.name, description: s.description, key: s.zkey, sort: s.sort });
  const incidentAdmin = async (i: Incident) => ({ ...(await incidentPublic(app, i)), problemId: i.problemRef ? `${i.sys.id}.${i.problemRef}` : null, public: i.public, ticketId: i.t.id });
  const problemAdmin = async (p: Problem) => ({
    ...(await problemPublic(app, p)), rootCause: p.rootCause, public: p.public, createdAt: p.createdAt, ticketId: p.t.id,
    incidents: await incidentsOfProblem(app, p),
  });

  /** Alles auf einer Seite: Services, Störungen, Wartungen und Probleme aller Ticketsysteme, die man pflegen darf */
  router.get('/api/admin/itsm', admin(), async (ctx: AppCtx) => {
    const list = manageable(ctx);
    if (!list.length) throw new HttpError(403, 'Keine Berechtigung', 'forbidden');
    const f = getFeatures(app);
    const now = Date.now();
    const services = servicesOf(app, list.map((x) => x.s.id));
    const incidents: Incident[] = [], maintenances: Maintenance[] = [], problems: Problem[] = [];
    for (const x of list) {
      if (x.status) {
        incidents.push(...(await incidentsOf(app, x.s)).filter((i) => i.state !== 'resolved' || (i.resolvedAt ?? 0) > now - 30 * 86400_000));
        maintenances.push(...(await maintenancesOf(app, x.s)).filter((m) => m.endsAt > now - 30 * 86400_000));
      }
      if (x.problems && f.problems) problems.push(...await problemsOf(app, x.s));
    }
    const states = serviceStates(services, incidents, maintenances, now);
    incidents.sort((a, b) => Number(a.state === 'resolved') - Number(b.state === 'resolved') || b.startedAt - a.startedAt);
    maintenances.sort((a, b) => b.startsAt - a.startsAt);
    problems.sort((a, b) => Number(['resolved', 'closed'].includes(a.state)) - Number(['resolved', 'closed'].includes(b.state)) || b.updatedAt - a.updatedAt);
    return {
      features: f,
      systems: list.map((x) => ({ id: x.s.id, name: x.s.name, canStatus: x.status, canProblems: x.problems, locations: locationChoices(app, x.s) })),
      services: services.map((s) => ({ ...servicePublic(s), ...states.get(s.id)! })),
      incidents: await Promise.all(incidents.slice(0, 200).map(incidentAdmin)),
      maintenances: await Promise.all(maintenances.slice(0, 200).map((m) => maintenancePublic(app, m))),
      problems: await Promise.all(problems.slice(0, 300).map(problemAdmin)),
    };
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
    // Der Auswahlwert in Zammad bleibt – Tickets verweisen vielleicht noch darauf
    app.db.run('DELETE FROM services WHERE id = ?', s.id);
    audit(app.db, actor(ctx), { action: 'service.deleted', targetType: 'service', targetId: s.id, systemId: s.system_id, details: { name: s.name } });
    return { ok: true };
  });

  // ---------------------------------------------------------------- Störungen
  async function incidentOr404(ctx: AppCtx): Promise<Incident> {
    const i = await getIncident(app, ctx.params.incidentId);
    if (!i || i.sys.id !== ctx.params.systemId) throw new HttpError(404, 'Störung nicht gefunden', 'not_found');
    return i;
  }
  const incidentAudit = (i: Incident) => ({ title: i.title, impact: i.impact, major: i.major, started: i.startedAt, problem: i.problemRef, locations: i.locations.join(', '), public: i.public });

  router.post('/api/admin/systems/:systemId/incidents', admin('status.manage'), async (ctx: AppCtx) => {
    const sys = sysOr404(ctx.params.systemId);
    const i = await createIncident(app, sys, ctx.user!, body(ctx));
    audit(app.db, actor(ctx), { action: 'incident.created', targetType: 'ticket', targetId: i.ref, systemId: sys.id, details: { ticket: i.t.number, title: i.title, impact: i.impact, major: i.major } });
    return { created: true, incident: await incidentAdmin(i) };
  });
  router.get('/api/admin/systems/:systemId/incidents/:incidentId', admin('status.manage'), async (ctx: AppCtx) => {
    const i = await incidentOr404(ctx);
    return {
      incident: await incidentAdmin(i),
      updates: (await incidentUpdates(app, i)).map((u) => ({ ...u, id: String(u.at), by: '' })),
      affected: await affectedPeople(app, i),
    };
  });
  router.put('/api/admin/systems/:systemId/incidents/:incidentId', admin('status.manage'), async (ctx: AppCtx) => {
    const before = await incidentOr404(ctx);
    const i = await updateIncident(app, before, body(ctx));
    audit(app.db, actor(ctx), { action: 'incident.updated', targetType: 'ticket', targetId: i.ref, systemId: i.sys.id, details: diff(incidentAudit(before) as any, incidentAudit(i) as any) });
    return { incident: await incidentAdmin(i) };
  });
  router.post('/api/admin/systems/:systemId/incidents/:incidentId/updates', admin('status.manage'), async (ctx: AppCtx) => {
    const before = await incidentOr404(ctx);
    const i = await addIncidentUpdate(app, before, ctx.user!, body(ctx));
    audit(app.db, actor(ctx), { action: i.state === 'resolved' && before.state !== 'resolved' ? 'incident.resolved' : 'incident.update', targetType: 'ticket', targetId: i.ref, systemId: i.sys.id, details: { state: i.state, ticket: i.t.number } });
    return { incident: await incidentAdmin(i) };
  });
  router.delete('/api/admin/systems/:systemId/incidents/:incidentId', admin('status.manage'), async (ctx: AppCtx) => {
    const i = await incidentOr404(ctx);
    await removeFromPortal(app, i.sys, i.t);
    audit(app.db, actor(ctx), { action: 'incident.deleted', targetType: 'ticket', targetId: i.ref, systemId: i.sys.id, details: { ticket: i.t.number, title: i.title } });
    return { ok: true };
  });

  // ---------------------------------------------------------------- Wartungen
  async function maintenanceOr404(ctx: AppCtx): Promise<Maintenance> {
    const m = await getMaintenance(app, ctx.params.maintenanceId);
    if (!m || m.sys.id !== ctx.params.systemId) throw new HttpError(404, 'Wartung nicht gefunden', 'not_found');
    return m;
  }
  router.post('/api/admin/systems/:systemId/maintenances', admin('status.manage'), async (ctx: AppCtx) => {
    const sys = sysOr404(ctx.params.systemId);
    const m = await saveMaintenance(app, sys, ctx.user!, body(ctx));
    audit(app.db, actor(ctx), { action: 'maintenance.created', targetType: 'ticket', targetId: m.ref, systemId: sys.id, details: { ticket: m.t.number, title: m.title, from: m.startsAt, to: m.endsAt } });
    return { created: true, maintenance: await maintenancePublic(app, m) };
  });
  router.put('/api/admin/systems/:systemId/maintenances/:maintenanceId', admin('status.manage'), async (ctx: AppCtx) => {
    const before = await maintenanceOr404(ctx);
    const m = await saveMaintenance(app, before.sys, ctx.user!, body(ctx), before);
    audit(app.db, actor(ctx), { action: 'maintenance.updated', targetType: 'ticket', targetId: m.ref, systemId: m.sys.id, details: diff(
      { title: before.title, from: before.startsAt, to: before.endsAt } as any, { title: m.title, from: m.startsAt, to: m.endsAt } as any) });
    return { maintenance: await maintenancePublic(app, m) };
  });
  router.post('/api/admin/systems/:systemId/maintenances/:maintenanceId/cancel', admin('status.manage'), async (ctx: AppCtx) => {
    const m = await maintenanceOr404(ctx);
    await cancelMaintenance(app, m);
    audit(app.db, actor(ctx), { action: 'maintenance.cancelled', targetType: 'ticket', targetId: m.ref, systemId: m.sys.id, details: { ticket: m.t.number, title: m.title } });
    return { ok: true };
  });
  router.delete('/api/admin/systems/:systemId/maintenances/:maintenanceId', admin('status.manage'), async (ctx: AppCtx) => {
    const m = await maintenanceOr404(ctx);
    await removeFromPortal(app, m.sys, m.t);
    audit(app.db, actor(ctx), { action: 'maintenance.deleted', targetType: 'ticket', targetId: m.ref, systemId: m.sys.id, details: { ticket: m.t.number, title: m.title } });
    return { ok: true };
  });

  // ---------------------------------------------------------------- Probleme
  async function problemOr404(ctx: AppCtx): Promise<Problem> {
    const p = await getProblem(app, ctx.params.problemId);
    if (!p || p.sys.id !== ctx.params.systemId) throw new HttpError(404, 'Problem nicht gefunden', 'not_found');
    return p;
  }
  router.post('/api/admin/systems/:systemId/problems', admin('problem.manage'), async (ctx: AppCtx) => {
    const sys = sysOr404(ctx.params.systemId);
    const p = await saveProblem(app, sys, ctx.user!, body(ctx));
    audit(app.db, actor(ctx), { action: 'problem.created', targetType: 'ticket', targetId: p.ref, systemId: sys.id, details: { ticket: p.t.number, title: p.title } });
    return { created: true, problem: await problemAdmin(p) };
  });
  router.get('/api/admin/systems/:systemId/problems/:problemId', admin('problem.manage'), async (ctx: AppCtx) => {
    const p = await problemOr404(ctx);
    return { problem: await problemAdmin(p), tickets: await problemTickets(app, p) };
  });
  router.put('/api/admin/systems/:systemId/problems/:problemId', admin('problem.manage'), async (ctx: AppCtx) => {
    const before = await problemOr404(ctx);
    const p = await saveProblem(app, before.sys, ctx.user!, body(ctx), before);
    audit(app.db, actor(ctx), { action: 'problem.updated', targetType: 'ticket', targetId: p.ref, systemId: p.sys.id, details: diff(
      { title: before.title, state: before.state, public: before.public, service: before.services[0] ?? null } as any,
      { title: p.title, state: p.state, public: p.public, service: p.services[0] ?? null } as any) });
    return { problem: await problemAdmin(p) };
  });
  router.post('/api/admin/systems/:systemId/problems/:problemId/tickets', admin('problem.manage'), async (ctx: AppCtx) => {
    const p = await problemOr404(ctx);
    const t = await linkProblemTicket(app, p, body(ctx).number);
    audit(app.db, actor(ctx), { action: 'problem.ticket_linked', targetType: 'ticket', targetId: p.ref, systemId: p.sys.id, details: { ticket: t.number } });
    return { ticket: t };
  });
  router.delete('/api/admin/systems/:systemId/problems/:problemId/tickets/:ticketId', admin('problem.manage'), async (ctx: AppCtx) => {
    const p = await problemOr404(ctx);
    const id = Number(ctx.params.ticketId);
    if (!Number.isSafeInteger(id)) throw new HttpError(404, 'Ticket ist nicht verknüpft', 'not_found');
    await unlinkProblemTicket(app, p, id);
    audit(app.db, actor(ctx), { action: 'problem.ticket_unlinked', targetType: 'ticket', targetId: p.ref, systemId: p.sys.id, details: { ticketId: id } });
    return { ok: true };
  });
  router.delete('/api/admin/systems/:systemId/problems/:problemId', admin('problem.manage'), async (ctx: AppCtx) => {
    const p = await problemOr404(ctx);
    await removeFromPortal(app, p.sys, p.t);
    audit(app.db, actor(ctx), { action: 'problem.deleted', targetType: 'ticket', targetId: p.ref, systemId: p.sys.id, details: { ticket: p.t.number, title: p.title } });
    return { ok: true };
  });
}
