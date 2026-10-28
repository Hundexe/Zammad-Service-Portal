// Annahme einer Anfrage und Zustellung an das Ticketsystem.
// Die Anfrage wird zuerst verschlüsselt gespeichert (Outbox) und dann vom Worker
// zugestellt – fällt Zammad aus, geht nichts verloren.
import type { App } from '../app.ts';
import { uuid } from '../db/db.ts';
import { HttpError } from '../http/core.ts';
import { log } from '../log.ts';
import { sha256 } from '../crypto.ts';
import { displayValue, isProtectedZammadField, isVisible, LIMITS, validateSubmission, type FormDefinition, type FormValues, type FileMeta } from '../../shared/form.ts';
import { escapeHtml, renderTemplate, textToHtml, type TemplateVars } from '../../shared/template.ts';
import type { AuthUser } from './rbac.ts';
import { checkFiles, loadFile, removeRequestFiles, storeFile, type CheckedFile, type IncomingFile } from './files.ts';
import { allowedGroups, connectorFor, getSystem, type SystemRow } from './systems.ts';
import { releasedAttributes } from './metadata.ts';
import type { FormRow, FormVersionRow } from './forms.ts';
import { ConnectorError, type CustomerRef } from '../connectors/types.ts';
import { approverFor, buildSummary, insertApproval, notifyRequested, type ApproverChoice } from './approvals.ts';

export interface TicketPayload {
  title: string;
  bodyHtml: string;
  group: string;
  priority?: string;
  fields: Record<string, unknown>;
  tags: string[];
  customer: { email: string; displayName: string };
}

export function buildTicket(
  sys: SystemRow, form: FormRow, def: FormDefinition, values: FormValues, user: AuthUser, requestId: string,
): TicketPayload {
  const vars: TemplateVars = {
    benutzer: { name: user.displayName, email: user.email ?? '', abteilung: user.department ?? '' },
    formular: { name: form.name },
    system: { name: sys.name },
    anfrage: { id: requestId.slice(0, 8) },
    datum: new Date().toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' }),
  };
  const rows: string[] = [];
  const zammadFields: Record<string, unknown> = {};
  const tags = new Set<string>([sys.portal_tag, ...(def.settings.tags ?? [])].map((t) => t.trim()).filter(Boolean));
  let group = def.settings.group || sys.default_group || '';
  let priority = def.settings.priority || undefined;
  // Zweite Verteidigungslinie: auch wenn eine gespeicherte Definition älter ist als die Prüfung im Editor,
  // landen nur freigegebene Felder und erlaubte Gruppen im Ticket.
  const released = new Set(releasedAttributes(sys).map((a) => a.name));

  for (const f of def.fields) {
    if (f.type === 'info' || !isVisible(f, values, def.fields)) continue;
    const v = values[f.id];
    if (v === undefined) continue;
    const shown = displayValue(f, v);
    vars[f.id] = shown;
    if (f.mapping?.target !== 'none') rows.push(`<tr><th align="left" valign="top">${escapeHtml(f.label)}</th><td>${f.type === 'textarea' ? textToHtml(shown) : escapeHtml(shown)}</td></tr>`);
    const m = f.mapping;
    if (!m) continue;
    const mapOne = (x: string) => m.valueMap?.[x] ?? x;
    switch (m.target) {
      case 'zammad_field':
        if (!m.name || isProtectedZammadField(m.name) || !released.has(m.name)) {
          log.warn('form.field_not_released', { system: sys.id, form: form.id, field: m.name ?? '' });
          break;
        }
        if (Array.isArray(v)) zammadFields[m.name] = v.map(String).map(mapOne);
        else if (m.valueMap && m.valueMap.true === 'true') zammadFields[m.name] = String(v) === 'true';
        else zammadFields[m.name] = typeof v === 'string' ? mapOne(v) : v;
        break;
      case 'tag':
        (Array.isArray(v) ? v.map(String) : [String(v)]).map(mapOne).forEach((t) => tags.add(t.slice(0, 60)));
        break;
      case 'group':
        group = mapOne(String(v));
        break;
      case 'priority':
        priority = mapOne(String(v));
        break;
      default:
        break;
    }
  }

  const table = rows.length ? `<table border="1" cellpadding="4" cellspacing="0">${rows.join('')}</table>` : '';
  const title = renderTemplate(def.settings.titleTemplate, vars, 'text') || form.name;
  const body = renderTemplate(def.settings.bodyTemplate, vars, 'html', { alle_felder: table })
    + `<p><small>Erstellt über das Service-Portal · Anfrage ${escapeHtml(requestId)}</small></p>`;
  if (!group) throw new HttpError(500, 'Für dieses Formular ist keine Zammad-Gruppe festgelegt', 'config_error');
  const allowed = allowedGroups(sys);
  if (allowed.length && !allowed.includes(group)) {
    log.warn('form.group_not_allowed', { system: sys.id, form: form.id, group });
    throw new HttpError(422, 'Dieses Formular ist falsch eingerichtet (Zielgruppe nicht erlaubt). Bitte die IT informieren.', 'group_not_allowed');
  }
  if (!user.email) throw new HttpError(422, 'Ihrem Konto ist keine E-Mail-Adresse zugeordnet', 'no_email');
  return {
    title,
    bodyHtml: body,
    group,
    priority,
    fields: zammadFields,
    tags: [...tags],
    customer: { email: user.email, displayName: user.displayName },
  };
}

export interface SubmitInput { values: FormValues; files: Record<string, IncomingFile[]> }

export async function submitRequest(
  app: App, user: AuthUser, sys: SystemRow, form: FormRow, version: FormVersionRow, def: FormDefinition, input: SubmitInput,
): Promise<{ id: string; title: string; approval: ApproverChoice | null }> {
  // Dateien: zuerst nur Metadaten für die Formularprüfung
  const values: FormValues = { ...(input.values ?? {}) };
  const fileFields = def.fields.filter((f) => f.type === 'file');
  for (const f of fileFields) {
    const list = input.files?.[f.id];
    values[f.id] = Array.isArray(list)
      ? list.map((x) => ({ name: String(x?.name ?? ''), size: typeof x?.data === 'string' ? Math.floor((x.data.length * 3) / 4) : 0, type: x?.type } as FileMeta))
      : undefined;
  }
  for (const key of Object.keys(input.files ?? {})) {
    if (!fileFields.some((f) => f.id === key)) throw new HttpError(400, 'Unbekanntes Dateifeld', 'bad_request');
  }
  const result = validateSubmission(def, values);
  if (!result.ok) throw new HttpError(422, 'Bitte die markierten Felder prüfen', 'validation', result.errors);
  // Freigabe durch Vorgesetzte nötig? Dann bleibt die Anfrage bis zur Entscheidung im Portal.
  const approval = approverFor(app, user, def, result.values);

  // Dateien inhaltlich prüfen (Typ, Virenscan)
  const checked: { fieldId: string; file: CheckedFile }[] = [];
  let total = 0;
  for (const f of fileFields) {
    if (result.values[f.id] === undefined) continue;
    const list = input.files[f.id] ?? [];
    const sizeLimit = Math.min(f.maxSizeMb ?? 10, LIMITS.maxFileSizeMb, app.cfg.upload.maxFileMb) * 1024 * 1024;
    const files = await checkFiles(app, list, f.accept, sizeLimit);
    for (const file of files) {
      total += file.data.length;
      checked.push({ fieldId: f.id, file });
    }
  }
  const totalMb = Math.min(LIMITS.maxTotalUploadMb, app.cfg.upload.maxTotalMb);
  if (total > totalMb * 1024 * 1024) throw new HttpError(413, `Alle Dateien zusammen höchstens ${totalMb} MB`, 'too_large');

  const id = uuid();
  // Dateinamen nach der Prüfung (bereinigt) in die Werte übernehmen
  for (const f of fileFields) {
    const mine = checked.filter((c) => c.fieldId === f.id);
    if (mine.length) result.values[f.id] = mine.map((c) => ({ name: c.file.filename, size: c.file.data.length }));
  }
  const payload = buildTicket(sys, form, def, result.values, user, id);
  const t = Date.now();
  let approvalId: string | null = null;
  app.db.tx(() => {
    app.db.run(
      `INSERT INTO requests (id, user_id, system_id, form_id, form_version_id, title, payload, status, attempts, next_attempt_at, created_at, queued_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      id, user.id, sys.id, form.id, version.id, payload.title, app.box.encrypt('request', JSON.stringify(payload)),
      approval ? 'awaiting_approval' : 'queued', t, t, approval ? null : t,
    );
    if (approval) approvalId = insertApproval(app, id, approval, buildSummary(def, result.values, user, form.name, sys.name));
    for (const c of checked) {
      const fileId = uuid();
      app.db.run(
        'INSERT INTO request_files (id, request_id, field_id, filename, mime, size, sha256) VALUES (?, ?, ?, ?, ?, ?, ?)',
        fileId, id, c.fieldId, c.file.filename, c.file.mime, c.file.data.length, sha256(c.file.data),
      );
      storeFile(app, id, fileId, c.file.data);
    }
  });
  if (approvalId) notifyRequested(app, approvalId);
  return { id, title: payload.title, approval };
}

// ---------------------------------------------------------------- Zustellung

interface RequestRow {
  id: string; user_id: string; system_id: string; title: string; payload: string | null; status: string;
  attempts: number; next_attempt_at: number; created_at: number;
}

const MAX_ATTEMPTS = 20;

export async function customerFor(app: App, sys: SystemRow, userId: string, email: string, displayName: string, create: boolean): Promise<CustomerRef | null> {
  // Zammad ordnet Tickets über die E-Mail-Adresse zu. Ein lokales Konto darf sich darüber nie
  // Zugriff auf die Tickets einer Person verschaffen, die sich mit Microsoft anmeldet.
  if (localEmailTaken(app, userId, email)) {
    app.db.run('DELETE FROM zammad_customers WHERE user_id = ?', userId);
    if (create) throw new ConnectorError('Die E-Mail-Adresse dieses lokalen Kontos gehört einem Microsoft-Konto – keine Zustellung', false);
    return null;
  }
  const cached = app.db.get<{ customer_id: number }>('SELECT customer_id FROM zammad_customers WHERE system_id = ? AND user_id = ?', sys.id, userId);
  if (cached) return { customerId: cached.customer_id, email };
  if (!create) {
    // Nur suchen, nicht anlegen (z. B. beim Anzeigen der Tickets)
    const ref = await connectorFor(app, sys).findCustomer(email);
    if (ref) app.db.run('INSERT OR REPLACE INTO zammad_customers (system_id, user_id, customer_id, updated_at) VALUES (?, ?, ?, ?)', sys.id, userId, ref.customerId, Date.now());
    return ref;
  }
  const ref = await connectorFor(app, sys).findOrCreateCustomer({ email, displayName });
  app.db.run('INSERT OR REPLACE INTO zammad_customers (system_id, user_id, customer_id, updated_at) VALUES (?, ?, ?, ?)', sys.id, userId, ref.customerId, Date.now());
  return ref;
}

/** Lokales Konto, dessen E-Mail-Adresse auch ein Microsoft-Konto hat? */
export function localEmailTaken(app: App, userId: string, email: string): boolean {
  const me = app.db.get<{ kind: string }>('SELECT kind FROM users WHERE id = ?', userId);
  if (me?.kind !== 'local') return false;
  return Boolean(app.db.get("SELECT 1 FROM users WHERE kind = 'entra' AND lower(email) = lower(?)", email));
}

/** Holt die nächste fällige Anfrage und stellt sie zu. Gibt false zurück, wenn nichts zu tun ist. */
export async function deliverNext(app: App): Promise<boolean> {
  const t = Date.now();
  // Hängengebliebene Zustellungen (z. B. nach Absturz) nach 5 Minuten wieder freigeben
  app.db.run("UPDATE requests SET status = 'queued' WHERE status = 'sending' AND next_attempt_at < ?", t - 5 * 60_000);
  const row = app.db.get<RequestRow>(
    `UPDATE requests SET status = 'sending', attempts = attempts + 1, next_attempt_at = ?
      WHERE id = (SELECT id FROM requests WHERE status = 'queued' AND next_attempt_at <= ? ORDER BY created_at LIMIT 1)
      RETURNING *`,
    t, t,
  );
  if (!row) return false;
  await deliver(app, row);
  return true;
}

async function deliver(app: App, row: RequestRow): Promise<void> {
  const sys = getSystem(app, row.system_id);
  const reschedule = (ms: number, error: string | null, countAttempt = true) => {
    app.db.run(
      "UPDATE requests SET status = 'queued', next_attempt_at = ?, last_error = ?, attempts = attempts - ? WHERE id = ?",
      Date.now() + ms, error, countAttempt ? 0 : 1, row.id,
    );
  };
  if (!sys || sys.status !== 'active') {
    // Wartung oder deaktiviert: später erneut versuchen, ohne Versuch zu zählen
    reschedule(5 * 60_000, sys ? `Ticketsystem im Status „${sys.status}“` : 'Ticketsystem fehlt', false);
    return;
  }
  if (!row.payload) {
    app.db.run("UPDATE requests SET status = 'failed', last_error = 'Inhalt fehlt' WHERE id = ?", row.id);
    return;
  }
  try {
    const payload = JSON.parse(app.box.decrypt('request', row.payload)) as TicketPayload;
    const files = app.db.all<{ id: string; filename: string; mime: string }>('SELECT id, filename, mime FROM request_files WHERE request_id = ? AND stored = 1', row.id);
    const attachments = files.map((f) => ({ filename: f.filename, mime: f.mime, data: loadFile(app, row.id, f.id) }));
    const customer = (await customerFor(app, sys, row.user_id, payload.customer.email, payload.customer.displayName, true))!;
    const connector = connectorFor(app, sys);
    // Wiederholung (Zeitüberschreitung, Absturz während der Zustellung): Zammad hat das Ticket vielleicht
    // schon angelegt. Dann nicht noch einmal anlegen, sondern das vorhandene übernehmen.
    const existing = row.attempts > 1 ? await connector.findTicketForRequest(customer, row.id, payload.title, row.created_at) : null;
    if (existing) log.warn('Anfrage war schon zugestellt – kein zweites Ticket', { request: row.id, ticket: existing.number });
    const ticket = existing ?? await connector.createTicket({
      customer, title: payload.title, group: payload.group, priority: payload.priority,
      bodyHtml: payload.bodyHtml, attachments, fields: payload.fields, tags: payload.tags,
    });
    const t = Date.now();
    app.db.tx(() => {
      app.db.run(
        "UPDATE requests SET status = 'delivered', ticket_id = ?, ticket_number = ?, delivered_at = ?, payload = NULL, last_error = NULL, purge_after = ? WHERE id = ?",
        ticket.id, ticket.number, t, t + app.cfg.retentionDays * 86400_000, row.id,
      );
      app.db.run('UPDATE request_files SET stored = 0 WHERE request_id = ?', row.id);
    });
    // Anhänge liegen jetzt in Zammad – Zwischenablage sofort löschen (Datensparsamkeit)
    removeRequestFiles(app, row.id);
    log.info('Anfrage zugestellt', { request: row.id, system: sys.slug, ticket: ticket.number });
  } catch (err) {
    const retryable = err instanceof ConnectorError ? err.retryable : false;
    const message = (err as Error).message.slice(0, 500);
    if (retryable && row.attempts < MAX_ATTEMPTS) {
      const delay = Math.min(2 ** row.attempts * 30_000, 3600_000);
      reschedule(delay, message);
      log.warn('Zustellung fehlgeschlagen, neuer Versuch geplant', { request: row.id, attempt: row.attempts, inSeconds: delay / 1000, error: message });
    } else {
      app.db.run("UPDATE requests SET status = 'failed', last_error = ?, purge_after = ? WHERE id = ?", message, Date.now() + app.cfg.retentionDays * 86400_000, row.id);
      log.error('Zustellung endgültig fehlgeschlagen', { request: row.id, error: message });
    }
  }
}

/** Löscht Inhalte nach Ablauf der Aufbewahrungsfrist. Titel und Ticketnummer bleiben für "Meine Anfragen". */
export function purgeOld(app: App): number {
  const rows = app.db.all<{ id: string }>('SELECT id FROM requests WHERE purge_after IS NOT NULL AND purge_after < ? AND (payload IS NOT NULL OR id IN (SELECT request_id FROM request_files WHERE stored = 1))', Date.now());
  for (const r of rows) {
    app.db.run('UPDATE requests SET payload = NULL WHERE id = ?', r.id);
    app.db.run('UPDATE request_files SET stored = 0 WHERE request_id = ?', r.id);
    removeRequestFiles(app, r.id);
  }
  // Einträge ganz entfernen, wenn sie älter als ein Jahr sind
  app.db.run("DELETE FROM requests WHERE created_at < ? AND status IN ('delivered', 'failed', 'rejected', 'withdrawn', 'expired')", Date.now() - 365 * 86400_000);
  return rows.length;
}

/** Erneut zustellen (Admin): fehlgeschlagene Anfrage zurück in die Warteschlange. */
export function retryRequest(app: App, id: string): boolean {
  const r = app.db.run("UPDATE requests SET status = 'queued', attempts = 0, next_attempt_at = ? WHERE id = ? AND status = 'failed' AND payload IS NOT NULL", Date.now(), id);
  return r.changes > 0;
}

export function requestsOfUser(app: App, userId: string, systemId?: string) {
  return app.db.all<{ id: string; system_id: string; title: string; status: string; ticket_number: string | null; ticket_id: number | null; created_at: number; delivered_at: number | null }>(
    `SELECT id, system_id, title, status, ticket_number, ticket_id, created_at, delivered_at FROM requests
      WHERE user_id = ? ${systemId ? 'AND system_id = ?' : ''} ORDER BY created_at DESC LIMIT 100`,
    ...(systemId ? [userId, systemId] : [userId]),
  );
}

