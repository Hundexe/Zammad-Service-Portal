// Formulare und ihre Versionen (Entwurf → ggf. Freigabe → veröffentlicht → archiviert).
import type { App } from '../app.ts';
import { parseJson, uuid } from '../db/db.ts';
import type { FormDefinition, FormField } from '../../shared/form.ts';
import type { SystemMetadata } from '../connectors/types.ts';
import type { AuthUser } from './rbac.ts';
import { groupsMatch, type SystemRow } from './systems.ts';
import { releasedWithOptions } from './metadata.ts';

export interface FormRow {
  id: string; system_id: string; slug: string; name: string; description: string; category: string;
  visible_groups: string; sort: number; active: number; created_at: number; updated_at: number;
}

export interface FormVersionRow {
  id: string; form_id: string; version: number; definition: string; status: 'draft' | 'pending' | 'published' | 'archived';
  note: string; created_by: string | null; created_at: number; submitted_by: string | null; approved_by: string | null; published_at: number | null;
}

export function getForm(app: App, id: string): FormRow | undefined {
  return app.db.get<FormRow>('SELECT * FROM forms WHERE id = ?', id);
}

export function publishedVersion(app: App, formId: string): FormVersionRow | undefined {
  return app.db.get<FormVersionRow>("SELECT * FROM form_versions WHERE form_id = ? AND status = 'published' ORDER BY version DESC LIMIT 1", formId);
}

export function latestVersion(app: App, formId: string): FormVersionRow | undefined {
  return app.db.get<FormVersionRow>('SELECT * FROM form_versions WHERE form_id = ? ORDER BY version DESC LIMIT 1', formId);
}

export function formVisibleTo(form: FormRow, user: AuthUser): boolean {
  return form.active === 1 && groupsMatch(parseJson<string[]>(form.visible_groups, []), user);
}

/**
 * Bereitet ein Formular für einen Benutzer auf:
 * - Felder, die nur für bestimmte Gruppen gedacht sind, werden entfernt.
 * - Zammad-Felder werden mit den freigegebenen Optionen in normale Felder umgewandelt.
 * - Zammad-Attribute, die nicht (mehr) freigegeben sind, verschwinden.
 */
export function resolveDefinition(def: FormDefinition, sys: SystemRow, meta: SystemMetadata, user: AuthUser | null): FormDefinition {
  const released = releasedWithOptions(sys, meta);
  const fields: FormField[] = [];
  for (const f of def.fields) {
    if (user && f.groups && f.groups.length && !groupsMatch(f.groups, user)) continue;
    if (f.type !== 'zammad') { fields.push(f); continue; }
    const attr = released.find((a) => a.name === f.attribute);
    if (!attr || !attr.portalType) continue;
    let options = attr.options;
    if (options && f.allowedValues && f.allowedValues.length) options = options.filter((o) => f.allowedValues!.includes(o.value));
    const isBool = attr.type === 'boolean';
    fields.push({
      ...f,
      type: isBool ? 'select' : attr.portalType,
      options,
      mapping: { target: 'zammad_field', name: attr.name, ...(isBool ? { valueMap: { true: 'true', false: 'false' } } : {}) },
      label: f.label || attr.display,
    });
  }
  // Sichtbarkeitsregeln, die auf entfernte Felder zeigen, verbergen das abhängige Feld.
  const ids = new Set(fields.map((f) => f.id));
  return { ...def, fields: fields.filter((f) => !f.visibleIf || ids.has(f.visibleIf.field)) };
}

/** Legt einen neuen Entwurf an oder aktualisiert den vorhandenen. */
export function saveDraft(app: App, formId: string, def: FormDefinition, userId: string, note = ''): FormVersionRow {
  const latest = latestVersion(app, formId);
  const json = JSON.stringify(def);
  if (latest && latest.status === 'draft') {
    app.db.run('UPDATE form_versions SET definition = ?, note = ?, created_by = ?, created_at = ? WHERE id = ?', json, note, userId, Date.now(), latest.id);
    return app.db.get<FormVersionRow>('SELECT * FROM form_versions WHERE id = ?', latest.id)!;
  }
  if (latest && latest.status === 'pending') throw new Error('Es wartet bereits eine Version auf Freigabe');
  const id = uuid();
  app.db.run(
    "INSERT INTO form_versions (id, form_id, version, definition, status, note, created_by, created_at) VALUES (?, ?, ?, ?, 'draft', ?, ?, ?)",
    id, formId, (latest?.version ?? 0) + 1, json, note, userId, Date.now(),
  );
  return app.db.get<FormVersionRow>('SELECT * FROM form_versions WHERE id = ?', id)!;
}

export function publishVersion(app: App, version: FormVersionRow, approverId: string | null): void {
  app.db.tx(() => {
    app.db.run("UPDATE form_versions SET status = 'archived' WHERE form_id = ? AND status = 'published'", version.form_id);
    app.db.run("UPDATE form_versions SET status = 'published', approved_by = ?, published_at = ? WHERE id = ?", approverId, Date.now(), version.id);
    app.db.run('UPDATE forms SET updated_at = ? WHERE id = ?', Date.now(), version.form_id);
  });
}

export function emptyDefinition(): FormDefinition {
  return {
    fields: [
      { id: 'beschreibung', type: 'textarea', label: 'Beschreibung', required: true, help: 'Was ist passiert bzw. was wird benötigt?', mapping: { target: 'article' } },
    ],
    settings: {
      titleTemplate: '{{formular.name}}: {{benutzer.name}}',
      bodyTemplate: '<p>Neue Anfrage über das Service-Portal.</p>\n{{alle_felder}}',
      tags: [],
      successText: 'Danke! Ihre Anfrage ist eingegangen. Sie erhalten eine Bestätigung von unserem Ticketsystem.',
    },
  };
}
