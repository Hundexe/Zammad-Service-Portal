// Verwaltung: Formulare und Formular-Editor.
import { h, icon, mount, fmtDate, type Child } from '../lib/dom.ts';
import { ApiError, get, post, put, del } from '../lib/api.ts';
import {
  badge, button, checkbox, confirmDialog, dialog, errorText, fieldWrap, input, listInput, notice, pageHead, select,
  statusBadge, table, tabs, textarea, toast,
} from '../lib/ui.ts';
import { can, link, navigate, state, curPath } from '../lib/app.ts';
import { renderForm } from '../lib/formrender.ts';
import { admin, adminSystem, loadAdminSystems } from './common.ts';
import { FILE_KINDS, type FormDefinition, type FormField, type FieldType } from '../../shared/form.ts';

interface VersionInfo { id: string; version: number; status: string; note: string; createdAt: number; createdBy: string | null; submittedBy: string | null; createdByName?: string | null; submittedByName?: string | null; approvedByName?: string | null; publishedAt: number | null }
interface AdminForm { id: string; systemId: string; slug: string; name: string; description: string; category: string; visibleGroups: string[]; sort: number; active: boolean; published: VersionInfo | null; latest: VersionInfo | null }
interface Released { name: string; display: string; type: string; portalType: string | null; options?: { value: string; label: string }[] }

const TYPE_LABEL: Record<string, string> = {
  text: 'Text', textarea: 'Mehrzeiliger Text', email: 'E-Mail', number: 'Zahl', date: 'Datum', checkbox: 'Kästchen (Ja/Nein)',
  select: 'Auswahl', multiselect: 'Mehrfachauswahl', file: 'Datei-Upload', info: 'Hinweistext', approver: 'Freigabe durch Vorgesetzte(n)', zammad: 'Zammad-Objekt',
};
const FILE_LABEL: Record<string, string> = { pdf: 'PDF', image: 'Bilder', office: 'Office-Dokumente', text: 'Text/CSV' };
const MAP_LABEL: Record<string, string> = { article: 'Nur im Tickettext', tag: 'Als Tag', group: 'Bestimmt die Gruppe', priority: 'Bestimmt die Priorität', zammad_field: 'In Zammad-Feld schreiben', none: 'Nicht übernehmen', title: 'Nur für den Titel' };

export function slugify(label: string, taken: Set<string>): string {
  let base = label.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30);
  if (!/^[a-z]/.test(base)) base = `feld_${base}`.replace(/_+$/, '');
  let id = base || 'feld', i = 2;
  while (taken.has(id)) id = `${base}_${i++}`;
  return id;
}

function formStatus(f: AdminForm): Child {
  const parts: Child[] = [];
  if (f.published) parts.push(badge(`Version ${f.published.version} veröffentlicht`, 'ok'));
  if (f.latest && f.latest.status !== 'published') parts.push(statusBadge(f.latest.status));
  if (!f.active) parts.push(badge('ausgeblendet'));
  return h('span', { class: 'badges' }, ...parts);
}

export async function formsListPage(p: Record<string, string>) {
  await loadAdminSystems();
  const s = adminSystem(p.systemId);
  const r = await get<{ forms: AdminForm[] }>(`/api/admin/systems/${s.id}/forms`);
  return h('div', null,
    pageHead('Formulare', `Formulare für ${s.name}`, can('form.edit', s.id) ? [button('Formular anlegen', () => void createFormDialog(s.id), { kind: 'primary', icon: 'plus' })] : []),
    table(r.forms, [
      { label: 'Name', class: 'grow', render: (f) => link(`/admin/systeme/${s.id}/formulare/${f.id}`, f.name) },
      { label: 'Kategorie', render: (f) => f.category },
      { label: 'Status', render: (f) => formStatus(f) },
      { label: '', render: (f) => admin.systems.length > 1 && can('form.edit', s.id) ? button('Kopieren …', () => void copyDialog(s.id, f), { kind: 'ghost', icon: 'copy' }) : null },
    ], { onRow: (f) => navigate(`/admin/systeme/${s.id}/formulare/${f.id}`), empty: 'Noch keine Formulare. Legen Sie das erste an.' }),
  );
}

async function createFormDialog(systemId: string) {
  const v = { name: '', slug: '', category: '', description: '' };
  const msg = h('div');
  const slugInput = input('', (x) => { v.slug = x; }, { required: true });
  await dialog('Formular anlegen', h('form', { class: 'stack', on: { submit: (e) => e.preventDefault() } }, msg,
    fieldWrap(input('', (x) => { v.name = x; if (!slugInput.dataset.touched) { v.slug = slugify(x, new Set()).replace(/_/g, '-'); slugInput.value = v.slug; } }, { required: true, placeholder: 'z. B. Hardware bestellen' }), { label: 'Name' }),
    fieldWrap((() => { slugInput.addEventListener('input', () => { slugInput.dataset.touched = '1'; }); return slugInput; })(), { label: 'Kürzel', help: 'Kleinbuchstaben, Ziffern, Bindestrich' }),
    fieldWrap(input('', (x) => { v.category = x; }, { placeholder: 'z. B. Hardware' }), { label: 'Kategorie', help: 'Formulare mit gleicher Kategorie stehen im Portal zusammen.' }),
    fieldWrap(textarea('', (x) => { v.description = x; }, { rows: 2 }), { label: 'Kurzbeschreibung' }),
  ), (close) => [
    button('Abbrechen', () => close(), { kind: 'ghost' }),
    button('Anlegen', async () => {
      try {
        const r = await post<{ form: AdminForm }>(`/api/admin/systems/${systemId}/forms`, v);
        close();
        navigate(`/admin/systeme/${systemId}/formulare/${r.form.id}`);
      } catch (err) { mount(msg, notice('error', errorText(err))); }
    }, { kind: 'primary' }),
  ]);
}

async function copyDialog(systemId: string, f: AdminForm) {
  let target = admin.systems.find((s) => s.id !== systemId)?.id ?? '';
  const msg = h('div');
  await dialog(`„${f.name}“ kopieren`, h('div', { class: 'stack' }, msg,
    fieldWrap(select(target, admin.systems.filter((s) => s.id !== systemId).map((s) => ({ value: s.id, label: s.name })), (x) => { target = x; }), { label: 'In Ticketsystem', help: 'Die Kopie wird als Entwurf angelegt. Zammad-Objekte müssen im Ziel-System ebenfalls freigegeben sein.' })),
  (close) => [button('Abbrechen', () => close(), { kind: 'ghost' }), button('Kopieren', async () => {
    try {
      const r = await post<{ form: AdminForm }>(`/api/admin/systems/${systemId}/forms/${f.id}/copy`, { targetSystemId: target });
      close();
      toast('Kopie angelegt');
      navigate(`/admin/systeme/${target}/formulare/${r.form.id}`);
    } catch (err) { mount(msg, notice('error', errorText(err))); }
  }, { kind: 'primary' })]);
}

/** Zammad-Felder für die Vorschau auflösen (wie der Server). */
function resolveForPreview(def: FormDefinition, released: Released[]): FormDefinition {
  const fields: FormField[] = [];
  for (const f of def.fields) {
    if (f.type !== 'zammad') { fields.push(f); continue; }
    const a = released.find((r) => r.name === f.attribute);
    if (!a || !a.portalType) continue;
    let options = a.options;
    if (options && f.allowedValues?.length) options = options.filter((o) => f.allowedValues!.includes(o.value));
    fields.push({ ...f, type: (a.type === 'boolean' ? 'select' : a.portalType) as FieldType, options });
  }
  return { ...def, fields };
}

export async function formEditorPage(p: Record<string, string>) {
  await loadAdminSystems();
  const s = adminSystem(p.systemId);
  const base = `/api/admin/systems/${s.id}/forms/${p.formId}`;
  const [data, metaRes, templates] = await Promise.all([
    get<{ form: AdminForm; definition: FormDefinition; versions: VersionInfo[] }>(base),
    get<{ metadata: { groups: { name: string }[]; priorities: { name: string }[] }; releasedResolved: Released[] }>(`/api/admin/systems/${s.id}/metadata`).catch(() => null),
    get<{ templates: { id: string; kind: string; name: string; content: string }[] }>(`/api/admin/systems/${s.id}/templates`).catch(() => ({ templates: [] })),
  ]);
  const released = metaRes?.releasedResolved ?? [];
  const def: FormDefinition = JSON.parse(JSON.stringify(data.definition));
  def.settings.tags ??= [];
  const meta = { ...data.form };
  let selected = def.fields[0]?.id ?? null;
  let tab = 'felder';
  let dirty = false;
  const editable = can('form.edit', s.id);

  const host = h('div', { class: 'editor' });
  const msg = h('div', { attrs: { 'aria-live': 'polite' } });
  const markDirty = () => { dirty = true; saveState.textContent = 'Ungespeicherte Änderungen'; saveState.className = 'save-state dirty'; };
  const saveState = h('span', { class: 'save-state' }, '');
  window.onbeforeunload = () => (dirty ? true : null);

  const latest = data.versions[0];
  const pending = data.versions.find((v) => v.status === 'pending');

  async function saveDraft(): Promise<boolean> {
    try {
      await put(`${base}/draft`, { definition: def });
      dirty = false;
      saveState.textContent = 'Entwurf gespeichert';
      saveState.className = 'save-state';
      mount(msg);
      return true;
    } catch (err) {
      mount(msg, notice('error', err instanceof ApiError && Array.isArray(err.details) ? h('div', null, h('p', null, err.message), h('ul', null, ...(err.details as string[]).map((d) => h('li', null, d)))) : errorText(err)));
      return false;
    }
  }

  function head(): HTMLElement {
    return h('div', { class: 'editor-head' },
      h('div', null,
        h('nav', { class: 'crumbs' }, link(`/admin/systeme/${s.id}/formulare`, icon('back', 14), 'Formulare')),
        h('h1', null, meta.name),
        h('p', { class: 'sub' }, formStatus(data.form), ' ', saveState)),
      h('div', { class: 'page-actions' },
        editable ? button('Entwurf speichern', async () => { if (await saveDraft()) toast('Entwurf gespeichert'); }) : null,
        can('form.publish', s.id) && !pending ? button(s.requireApproval ? 'Zur Freigabe senden' : 'Veröffentlichen', async () => {
          if (editable && !(await saveDraft())) return;
          try {
            const r = await post<{ status: string }>(`${base}/publish`);
            dirty = false;
            toast(r.status === 'pending' ? 'Zur Freigabe gesendet' : 'Veröffentlicht');
            navigate(curPath(), true);
          } catch (err) { mount(msg, notice('error', errorText(err))); }
        }, { kind: 'primary' }) : null));
  }

  // ------------------------------------------------ Felder
  function fieldList(): HTMLElement {
    let dragIndex = -1;
    const ul = h('ul', { class: 'field-list', attrs: { 'aria-label': 'Felder, per Ziehen sortierbar' } }, ...def.fields.map((f, i) => {
      const li = h('li', {
        class: ['field-row', f.id === selected && 'selected'],
        attrs: { draggable: editable ? 'true' : 'false' },
        on: {
          click: () => { selected = f.id; draw(); },
          dragstart: (e) => { dragIndex = i; e.dataTransfer?.setData('text/plain', String(i)); li.classList.add('dragging'); },
          dragend: () => li.classList.remove('dragging'),
          dragover: (e) => { e.preventDefault(); li.classList.add('drop'); },
          dragleave: () => li.classList.remove('drop'),
          drop: (e) => {
            e.preventDefault();
            const from = dragIndex >= 0 ? dragIndex : Number(e.dataTransfer?.getData('text/plain'));
            if (from === i || from < 0) return;
            const [moved] = def.fields.splice(from, 1);
            def.fields.splice(i, 0, moved);
            markDirty(); draw();
          },
        },
      },
        h('span', { class: 'grip', attrs: { 'aria-hidden': 'true' } }, icon('grip', 16)),
        h('span', { class: 'fr-label' }, f.label || '(ohne Bezeichnung)', f.required ? h('span', { class: 'req' }, ' *') : null),
        h('span', { class: 'fr-type' }, f.type === 'zammad' ? `Zammad: ${released.find((r) => r.name === f.attribute)?.display ?? f.attribute}` : TYPE_LABEL[f.type]),
        editable ? h('span', { class: 'fr-move' },
          h('button', { class: 'icon-btn', attrs: { type: 'button', 'aria-label': `${f.label} nach oben`, disabled: i === 0 }, on: { click: (e) => { e.stopPropagation(); [def.fields[i - 1], def.fields[i]] = [def.fields[i], def.fields[i - 1]]; markDirty(); draw(); } } }, icon('up', 14)),
          h('button', { class: 'icon-btn', attrs: { type: 'button', 'aria-label': `${f.label} nach unten`, disabled: i === def.fields.length - 1 }, on: { click: (e) => { e.stopPropagation(); [def.fields[i + 1], def.fields[i]] = [def.fields[i], def.fields[i + 1]]; markDirty(); draw(); } } }, icon('down', 14))) : null);
      return li;
    }));
    let newType = 'text';
    const typeOptions = [
      ...Object.entries(TYPE_LABEL).filter(([k]) => k !== 'zammad').map(([value, label]) => ({ value, label })),
      ...released.filter((r) => r.portalType).map((r) => ({ value: `zammad:${r.name}`, label: `Zammad-Objekt: ${r.display}` })),
    ];
    return h('div', { class: 'col col-fields' },
      h('h2', null, 'Felder'),
      ul,
      editable ? h('div', { class: 'add-field' },
        select(newType, typeOptions, (x) => { newType = x; }, { id: 'new-field-type' }),
        button('Hinzufügen', () => {
          const taken = new Set(def.fields.map((f) => f.id));
          let f: FormField;
          if (newType.startsWith('zammad:')) {
            const a = released.find((r) => r.name === newType.slice(7))!;
            f = { id: slugify(a.display, taken), type: 'zammad', label: a.display, attribute: a.name };
          } else {
            const label = TYPE_LABEL[newType];
            f = { id: slugify(label, taken), type: newType as FieldType, label, mapping: { target: 'article' } };
            if (newType === 'select' || newType === 'multiselect') f.options = [{ value: 'option_1', label: 'Option 1' }, { value: 'option_2', label: 'Option 2' }];
            if (newType === 'file') { f.maxFiles = 3; f.maxSizeMb = 10; }
            if (newType === 'approver') {
              if (def.fields.some((x) => x.type === 'approver')) { mount(msg, notice('error', 'Ein Formular kann nur ein Freigabe-Feld haben.')); return; }
              f.label = 'Wer gibt die Anfrage frei?';
              f.id = slugify('freigabe', taken);
              f.help = 'E-Mail-Adresse Ihrer bzw. Ihres Vorgesetzten. Die Anfrage geht erst nach der Freigabe an die IT.';
              f.placeholder = 'vorname.nachname@…';
            }
          }
          def.fields.push(f);
          selected = f.id;
          markDirty(); draw();
        }, { icon: 'plus' })) : null,
      !released.length ? h('p', { class: 'small muted' }, 'Tipp: Unter „Zammad-Objekte“ freigegebene Ticket-Attribute erscheinen hier als eigene Feldtypen.') : null,
    );
  }

  function optionsToText(o?: { value: string; label: string }[]) { return (o ?? []).map((x) => (x.value === x.label ? x.value : `${x.value} = ${x.label}`)).join('\n'); }
  function textToOptions(t: string) {
    return t.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
      const i = l.indexOf('=');
      return i > 0 ? { value: l.slice(0, i).trim(), label: l.slice(i + 1).trim() } : { value: l, label: l };
    });
  }

  function properties(): HTMLElement {
    const f = def.fields.find((x) => x.id === selected);
    if (!f) return h('div', { class: 'col col-props' }, h('p', { class: 'muted' }, 'Feld links auswählen.'));
    const upd = (fn: () => void, redraw = false) => { fn(); markDirty(); if (redraw) draw(); else drawPreview(); };
    const taken = new Set(def.fields.filter((x) => x !== f).map((x) => x.id));
    const attr = f.type === 'zammad' ? released.find((r) => r.name === f.attribute) : undefined;
    const others = def.fields.filter((x) => x !== f && x.type !== 'info' && x.type !== 'file' && x.type !== 'approver');
    const rule = f.visibleIf;
    const items: Child[] = [
      h('h2', null, 'Eigenschaften'),
      fieldWrap(input(f.label, (x) => upd(() => { f.label = x; })), { label: 'Bezeichnung' }),
      f.type !== 'info' ? fieldWrap(input(f.id, (x) => upd(() => {
        const old = f.id;
        if (/^[a-z][a-z0-9_]{0,39}$/.test(x) && !taken.has(x)) {
          f.id = x; selected = x;
          def.fields.forEach((o) => { if (o.visibleIf?.field === old) o.visibleIf.field = x; });
        }
      })), { label: 'Feld-ID', help: 'Für Vorlagen: {{' + f.id + '}}. Nur a–z, 0–9, _.' }) : null,
      fieldWrap(textarea(f.help ?? '', (x) => upd(() => { f.help = x || undefined; }), { rows: 2 }), { label: f.type === 'info' ? 'Text' : 'Hilfetext' }),
    ];
    if (f.type === 'approver') {
      items.push(notice('info', 'Die anfragende Person gibt hier ihre Vorgesetzte bzw. ihren Vorgesetzten an. Die Anfrage wartet im Portal, bis diese Person sie unter „Freigaben“ freigibt – erst dann landet sie im Ticketsystem. Bei Ablehnung oder ohne Entscheidung wird sie gelöscht.'),
        checkbox(f.knownOnly === true, 'Nur Personen, die sich schon im Portal angemeldet haben', (x) => upd(() => { f.knownOnly = x || undefined; }),
          'Schützt vor Tippfehlern und erfundenen Adressen. Wer sich noch nie angemeldet hat, kann dann nicht gewählt werden.'),
        h('p', { class: 'small muted' }, 'Das Feld ist immer Pflicht, sobald es sichtbar ist. Mit „Nur anzeigen, wenn …“ lässt sich die Freigabe auf bestimmte Fälle beschränken, z. B. nur bei teurer Hardware.'));
    }
    if (f.type !== 'info' && f.type !== 'approver') {
      items.push(checkbox(Boolean(f.required), 'Pflichtfeld', (x) => upd(() => { f.required = x || undefined; })));
    }
    if (['text', 'textarea', 'email', 'number', 'approver'].includes(f.type)) {
      items.push(fieldWrap(input(f.placeholder ?? '', (x) => upd(() => { f.placeholder = x || undefined; })), { label: 'Platzhalter' }));
    }
    if (['text', 'textarea', 'email', 'select', 'date'].includes(f.type)) {
      items.push(h('div', { class: 'grid-2' },
        fieldWrap(input(f.default ?? '', (x) => upd(() => { f.default = x || undefined; })), { label: 'Standardwert' }),
        fieldWrap(select(f.defaultFrom ?? '', [{ value: 'user.name', label: 'Name des Benutzers' }, { value: 'user.email', label: 'E-Mail des Benutzers' }, { value: 'user.department', label: 'Abteilung des Benutzers' }], (x) => upd(() => { f.defaultFrom = (x || undefined) as FormField['defaultFrom']; }), { empty: '–' }), { label: 'Vorbelegen mit' })));
    }
    if (f.type === 'text' || f.type === 'textarea') {
      items.push(h('div', { class: 'grid-2' },
        fieldWrap(input(String(f.maxLength ?? ''), (x) => upd(() => { f.maxLength = x ? Number(x) : undefined; }), { type: 'number', min: 1 }), { label: 'Höchstlänge' }),
        fieldWrap(input(f.pattern ?? '', (x) => upd(() => { f.pattern = x || undefined; })), { label: 'Prüfmuster (Regex)', help: 'z. B. [A-Z]{2}-\\d{4} für Inventarnummern' })));
      if (f.pattern) items.push(fieldWrap(input(f.patternMessage ?? '', (x) => upd(() => { f.patternMessage = x || undefined; })), { label: 'Meldung bei falschem Format' }));
    }
    if (f.type === 'number') {
      items.push(h('div', { class: 'grid-2' },
        fieldWrap(input(String(f.min ?? ''), (x) => upd(() => { f.min = x === '' ? undefined : Number(x); }), { type: 'number' }), { label: 'Minimum' }),
        fieldWrap(input(String(f.max ?? ''), (x) => upd(() => { f.max = x === '' ? undefined : Number(x); }), { type: 'number' }), { label: 'Maximum' })));
    }
    if (f.type === 'select' || f.type === 'multiselect') {
      items.push(fieldWrap(textarea(optionsToText(f.options), (x) => upd(() => { f.options = textToOptions(x); }), { rows: 5 }), { label: 'Optionen', help: 'Eine pro Zeile. „wert = Bezeichnung“ oder nur die Bezeichnung.' }));
    }
    if (f.type === 'file') {
      items.push(h('div', { class: 'grid-2' },
        fieldWrap(input(String(f.maxFiles ?? 3), (x) => upd(() => { f.maxFiles = Number(x) || 1; }), { type: 'number', min: 1, max: 10 }), { label: 'Höchstens Dateien' }),
        fieldWrap(input(String(f.maxSizeMb ?? 10), (x) => upd(() => { f.maxSizeMb = Number(x) || 10; }), { type: 'number', min: 1, max: 20 }), { label: 'Max. MB je Datei' })),
      h('p', { class: 'label' }, 'Erlaubte Dateitypen'),
      h('div', { class: 'value-grid' }, ...FILE_KINDS.map((k) => checkbox(!f.accept?.length || f.accept.includes(k), FILE_LABEL[k], (x) => upd(() => {
        const set = new Set(f.accept?.length ? f.accept : FILE_KINDS);
        x ? set.add(k) : set.delete(k);
        f.accept = set.size === FILE_KINDS.length ? undefined : [...set];
      })))));
    }
    if (f.type === 'zammad') {
      items.push(attr ? notice('info', `Schreibt in das Zammad-Feld „${attr.name}“ (${attr.type}). Optionen kommen live aus Zammad.`) : notice('warn', `Zammad-Attribut „${f.attribute}“ ist nicht (mehr) freigegeben – das Feld wird im Portal nicht angezeigt.`));
      if (attr?.options?.length) {
        items.push(h('p', { class: 'label' }, 'In diesem Formular auswählbar'),
          checkbox(!f.allowedValues?.length, 'Alle freigegebenen Werte', (x) => upd(() => { f.allowedValues = x ? undefined : attr.options!.map((o) => o.value); }, true)),
          f.allowedValues?.length ? h('div', { class: 'value-grid' }, ...attr.options.map((o) => checkbox(f.allowedValues!.includes(o.value), o.label, (x) => upd(() => {
            const set = new Set(f.allowedValues ?? []);
            x ? set.add(o.value) : set.delete(o.value);
            f.allowedValues = [...set];
          })))) : null);
      }
    }
    if (f.type !== 'info') {
      items.push(h('details', { class: 'more', attrs: { open: Boolean(rule) || undefined } }, h('summary', null, 'Nur anzeigen, wenn …'),
        fieldWrap(select(rule?.field ?? '', others.map((o) => ({ value: o.id, label: o.label })), (x) => upd(() => { f.visibleIf = x ? { field: x, op: rule?.op ?? 'eq', value: rule?.value ?? '' } : undefined; }, true), { empty: 'immer anzeigen' }), { label: 'Feld' }),
        rule ? h('div', { class: 'grid-2' },
          fieldWrap(select(rule.op, [{ value: 'eq', label: 'ist gleich' }, { value: 'neq', label: 'ist nicht' }, { value: 'in', label: 'ist einer von (Komma)' }, { value: 'notEmpty', label: 'ist ausgefüllt' }], (x) => upd(() => { rule.op = x as typeof rule.op; }, true)), { label: 'Bedingung' }),
          rule.op !== 'notEmpty' ? fieldWrap(input(Array.isArray(rule.value) ? rule.value.join(',') : rule.value ?? '', (x) => upd(() => { rule.value = x; })), { label: 'Wert', help: 'Bei Auswahlfeldern der Optionswert' }) : null) : null));
      items.push(h('details', { class: 'more', attrs: { open: Boolean(f.groups?.length) || undefined } }, h('summary', null, 'Nur für bestimmte Gruppen'),
        fieldWrap(listInput(f.groups ?? [], (x) => upd(() => { f.groups = x.length ? x : undefined; })), { label: 'Entra-Gruppen (Objekt-IDs)', help: 'Leer = für alle. Sonst sehen nur Mitglieder dieser Gruppen das Feld.' })));
    }
    if (f.type !== 'info' && f.type !== 'zammad') {
      const m = f.mapping ?? { target: 'article' as const };
      const targets = Object.entries(MAP_LABEL).filter(([k]) => f.type !== 'approver' || k === 'article' || k === 'none');
      items.push(h('details', { class: 'more', attrs: { open: m.target !== 'article' || undefined } }, h('summary', null, 'Übernahme ins Ticket'),
        fieldWrap(select(m.target, targets.map(([value, label]) => ({ value, label })), (x) => upd(() => { f.mapping = { ...m, target: x as typeof m.target }; }, true)), { label: 'Verwendung', help: 'Alle Felder stehen außerdem im Tickettext ({{alle_felder}}), außer „Nicht übernehmen“.' }),
        m.target === 'zammad_field' ? fieldWrap(input(m.name ?? '', (x) => upd(() => { f.mapping = { ...m, name: x }; })), { label: 'Name des Zammad-Feldes' }) : null,
        ['tag', 'group', 'priority', 'zammad_field'].includes(m.target) && (f.options?.length) ? fieldWrap(textarea(Object.entries(m.valueMap ?? {}).map(([k, v]) => `${k} = ${v}`).join('\n'), (x) => upd(() => {
          const map: Record<string, string> = {};
          x.split('\n').forEach((l) => { const i = l.indexOf('='); if (i > 0) map[l.slice(0, i).trim()] = l.slice(i + 1).trim(); });
          f.mapping = { ...m, valueMap: Object.keys(map).length ? map : undefined };
        }), { rows: 3 }), { label: 'Werte übersetzen', help: m.target === 'group' ? 'z. B. „netzwerk = IT-Support::Netzwerk“' : 'Formularwert = Wert in Zammad' }) : null));
    }
    if (editable) items.push(h('div', { class: 'row' }, button('Feld entfernen', async () => {
      if (!await confirmDialog('Feld entfernen?', `„${f.label}“ wird aus dem Entwurf entfernt.`, 'Entfernen', true)) return;
      def.fields = def.fields.filter((x) => x !== f);
      def.fields.forEach((o) => { if (o.visibleIf?.field === f.id) o.visibleIf = undefined; });
      selected = def.fields[0]?.id ?? null;
      markDirty(); draw();
    }, { kind: 'danger', icon: 'trash' })));
    const box = h('div', { class: 'col col-props' }, ...items);
    if (!editable) box.querySelectorAll('input,textarea,select').forEach((el) => el.setAttribute('disabled', ''));
    return box;
  }

  const previewHost = h('div', { class: 'preview-body' });
  function drawPreview() {
    const r = renderForm(resolveForPreview(def, released), { preview: true });
    mount(previewHost, r.el, h('div', { class: 'form-actions' }, h('button', { class: ['btn', 'btn-primary'], attrs: { type: 'button', disabled: true } }, 'Anfrage senden')));
  }

  // ------------------------------------------------ Ticket-Einstellungen
  function ticketTab(): HTMLElement {
    const st = def.settings;
    const tpl = (kind: string, apply: (c: string) => void) => {
      const list = templates.templates.filter((t) => t.kind === kind);
      return list.length && editable ? h('div', { class: 'tpl-insert' }, h('span', { class: 'small muted' }, 'Vorlage übernehmen: '), ...list.map((t) => button(t.name, () => { apply(t.content); markDirty(); draw(); }, { kind: 'ghost' }))) : null;
    };
    const fieldsHelp = def.fields.filter((f) => f.type !== 'info').map((f) => `{{${f.id}}}`).join(', ');
    const groups = metaRes?.metadata.groups.map((g) => ({ value: g.name, label: g.name })) ?? [];
    const prios = metaRes?.metadata.priorities.map((g) => ({ value: g.name, label: g.name })) ?? [];
    const box = h('div', { class: 'panel stack' },
      h('h2', null, 'So entsteht das Ticket'),
      h('div', { class: 'grid-2' },
        fieldWrap(groups.length ? select(st.group ?? '', groups, (x) => { st.group = x || undefined; markDirty(); }, { empty: `Standard (${s.defaultGroup ?? '–'})` }) : input(st.group ?? '', (x) => { st.group = x || undefined; markDirty(); }), { label: 'Zammad-Gruppe' }),
        fieldWrap(prios.length ? select(st.priority ?? '', prios, (x) => { st.priority = x || undefined; markDirty(); }, { empty: 'Standard' }) : input(st.priority ?? '', (x) => { st.priority = x || undefined; markDirty(); }), { label: 'Priorität' })),
      fieldWrap(listInput(st.tags ?? [], (x) => { st.tags = x; markDirty(); }), { label: 'Zusätzliche Tags', help: `Der Tag „${s.portalTag}“ wird immer gesetzt.` }),
      fieldWrap(input(st.titleTemplate, (x) => { st.titleTemplate = x; markDirty(); }), { label: 'Ticket-Titel', help: `Platzhalter: ${fieldsHelp}, {{benutzer.name}}, {{benutzer.abteilung}}, {{formular.name}}, {{datum}}` }),
      tpl('title', (c) => { st.titleTemplate = c; }),
      fieldWrap(textarea(st.bodyTemplate, (x) => { st.bodyTemplate = x; markDirty(); }, { rows: 8, class: 'code' }), { label: 'Tickettext (HTML)', help: '{{alle_felder}} fügt eine Tabelle mit allen ausgefüllten Feldern ein. Eingaben der Benutzer werden immer sicher maskiert.' }),
      tpl('body', (c) => { st.bodyTemplate = c; }),
      fieldWrap(textarea(st.successText ?? '', (x) => { st.successText = x; markDirty(); }, { rows: 3 }), { label: 'Text nach dem Absenden' }),
      tpl('success', (c) => { st.successText = c; }),
    );
    if (!editable) box.querySelectorAll('input,textarea,select,button').forEach((el) => el.setAttribute('disabled', ''));
    return box;
  }

  function generalTab(): HTMLElement {
    const m = { ...meta };
    return h('div', { class: 'panel stack' },
      h('h2', null, 'Allgemein'),
      notice('info', 'Diese Angaben gelten sofort und sind nicht versioniert.'),
      fieldWrap(input(m.name, (x) => { m.name = x; }), { label: 'Name' }),
      fieldWrap(input(m.category, (x) => { m.category = x; }), { label: 'Kategorie' }),
      fieldWrap(textarea(m.description, (x) => { m.description = x; }, { rows: 2 }), { label: 'Kurzbeschreibung' }),
      fieldWrap(listInput(m.visibleGroups, (x) => { m.visibleGroups = x; }, 'Leer = für alle'), { label: 'Sichtbar für Entra-Gruppen' }),
      fieldWrap(input(String(m.sort), (x) => { m.sort = Number(x) || 0; }, { type: 'number' }), { label: 'Reihenfolge' }),
      checkbox(m.active, 'Im Portal anzeigen', (x) => { m.active = x; }),
      h('div', { class: 'row' },
        editable ? button('Speichern', async () => {
          try { await put(base, m); Object.assign(meta, m); toast('Gespeichert'); draw(); } catch (err) { toast(errorText(err), 'error'); }
        }, { kind: 'primary' }) : null,
        can('form.publish', s.id) ? button('Formular löschen', async () => {
          if (!await confirmDialog('Formular löschen?', `„${meta.name}“ und alle Versionen werden gelöscht.`, 'Löschen', true)) return;
          await del(base); dirty = false; toast('Gelöscht'); navigate(`/admin/systeme/${s.id}/formulare`);
        }, { kind: 'danger' }) : null));
  }

  function versionsTab(): HTMLElement {
    return h('div', { class: 'panel' },
      h('h2', null, 'Versionen'),
      table(data.versions, [
        { label: 'Version', class: 'num', render: (v) => String(v.version) },
        { label: 'Status', render: (v) => statusBadge(v.status) },
        { label: 'Bearbeitet', render: (v) => `${fmtDate(v.createdAt)} ${v.createdByName ? `von ${v.createdByName}` : ''}` },
        { label: 'Freigabe', render: (v) => v.status === 'pending' ? `eingereicht von ${v.submittedByName ?? '?'}` : v.approvedByName ? `freigegeben von ${v.approvedByName}` : v.note },
        { label: '', render: (v) => h('span', { class: 'row' },
          v.status === 'pending' && can('form.approve', s.id) && v.submittedBy !== state.me?.user.id && v.createdBy !== state.me?.user.id ? button('Freigeben', async () => {
            try { await post(`${base}/versions/${v.id}/approve`); toast('Freigegeben und veröffentlicht'); navigate(curPath(), true); } catch (err) { toast(errorText(err), 'error'); }
          }, { kind: 'primary' }) : null,
          v.status === 'pending' && can('form.approve', s.id) ? button('Ablehnen', async () => {
            await post(`${base}/versions/${v.id}/reject`, { reason: '' }); toast('Zurück an den Entwurf'); navigate(curPath(), true);
          }, { kind: 'ghost' }) : null,
          editable && v.id !== latest?.id ? button('Als Entwurf wiederherstellen', async () => {
            try { await post(`${base}/versions/${v.id}/restore`); toast('Als neuer Entwurf wiederhergestellt'); navigate(curPath(), true); } catch (err) { toast(errorText(err), 'error'); }
          }, { kind: 'ghost' }) : null) },
      ]));
  }

  function draw() {
    const body = tab === 'felder'
      ? h('div', { class: 'editor-grid' }, fieldList(), properties(), h('div', { class: 'col col-preview' }, h('h2', null, 'Vorschau'), previewHost))
      : tab === 'ticket' ? ticketTab() : tab === 'allgemein' ? generalTab() : versionsTab();
    mount(host,
      head(),
      msg,
      pending ? notice('warn', `Version ${pending.version} wartet auf Freigabe durch eine zweite Person. Bis dahin sind keine Änderungen möglich.`) : null,
      !editable ? notice('info', 'Sie können dieses Formular ansehen, aber nicht bearbeiten.') : null,
      tabs([{ id: 'felder', label: 'Felder' }, { id: 'ticket', label: 'Ticket' }, { id: 'allgemein', label: 'Allgemein' }, { id: 'versionen', label: `Versionen (${data.versions.length})` }], tab, (t) => { tab = t; draw(); }),
      body);
    if (tab === 'felder') drawPreview();
  }
  draw();
  return host;
}
