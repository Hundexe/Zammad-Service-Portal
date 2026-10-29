// Freigabe durch Vorgesetzte.
//
// Enthält ein Formular das Feld "Freigabe durch Vorgesetzte(n)", gibt die anfragende Person die
// E-Mail-Adresse der freigebenden Person selbst ein. Die Anfrage wird wie jede andere geprüft und
// verschlüsselt gespeichert, bleibt aber im Status "awaiting_approval" – der Worker fasst sie nicht an.
// Erst nach der Freigabe geht sie in die Warteschlange und damit ins Ticketsystem. Bei Ablehnung,
// Zurückziehen oder Ablauf der Frist werden Inhalt und Anhänge gelöscht; nichts erreicht Zammad.
//
// Wer freigeben darf: genau das Microsoft-Konto, dem die eingetragene E-Mail-Adresse gehört – nie die
// anfragende Person selbst und nie ein lokales Konto (lokale Konten legen Admins an, die Adresse ist dort
// nicht von Microsoft bestätigt). Optional muss die Person Mitglied bestimmter Entra-Gruppen sein
// (Feld-Einstellung approverGroups) – das verhindert Freigaben über ein beliebiges Zweitkonto.
// Für alle anderen gibt es die Freigabe nicht (404).
import type { App } from '../app.ts';
import { uuid } from '../db/db.ts';
import { HttpError } from '../http/core.ts';
import { log } from '../log.ts';
import { activeApproverField, displayValue, isVisible, type FormDefinition, type FormValues } from '../../shared/form.ts';
import { escapeHtml, textToHtml } from '../../shared/template.ts';
import type { AuthUser } from './rbac.ts';
import { audit, type Actor } from './audit.ts';
import { loadFile, removeRequestFiles } from './files.ts';
import { markReadByLink, notify } from './notifications.ts';
import { localEmailTaken, type TicketPayload } from './requests.ts';

export const APPROVED_TAG = 'freigegeben';
const COMMENT_MAX = 2000;

export interface ApproverChoice { email: string; name: string | null; known: boolean; knownOnly: boolean; groups: string[] | null }

const MAX_REASSIGN = 3;

interface Summary {
  form: string;
  system: string;
  requester: { name: string; email: string; department: string };
  fields: { label: string; value: string; multiline: boolean }[];
}

interface ApprovalRow {
  id: string; request_id: string; approver_email: string; approver_name: string | null; known_only: number;
  status: string; summary: string | null; comment: string | null; decided_by: string | null; decided_by_name: string | null;
  decided_at: number | null; created_at: number; expires_at: number; reminded_at: number | null;
  approver_groups: string | null; reassign_count: number;
}

interface JoinedRow extends ApprovalRow {
  r_user_id: string; r_system_id: string; r_title: string; r_status: string; r_created_at: number;
  requester_name: string; system_name: string;
}

const JOIN = `SELECT a.*, r.user_id AS r_user_id, r.system_id AS r_system_id, r.title AS r_title, r.status AS r_status, r.created_at AS r_created_at,
                     u.display_name AS requester_name, s.name AS system_name
                FROM approvals a JOIN requests r ON r.id = a.request_id JOIN users u ON u.id = r.user_id JOIN ticket_systems s ON s.id = r.system_id`;

const fmt = (t: number) => new Date(t).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const fmtDay = (t: number) => new Date(t).toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' });

/** Microsoft-Konto, dem eine E-Mail-Adresse gehört (gesperrte und lokale Konten zählen nicht). */
export function accountForEmail(app: App, email: string): { id: string; name: string; kind: string; groups: string[] } | null {
  const row = app.db.get<{ id: string; display_name: string; kind: string; groups_json: string | null }>(
    "SELECT id, display_name, kind, groups_json FROM users WHERE lower(email) = lower(?) AND disabled = 0 AND kind = 'entra' ORDER BY last_login_at DESC LIMIT 1",
    email,
  );
  return row ? { id: row.id, name: row.display_name, kind: row.kind, groups: parseGroups(row.groups_json) } : null;
}

function parseGroups(json: string | null): string[] {
  try { const v = JSON.parse(json ?? '[]'); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
}

function inGroups(memberOf: string[], allowed: string[] | null): boolean {
  if (!allowed || !allowed.length) return true;
  const set = new Set(memberOf.map((g) => g.toLowerCase()));
  return allowed.some((g) => set.has(g.toLowerCase()));
}

/** Darf dieses Konto Freigaben über seine E-Mail-Adresse sehen und entscheiden? Nur Microsoft-Konten. */
function approverEmailOf(app: App, user: AuthUser): string | null {
  if (!user.email || user.kind !== 'entra') return null;
  if (localEmailTaken(app, user.id, user.email)) return null;
  return user.email.toLowerCase();
}

/** Prüft die eingetragene freigebende Person. Wirft 422 mit Feldfehler, wenn sie nicht in Frage kommt. */
export function checkApprover(app: App, user: AuthUser, fieldId: string, email: string, knownOnly: boolean, groups: string[] | null = null): ApproverChoice {
  const fail = (msg: string): never => { throw new HttpError(422, msg, 'validation', { [fieldId]: msg }); };
  const e = email.toLowerCase();
  if (user.email && e === user.email.toLowerCase()) fail('Sie können Ihre eigene Anfrage nicht selbst freigeben');
  const acc = accountForEmail(app, e);
  if (acc?.id === user.id) fail('Sie können Ihre eigene Anfrage nicht selbst freigeben');
  const restricted = Boolean(groups && groups.length);
  if ((knownOnly || restricted) && !acc) fail('Diese Person hat sich noch nie im Portal angemeldet. Bitte eine andere Person wählen oder sie bitten, sich einmal anzumelden.');
  if (restricted && !inGroups(acc!.groups, groups)) fail('Diese Person darf Anfragen dieses Formulars nicht freigeben. Bitte die zuständige Führungskraft eintragen.');
  return { email: e, name: acc?.name ?? null, known: Boolean(acc), knownOnly: knownOnly || restricted, groups: restricted ? groups : null };
}

/** Freigabe-Angaben einer Einsendung, falls das Formular für diese Eingaben eine Freigabe verlangt. */
export function approverFor(app: App, user: AuthUser, def: FormDefinition, values: FormValues): ApproverChoice | null {
  const f = activeApproverField(def, values);
  if (!f) return null;
  const v = values[f.id];
  if (typeof v !== 'string' || !v) throw new HttpError(422, 'Bitte die freigebende Person angeben', 'validation', { [f.id]: 'Bitte die freigebende Person angeben' });
  return checkApprover(app, user, f.id, v, f.knownOnly === true, f.approverGroups?.length ? f.approverGroups : null);
}

/** Inhalt, den die freigebende Person sieht: dieselben Felder, die auch ins Ticket gehen. */
export function buildSummary(def: FormDefinition, values: FormValues, user: AuthUser, formName: string, systemName: string): Summary {
  const fields: Summary['fields'] = [];
  for (const f of def.fields) {
    if (f.type === 'info' || f.type === 'approver' || f.type === 'file' || f.mapping?.target === 'none' || !isVisible(f, values, def.fields)) continue;
    const v = values[f.id];
    if (v === undefined) continue;
    fields.push({ label: f.label, value: displayValue(f, v), multiline: f.type === 'textarea' });
  }
  return { form: formName, system: systemName, requester: { name: user.displayName, email: user.email ?? '', department: user.department ?? '' }, fields };
}

/** Legt die Freigabe an (innerhalb der Transaktion von submitRequest). */
export function insertApproval(app: App, requestId: string, choice: ApproverChoice, summary: Summary): string {
  const id = uuid();
  const t = Date.now();
  app.db.run(
    `INSERT INTO approvals (id, request_id, approver_email, approver_name, known_only, approver_groups, status, summary, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    id, requestId, choice.email, choice.name, choice.knownOnly ? 1 : 0, choice.groups ? JSON.stringify(choice.groups) : null,
    app.box.encrypt('approval', JSON.stringify(summary)), t, t + app.cfg.approval.expireDays * 86400_000,
  );
  return id;
}

export function notifyRequested(app: App, approvalId: string, reminder = false): void {
  const a = app.db.get<JoinedRow>(`${JOIN} WHERE a.id = ?`, approvalId);
  if (!a) return;
  notify(app, {
    to: { email: a.approver_email },
    kind: reminder ? 'approval.reminder' : 'approval.requested',
    title: `${reminder ? 'Erinnerung: ' : ''}Freigabe erbeten: ${a.r_title}`,
    body: reminder
      ? `${a.requester_name} wartet auf Ihre Entscheidung. Ohne Entscheidung verfällt die Anfrage am ${fmtDay(a.expires_at)}.`
      : `${a.requester_name} bittet um Ihre Freigabe (${a.system_name}).`,
    link: `/freigaben/${a.id}`,
  });
}

// ---------------------------------------------------------------- Ansicht der freigebenden Person

function forApprover(app: App, user: AuthUser, id: string): JoinedRow {
  const email = approverEmailOf(app, user);
  const a = email && /^[0-9a-f-]{36}$/.test(id) ? app.db.get<JoinedRow>(`${JOIN} WHERE a.id = ? AND a.approver_email = ? AND r.user_id <> ?`, id, email, user.id) : undefined;
  // Gruppenbindung gilt auch beim Entscheiden (Mitgliedschaft frisch aus der letzten Anmeldung)
  if (!a || !inGroups(user.groups, a.approver_groups ? parseGroups(a.approver_groups) : null)) throw new HttpError(404, 'Freigabe nicht gefunden', 'not_found');
  return a;
}

function publicApproval(app: App, a: JoinedRow) {
  return {
    id: a.id,
    status: a.status,
    title: a.r_title,
    systemName: a.system_name,
    requesterName: a.requester_name,
    createdAt: a.created_at,
    expiresAt: a.expires_at,
    decidedAt: a.decided_at,
    decidedByName: a.decided_by_name,
    comment: a.comment ? app.box.decrypt('approval', a.comment) : null,
  };
}

export function listForApprover(app: App, user: AuthUser, which: 'open' | 'done') {
  const email = approverEmailOf(app, user);
  if (!email) return [];
  const rows = app.db.all<JoinedRow>(
    `${JOIN} WHERE a.approver_email = ? AND r.user_id <> ? AND ${which === 'open' ? "a.status = 'pending'" : "a.status <> 'pending'"}
      ORDER BY ${which === 'open' ? 'a.created_at ASC' : 'COALESCE(a.decided_at, a.created_at) DESC'} LIMIT 200`,
    email, user.id,
  );
  return rows.map((a) => publicApproval(app, a));
}

export function openCountForApprover(app: App, user: AuthUser): number {
  const email = approverEmailOf(app, user);
  if (!email) return 0;
  return app.db.get<{ n: number }>("SELECT COUNT(*) n FROM approvals a JOIN requests r ON r.id = a.request_id WHERE a.approver_email = ? AND a.status = 'pending' AND r.user_id <> ?", email, user.id)!.n;
}

export function approvalDetail(app: App, user: AuthUser, id: string) {
  const a = forApprover(app, user, id);
  const summary = a.status === 'pending' && a.summary ? JSON.parse(app.box.decrypt('approval', a.summary)) as Summary : null;
  const files = a.status === 'pending'
    ? app.db.all<{ id: string; filename: string; size: number }>('SELECT id, filename, size FROM request_files WHERE request_id = ? AND stored = 1', a.request_id)
    : [];
  return { approval: publicApproval(app, a), summary, files };
}

export function approvalFile(app: App, user: AuthUser, id: string, fileId: string): { filename: string; data: Buffer } {
  const a = forApprover(app, user, id);
  const f = a.status === 'pending' && /^[0-9a-f-]{36}$/.test(fileId)
    ? app.db.get<{ id: string; filename: string }>('SELECT id, filename FROM request_files WHERE id = ? AND request_id = ? AND stored = 1', fileId, a.request_id)
    : undefined;
  if (!f) throw new HttpError(404, 'Datei nicht gefunden', 'not_found');
  return { filename: f.filename, data: loadFile(app, a.request_id, f.id) };
}

/** Inhalt und Anhänge einer nicht zugestellten Anfrage löschen (Ablehnung, Rückzug, Ablauf). */
function discardRequest(app: App, requestId: string, status: 'rejected' | 'withdrawn' | 'expired'): void {
  app.db.run(
    "UPDATE requests SET status = ?, payload = NULL, purge_after = ? WHERE id = ? AND status = 'awaiting_approval'",
    status, Date.now() + app.cfg.retentionDays * 86400_000, requestId,
  );
  app.db.run('UPDATE request_files SET stored = 0 WHERE request_id = ?', requestId);
}

export function decide(app: App, user: AuthUser, actor: Actor, id: string, decision: 'approve' | 'reject', rawComment: unknown) {
  const a = forApprover(app, user, id);
  const comment = typeof rawComment === 'string' ? rawComment.replace(/\r\n/g, '\n').trim() : '';
  if (comment.length > COMMENT_MAX) throw new HttpError(422, `Höchstens ${COMMENT_MAX} Zeichen`, 'validation', { comment: `Höchstens ${COMMENT_MAX} Zeichen` });
  if (decision === 'reject' && !comment) throw new HttpError(422, 'Bitte kurz begründen, warum Sie ablehnen', 'validation', { comment: 'Bitte kurz begründen, warum Sie ablehnen' });
  const t = Date.now();
  app.db.tx(() => {
    const upd = app.db.run(
      `UPDATE approvals SET status = ?, comment = ?, decided_by = ?, decided_by_name = ?, decided_at = ?, summary = NULL
        WHERE id = ? AND status = 'pending' AND expires_at > ?`,
      decision === 'approve' ? 'approved' : 'rejected', comment ? app.box.encrypt('approval', comment) : null, user.id, user.displayName, t, a.id, t,
    );
    if (!upd.changes) throw new HttpError(409, 'Über diese Anfrage wurde bereits entschieden', 'conflict');
    if (decision === 'approve') {
      const r = app.db.get<{ payload: string | null }>("SELECT payload FROM requests WHERE id = ? AND status = 'awaiting_approval'", a.request_id);
      if (!r?.payload) throw new HttpError(409, 'Die Anfrage ist nicht mehr vorhanden', 'conflict');
      const payload = JSON.parse(app.box.decrypt('request', r.payload)) as TicketPayload;
      const note = `<p><strong>Freigegeben</strong> von ${escapeHtml(user.displayName)} (${escapeHtml(user.email ?? '')}) am ${escapeHtml(fmt(t))}</p>`
        + (comment ? `<blockquote>${textToHtml(comment)}</blockquote>` : '');
      const footer = payload.bodyHtml.lastIndexOf('<p><small>Erstellt über das Service-Portal');
      payload.bodyHtml = footer >= 0 ? payload.bodyHtml.slice(0, footer) + note + payload.bodyHtml.slice(footer) : payload.bodyHtml + note;
      if (!payload.tags.includes(APPROVED_TAG)) payload.tags.push(APPROVED_TAG);
      app.db.run(
        "UPDATE requests SET status = 'queued', payload = ?, next_attempt_at = ?, queued_at = ? WHERE id = ? AND status = 'awaiting_approval'",
        app.box.encrypt('request', JSON.stringify(payload)), t, t, a.request_id,
      );
    } else {
      discardRequest(app, a.request_id, 'rejected');
    }
    audit(app.db, actor, { action: decision === 'approve' ? 'approval.approved' : 'approval.rejected', targetType: 'request', targetId: a.request_id, systemId: a.r_system_id });
  });
  if (decision === 'reject') removeRequestFiles(app, a.request_id);
  // Erledigt: Hinweise "Freigabe erbeten" dieser Person gelten als gelesen
  markReadByLink(app, user, `/freigaben/${a.id}`);
  notify(app, {
    to: { userId: a.r_user_id },
    kind: decision === 'approve' ? 'approval.approved' : 'approval.rejected',
    title: `${decision === 'approve' ? 'Freigegeben' : 'Abgelehnt'}: ${a.r_title}`,
    body: decision === 'approve'
      ? `${user.displayName} hat Ihre Anfrage freigegeben. Sie wird jetzt an ${a.system_name} übermittelt.`
      : `${user.displayName} hat Ihre Anfrage abgelehnt: „${comment.slice(0, 300)}${comment.length > 300 ? ' …' : ''}“`,
    link: '/anfragen',
  });
  log.info(decision === 'approve' ? 'Anfrage freigegeben' : 'Anfrage abgelehnt', { request: a.request_id });
  return { status: decision === 'approve' ? 'approved' : 'rejected' };
}

// ---------------------------------------------------------------- Aktionen der anfragenden Person

function forRequester(app: App, user: AuthUser, requestId: string): JoinedRow {
  const a = /^[0-9a-f-]{36}$/.test(requestId) ? app.db.get<JoinedRow>(`${JOIN} WHERE a.request_id = ? AND r.user_id = ?`, requestId, user.id) : undefined;
  if (!a) throw new HttpError(404, 'Anfrage nicht gefunden', 'not_found');
  if (a.status !== 'pending' || a.r_status !== 'awaiting_approval') throw new HttpError(409, 'Die Anfrage wartet nicht mehr auf eine Freigabe', 'conflict');
  return a;
}

export function withdraw(app: App, user: AuthUser, actor: Actor, requestId: string): void {
  const a = forRequester(app, user, requestId);
  app.db.tx(() => {
    const upd = app.db.run("UPDATE approvals SET status = 'withdrawn', summary = NULL, decided_at = ? WHERE id = ? AND status = 'pending'", Date.now(), a.id);
    if (!upd.changes) throw new HttpError(409, 'Die Anfrage wartet nicht mehr auf eine Freigabe', 'conflict');
    discardRequest(app, a.request_id, 'withdrawn');
    audit(app.db, actor, { action: 'approval.withdrawn', targetType: 'request', targetId: a.request_id, systemId: a.r_system_id });
  });
  removeRequestFiles(app, a.request_id);
  notify(app, { to: { email: a.approver_email }, kind: 'approval.withdrawn', title: `Zurückgezogen: ${a.r_title}`, body: `${a.requester_name} hat die Anfrage zurückgezogen. Sie müssen nichts mehr tun.`, link: `/freigaben/${a.id}` });
}

export function reassign(app: App, user: AuthUser, actor: Actor, requestId: string, rawEmail: unknown): ApproverChoice {
  const a = forRequester(app, user, requestId);
  const email = typeof rawEmail === 'string' ? rawEmail.replace(/\s+/g, '').toLowerCase() : '';
  if (!/^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$/.test(email)) throw new HttpError(422, 'Bitte eine gültige E-Mail-Adresse angeben', 'validation', { email: 'Bitte eine gültige E-Mail-Adresse angeben' });
  if (email === a.approver_email.toLowerCase()) throw new HttpError(422, 'Diese Person ist bereits eingetragen', 'validation', { email: 'Diese Person ist bereits eingetragen' });
  if (a.reassign_count >= MAX_REASSIGN) throw new HttpError(409, `Die freigebende Person wurde schon ${MAX_REASSIGN}-mal geändert. Bitte die Anfrage zurückziehen und neu stellen.`, 'conflict');
  const choice = checkApprover(app, user, 'email', email, a.known_only === 1, a.approver_groups ? parseGroups(a.approver_groups) : null);
  app.db.tx(() => {
    // Die Frist läuft ab Erstellung weiter – ein Wechsel verlängert sie nicht
    const upd = app.db.run(
      "UPDATE approvals SET approver_email = ?, approver_name = ?, reminded_at = NULL, reassign_count = reassign_count + 1 WHERE id = ? AND status = 'pending' AND reassign_count < ?",
      choice.email, choice.name, a.id, MAX_REASSIGN,
    );
    if (!upd.changes) throw new HttpError(409, 'Die Anfrage wartet nicht mehr auf eine Freigabe', 'conflict');
    audit(app.db, actor, { action: 'approval.reassigned', targetType: 'request', targetId: a.request_id, systemId: a.r_system_id });
  });
  notify(app, { to: { email: a.approver_email }, kind: 'approval.reassigned', title: `Nicht mehr nötig: ${a.r_title}`, body: `${a.requester_name} hat eine andere Person um Freigabe gebeten. Sie müssen nichts mehr tun.`, link: `/freigaben/${a.id}` });
  notifyRequested(app, a.id);
  return choice;
}

/** Freigabe-Angaben zu den eigenen Anfragen (für "Meine Anfragen"). */
export function approvalsOfRequests(app: App, requestIds: string[]): Map<string, { approverEmail: string; approverName: string | null; status: string; decidedAt: number | null; decidedByName: string | null; expiresAt: number; comment: string | null; known: boolean }> {
  const out = new Map();
  for (let i = 0; i < requestIds.length; i += 100) {
    const ids = requestIds.slice(i, i + 100);
    const rows = app.db.all<ApprovalRow>(`SELECT * FROM approvals WHERE request_id IN (${ids.map(() => '?').join(',')})`, ...ids);
    for (const a of rows) {
      out.set(a.request_id, {
        approverEmail: a.approver_email, approverName: a.approver_name, status: a.status, decidedAt: a.decided_at, decidedByName: a.decided_by_name,
        expiresAt: a.expires_at, comment: a.comment ? app.box.decrypt('approval', a.comment) : null, known: a.approver_name !== null || Boolean(accountForEmail(app, a.approver_email)),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- Abbrechen (Verwaltung)

/** Status, aus denen die Verwaltung eine Anfrage abbrechen kann. "sending" nicht: die Zustellung läuft gerade. */
export const CANCELLABLE = ['failed', 'queued', 'awaiting_approval'] as const;

/**
 * Bricht eine noch nicht zugestellte Anfrage ab: Inhalt und Anhänge werden gelöscht, nichts geht an Zammad.
 * Wartet sie auf eine Freigabe, wird auch diese beendet. Anfragende und ggf. freigebende Person werden benachrichtigt.
 */
export function cancelRequest(app: App, admin: AuthUser, actor: Actor, requestId: string, rawReason: unknown): { previous: string } {
  const reason = typeof rawReason === 'string' ? rawReason.replace(/\r\n/g, '\n').trim() : '';
  if (reason.length > COMMENT_MAX) throw new HttpError(422, `Höchstens ${COMMENT_MAX} Zeichen`, 'validation', { reason: `Höchstens ${COMMENT_MAX} Zeichen` });
  const r = app.db.get<{ id: string; user_id: string; system_id: string; title: string; status: string }>('SELECT id, user_id, system_id, title, status FROM requests WHERE id = ?', requestId)!;
  const ap = app.db.get<ApprovalRow>("SELECT * FROM approvals WHERE request_id = ? AND status = 'pending'", requestId);
  const t = Date.now();
  app.db.tx(() => {
    const upd = app.db.run(
      `UPDATE requests SET status = 'cancelled', payload = NULL, purge_after = ?, last_error = ?
        WHERE id = ? AND status IN ('failed', 'queued', 'awaiting_approval')`,
      t + app.cfg.retentionDays * 86400_000, `Abgebrochen von ${admin.displayName}${reason ? `: ${reason.slice(0, 300)}` : ''}`, requestId,
    );
    if (!upd.changes) {
      throw new HttpError(409, r.status === 'sending' ? 'Die Anfrage wird gerade zugestellt – bitte gleich noch einmal versuchen' : 'Nur wartende oder fehlgeschlagene Anfragen lassen sich abbrechen', 'conflict');
    }
    app.db.run('UPDATE request_files SET stored = 0 WHERE request_id = ?', requestId);
    if (ap) app.db.run("UPDATE approvals SET status = 'cancelled', summary = NULL, decided_by = ?, decided_by_name = ?, decided_at = ? WHERE id = ? AND status = 'pending'", admin.id, admin.displayName, t, ap.id);
    audit(app.db, actor, { action: 'request.cancelled', targetType: 'request', targetId: requestId, systemId: r.system_id, details: { vorher: r.status, grundAngegeben: Boolean(reason) } }); // Grund nicht ins (unlöschbare) Audit-Log
  });
  removeRequestFiles(app, requestId);
  const why = reason ? ` Grund: „${reason.slice(0, 300)}${reason.length > 300 ? ' …' : ''}“` : '';
  notify(app, { to: { userId: r.user_id }, kind: 'request.cancelled', title: `Abgebrochen: ${r.title}`, body: `Die IT hat Ihre Anfrage abgebrochen. Sie wurde nicht übermittelt.${why}`, link: '/anfragen' });
  if (ap) notify(app, { to: { email: ap.approver_email }, kind: 'request.cancelled', title: `Abgebrochen: ${r.title}`, body: 'Die IT hat die Anfrage abgebrochen. Sie müssen nichts mehr tun.', link: `/freigaben/${ap.id}` });
  log.info('Anfrage abgebrochen', { request: requestId, vorher: r.status });
  return { previous: r.status };
}

// ---------------------------------------------------------------- Fristen (Worker)

export function approvalHousekeeping(app: App): { expired: number; reminded: number } {
  const t = Date.now();
  let expired = 0;
  for (const a of app.db.all<JoinedRow>(`${JOIN} WHERE a.status = 'pending' AND a.expires_at <= ? LIMIT 500`, t)) {
    const done = app.db.tx(() => {
      const upd = app.db.run("UPDATE approvals SET status = 'expired', summary = NULL, decided_at = ? WHERE id = ? AND status = 'pending'", t, a.id);
      if (!upd.changes) return false;
      discardRequest(app, a.request_id, 'expired');
      audit(app.db, { name: 'System' }, { action: 'approval.expired', targetType: 'request', targetId: a.request_id, systemId: a.r_system_id });
      return true;
    });
    if (!done) continue;
    removeRequestFiles(app, a.request_id);
    expired++;
    const days = app.cfg.approval.expireDays;
    notify(app, { to: { userId: a.r_user_id }, kind: 'approval.expired', title: `Abgelaufen: ${a.r_title}`, body: `${a.approver_name ?? a.approver_email} hat nicht innerhalb von ${days} Tagen entschieden. Die Anfrage wurde nicht übermittelt – bitte bei Bedarf neu stellen.`, link: '/anfragen' });
    notify(app, { to: { email: a.approver_email }, kind: 'approval.expired', title: `Abgelaufen: ${a.r_title}`, body: `Die Anfrage von ${a.requester_name} ist ohne Entscheidung abgelaufen.`, link: `/freigaben/${a.id}` });
  }
  let reminded = 0;
  const remind = app.cfg.approval.remindDays;
  if (remind > 0) {
    // Erinnerung einmal nach N Tagen (gerechnet ab Anfrage bzw. ab dem Wechsel der freigebenden Person)
    for (const a of app.db.all<{ id: string }>(
      "SELECT id FROM approvals WHERE status = 'pending' AND reminded_at IS NULL AND expires_at - ? <= ? LIMIT 500",
      app.cfg.approval.expireDays * 86400_000, t - remind * 86400_000,
    )) {
      if (app.db.run("UPDATE approvals SET reminded_at = ? WHERE id = ? AND reminded_at IS NULL AND status = 'pending'", t, a.id).changes) {
        notifyRequested(app, a.id, true);
        reminded++;
      }
    }
  }
  if (expired || reminded) log.info('Freigaben: Fristen geprüft', { abgelaufen: expired, erinnert: reminded });
  return { expired, reminded };
}
