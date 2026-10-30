// Verwaltung: Formulare und Formular-Editor.
import { h, icon, mount, fmtDate,            } from '../lib/dom.js?v=142b079f7fc6';
import { ApiError, get, post, put, del } from '../lib/api.js?v=142b079f7fc6';
import {
  badge, button, checkbox, confirmDialog, dialog, errorText, fieldWrap, input, listInput, notice, pageHead, select,
  statusBadge, table, tabs, textarea, toast,
} from '../lib/ui.js?v=142b079f7fc6';
import { can, feature, link, navigate, state, curPath } from '../lib/app.js?v=142b079f7fc6';
import { renderForm } from '../lib/formrender.js?v=142b079f7fc6';
import { admin, adminSystem, loadAdminSystems } from './common.js?v=142b079f7fc6';
import { isAdvanced, onModeChange, showAdvanced } from './mode.js?v=142b079f7fc6';
import { FILE_KINDS,                                                     } from '../../shared/form.js?v=142b079f7fc6';

                                                                                                                                                                                                                                                                                                                                                                                              
                                                                                                                                                                                                                                          
                                                                                                                                           

const TYPE_LABEL                         = {
  text: 'Text', textarea: 'Mehrzeiliger Text', email: 'E-Mail', number: 'Zahl', date: 'Datum', checkbox: 'Kästchen (Ja/Nein)',
  select: 'Auswahl', multiselect: 'Mehrfachauswahl', file: 'Datei-Upload', info: 'Hinweistext', approver: 'Freigabe durch Vorgesetzte(n)', zammad: 'Zammad-Objekt',
};
const FILE_LABEL                         = { pdf: 'PDF', image: 'Bilder', office: 'Office-Dokumente', text: 'Text/CSV' };
const MAP_LABEL                         = { article: 'Nur im Tickettext', tag: 'Als Tag', group: 'Bestimmt die Gruppe', priority: 'Bestimmt die Priorität', zammad_field: 'In Zammad-Feld schreiben', system: 'Leitet an ein Ticketsystem weiter', none: 'Nicht übernehmen', title: 'Nur für den Titel' };
/** In der einfachen Ansicht wählbar (ein schon gesetztes Ziel bleibt immer sichtbar). */
const SIMPLE_TARGETS = new Set(['article', 'tag', 'group', 'priority', 'none']);

export function slugify(label        , taken             )         {
  let base = label.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30);
  if (!/^[a-z]/.test(base)) base = `feld_${base}`.replace(/_+$/, '');
  let id = base || 'feld', i = 2;
  while (taken.has(id)) id = `${base}_${i++}`;
  return id;
}

function formStatus(f           )        {
  const parts          = [];
  if (f.published) parts.push(badge(`Version ${f.published.version} veröffentlicht`, 'ok'));
  if (f.latest && f.latest.status !== 'published') parts.push(statusBadge(f.latest.status));
  if (!f.active) parts.push(badge('ausgeblendet'));
  return h('span', { class: 'badges' }, ...parts);
}

export async function formsListPage(p                        ) {
  await loadAdminSystems();
  const s = adminSystem(p.systemId);
  const r = await get                        (`/api/admin/systems/${s.id}/forms`);
  return h('div', null,
    pageHead('Formulare', `Formulare für ${s.name}`, can('form.edit', s.id) ? [
      button('In Datei exportieren', () => void exportFormsFile(s.id), { icon: 'down' }),
      button('Aus Datei übernehmen …', () => void importFormsDialog(s.id, s.name), { icon: 'file' }),
      button('Formular anlegen', () => void createFormDialog(s.id), { kind: 'primary', icon: 'plus' }),
    ] : []),
    table(r.forms, [
      { label: 'Name', class: 'grow', render: (f) => link(`/admin/systeme/${s.id}/formulare/${f.id}`, f.name) },
      { label: 'Kategorie', render: (f) => f.category },
      { label: 'Status', render: (f) => formStatus(f) },
      { label: '', render: (f) => admin.systems.length > 1 && can('form.edit', s.id) ? button('Kopieren …', () => void copyDialog(s.id, f), { kind: 'ghost', icon: 'copy' }) : null },
    ], { onRow: (f) => navigate(`/admin/systeme/${s.id}/formulare/${f.id}`), empty: 'Noch keine Formulare. Legen Sie das erste an.' }),
  );
}

async function createFormDialog(systemId        ) {
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
        const r = await post                     (`/api/admin/systems/${systemId}/forms`, v);
        close();
        navigate(`/admin/systeme/${systemId}/formulare/${r.form.id}`);
      } catch (err) { mount(msg, notice('error', errorText(err))); }
    }, { kind: 'primary' }),
  ]);
}

                                                                                                                                                                                                                       

/** Formulare aus einer JSON-Datei übernehmen: gleiches Kürzel → neue Version, sonst neues Formular. */
/** Formulare und Vorlagen des Ticketsystems als JSON-Datei herunterladen (Format wie „Aus Datei übernehmen“). */
export async function exportFormsFile(systemId        )                {
  try {
    const r = await get                                                                      (`/api/admin/systems/${systemId}/form-export`);
    const d = new Date();
    const two = (n        ) => String(n).padStart(2, '0');
    const url = URL.createObjectURL(new Blob([JSON.stringify({ forms: r.forms, templates: r.templates }, null, 2)], { type: 'application/json' }));
    const a = h('a', { attrs: { href: url, download: `formulare-${r.system.slug}-${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}.json` } });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    toast(`${r.forms.length} Formular(e) und ${r.templates.length} Vorlage(n) exportiert`);
  } catch (err) { toast(errorText(err), 'error'); }
}

export async function importFormsDialog(systemId        , systemName        , templatesOnly = false) {
  let data                                                  = null;
  let publish = !templatesOnly && can('form.publish', systemId);
  const msg = h('div', { attrs: { 'aria-live': 'polite' } });
  const planHost = h('div');
  const fileInput = h('input', { attrs: { type: 'file', accept: '.json,application/json', class: 'visually-hidden', id: 'forms-file' } });
  const fileLabel = h('span', { class: 'muted' }, 'Keine Datei gewählt');
  const ACTION                         = { create: 'neu', update: 'neue Version', unchanged: 'unverändert' };
  const errorBox = (err         ) => err instanceof ApiError && Array.isArray(err.details)
    ? notice('error', h('p', null, err.message), h('ul', null, ...(err.details            ).map((d) => h('li', null, String(d)))))
    : notice('error', errorText(err));
  const preview = async () => {
    mount(msg); mount(planHost);
    if (!data) return;
    try {
      const r = await post                         (`/api/admin/systems/${systemId}/forms/import`, { forms: data.forms, templates: data.templates, publish, dryRun: true });
      mount(planHost,
        r.plan.forms.length === 0 ? null : table(r.plan.forms, [{ label: 'Formular', class: 'grow', render: (f) => h('span', null, f.name, h('br'), h('span', { class: 'muted small' }, f.slug)) }, { label: 'Übernahme', render: (f) => ACTION[f.action] }]),
        r.plan.templates.length ? h('p', { class: 'small muted' }, `Vorlagen: ${r.plan.templates.map((t) => `${t.name} (${t.action === 'create' ? 'neu' : 'aktualisiert'})`).join(', ')}`) : null,
        r.plan.forms.length === 0 ? null : h('p', { class: 'small' }, r.plan.publish === 'published' ? 'Geänderte Formulare werden sofort veröffentlicht.' : r.plan.publish === 'pending' ? 'Geänderte Formulare gehen zur Freigabe (Vier-Augen-Prinzip).' : 'Geänderte Formulare werden als Entwurf gespeichert.'));
    } catch (err) { mount(msg, errorBox(err)); }
  };
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files?.[0];
    fileInput.value = '';
    if (!f) return;
    try {
      const parsed = JSON.parse(await f.text());
      data = Array.isArray(parsed) ? { forms: parsed } : parsed;
      if (templatesOnly && data) data = { templates: data.templates };
      fileLabel.textContent = f.name;
      await preview();
    } catch { data = null; mount(msg, notice('error', 'Die Datei ist kein gültiges JSON.')); }
  });
  await dialog(`${templatesOnly ? 'Vorlagen' : 'Formulare'} übernehmen – ${systemName}`, h('div', { class: 'stack' },
    h('p', { class: 'muted' }, templatesOnly
      ? 'JSON-Datei mit „templates“ (Art, Name, Inhalt), z. B. aus „In Datei exportieren“. Vorlagen mit gleicher Art und gleichem Namen werden aktualisiert, neue angelegt. Gelöscht wird nichts.'
      : 'JSON-Datei mit „forms“ (Kürzel, Name, Beschreibung, Kategorie, Definition) und optional „templates“, z. B. aus „In Datei exportieren“ eines anderen Ticketsystems. Formulare mit gleichem Kürzel bekommen eine neue Version, neue werden angelegt. Gelöscht wird nichts.'),
    h('div', { class: 'row' }, h('label', { class: ['btn', 'btn-secondary'], attrs: { for: 'forms-file' } }, icon('file', 16), 'Datei wählen'), fileInput, fileLabel),
    !templatesOnly && can('form.publish', systemId) ? checkbox(publish, 'Direkt veröffentlichen', (v) => { publish = v; void preview(); }, 'Sonst bleiben die neuen Versionen Entwürfe und lassen sich im Editor prüfen.') : null,
    msg, planHost), (close) => [
    button('Abbrechen', () => close(), { kind: 'ghost' }),
    button('Übernehmen', async () => {
      if (!data) { mount(msg, notice('error', 'Bitte zuerst eine Datei wählen.')); return; }
      try {
        await post(`/api/admin/systems/${systemId}/forms/import`, { forms: data.forms, templates: data.templates, publish });
        close();
        toast('Formulare übernommen');
        navigate(curPath(), true);
      } catch (err) { mount(msg, errorBox(err)); }
    }, { kind: 'primary' }),
  ], { wide: true });
}

async function copyDialog(systemId        , f           ) {
  let target = admin.systems.find((s) => s.id !== systemId)?.id ?? '';
  const msg = h('div');
  await dialog(`„${f.name}“ kopieren`, h('div', { class: 'stack' }, msg,
    fieldWrap(select(target, admin.systems.filter((s) => s.id !== systemId).map((s) => ({ value: s.id, label: s.name })), (x) => { target = x; }), { label: 'In Ticketsystem', help: 'Die Kopie wird als Entwurf angelegt. Zammad-Objekte müssen im Ziel-System ebenfalls freigegeben sein.' })),
  (close) => [button('Abbrechen', () => close(), { kind: 'ghost' }), button('Kopieren', async () => {
    try {
      const r = await post                     (`/api/admin/systems/${systemId}/forms/${f.id}/copy`, { targetSystemId: target });
      close();
      toast('Kopie angelegt');
      navigate(`/admin/systeme/${target}/formulare/${r.form.id}`);
    } catch (err) { mount(msg, notice('error', errorText(err))); }
  }, { kind: 'primary' })]);
}

/** Zammad-Felder für die Vorschau auflösen (wie der Server). */
function resolveForPreview(def                , released            )                 {
  const fields              = [];
  for (const f of def.fields) {
    if (f.type !== 'zammad') { fields.push(f); continue; }
    const a = released.find((r) => r.name === f.attribute);
    if (!a || !a.portalType) continue;
    let options = a.options;
    if (options && f.allowedValues?.length) options = options.filter((o) => f.allowedValues .includes(o.value));
    fields.push({ ...f, type: (a.type === 'boolean' ? 'select' : a.portalType)             , options });
  }
  return { ...def, fields };
}

export async function formEditorPage(p                        ) {
  await loadAdminSystems();
  const s = adminSystem(p.systemId);
  const base = `/api/admin/systems/${s.id}/forms/${p.formId}`;
  const [data, metaRes, templates] = await Promise.all([
    get                                                                          (base),
    get                                                                                                            (`/api/admin/systems/${s.id}/metadata`).catch(() => null),
    get                                                                              (`/api/admin/systems/${s.id}/templates`).catch(() => ({ templates: [] })),
  ]);
  // Services des Ticketsystems (für „Betroffene Services“ – nur wenn Störungen oder Wartungen eingeschaltet sind)
  const services = feature('incidents') || feature('maintenance')
    ? (await get                                              (`/api/admin/systems/${s.id}/services`).catch(() => ({ services: [] }))).services : [];
  const released = metaRes?.releasedResolved ?? [];
  const def                 = JSON.parse(JSON.stringify(data.definition));
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

  async function saveDraft()                   {
    try {
      await put(`${base}/draft`, { definition: def });
      dirty = false;
      saveState.textContent = 'Entwurf gespeichert';
      saveState.className = 'save-state';
      mount(msg);
      return true;
    } catch (err) {
      mount(msg, notice('error', err instanceof ApiError && Array.isArray(err.details) ? h('div', null, h('p', null, err.message), h('ul', null, ...(err.details            ).map((d) => h('li', null, d)))) : errorText(err)));
      return false;
    }
  }

  function head()              {
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
            const r = await post                    (`${base}/publish`);
            dirty = false;
            toast(r.status === 'pending' ? 'Zur Freigabe gesendet' : 'Veröffentlicht');
            navigate(curPath(), true);
          } catch (err) { mount(msg, notice('error', errorText(err))); }
        }, { kind: 'primary' }) : null));
  }

  // ------------------------------------------------ Felder
  function fieldList()              {
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
          let f           ;
          if (newType.startsWith('zammad:')) {
            const a = released.find((r) => r.name === newType.slice(7)) ;
            f = { id: slugify(a.display, taken), type: 'zammad', label: a.display, attribute: a.name };
          } else {
            const label = TYPE_LABEL[newType];
            f = { id: slugify(label, taken), type: newType             , label, mapping: { target: 'article' } };
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

  function optionsToText(o                                     ) { return (o ?? []).map((x) => (x.value === x.label ? x.value : `${x.value} = ${x.label}`)).join('\n'); }
  function textToOptions(t        ) {
    return t.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
      const i = l.indexOf('=');
      return i > 0 ? { value: l.slice(0, i).trim(), label: l.slice(i + 1).trim() } : { value: l, label: l };
    });
  }

  /** Weiterleitung je Option: Ticketsystem und Gruppe. Ziel nur, wo man Formulare bearbeiten darf (prüft auch der Server). */
  function routesEditor(f           , m                                   )              {
    const targets = admin.systems.filter((x) => x.id === s.id || can('form.edit', x.id));
    const ownGroups = (metaRes?.metadata.groups ?? []).map((g) => g.name);
    const groupsOf = (id        ) => {
      const t = admin.systems.find((x) => x.id === id || x.slug === id);
      if (!t) return [];
      const list = t.id === s.id ? (t.allowedGroups.length ? t.allowedGroups : ownGroups) : t.allowedGroups;
      return list.map((g) => ({ value: g, label: g }));
    };
    const setRoute = (value        , r                                           ) => {
      const routes = { ...(m.routes ?? {}) };
      if (r) routes[value] = r; else delete routes[value];
      f.mapping = { ...m, routes: Object.keys(routes).length ? routes : undefined };
      markDirty(); draw();
    };
    return h('div', { class: 'stack' },
      h('p', { class: 'small muted' }, `Ohne Ziel bleibt die Anfrage in „${s.name}“. Im anderen System gilt die gewählte Gruppe, sonst dessen Standardgruppe. Zammad-Felder, die dort nicht freigegeben sind, stehen nur im Tickettext.`),
      targets.length < 2 ? notice('warn', 'Es gibt kein weiteres Ticketsystem, für das Sie Formulare bearbeiten dürfen.') : null,
      h('div', { class: 'map-rows' }, ...(f.options ?? []).map((o) => {
        const r = m.routes?.[o.value];
        const known = !r || targets.some((t) => t.id === r.system || t.slug === r.system);
        const groups = r ? groupsOf(r.system) : [];
        const sysId = r ? targets.find((t) => t.id === r.system || t.slug === r.system)?.id ?? r.system : '';
        const defaultGroup = r ? (admin.systems.find((t) => t.id === sysId)?.defaultGroup ?? '–') : '';
        return h('div', { class: 'map-row map-row-route' },
          h('span', { class: 'map-from' }, o.label),
          h('span', { class: 'map-arrow', attrs: { 'aria-hidden': 'true' } }, '→'),
          select(sysId, [...(known ? [] : [{ value: sysId, label: 'Unbekanntes Ticketsystem' }]), ...targets.map((t) => ({ value: t.id, label: t.name }))], (x) => setRoute(o.value, x ? { system: x } : null), { empty: `bleibt in ${s.name}`, ariaLabel: `${o.label}: Ticketsystem` }),
          r ? (groups.length
            ? select(r.group ?? '', groups, (x) => setRoute(o.value, { system: r.system, ...(x ? { group: x } : {}) }), { empty: 'Standardgruppe', ariaLabel: `${o.label}: Gruppe (Standard: ${defaultGroup})` })
            : input(r.group ?? '', (x) => { const routes = { ...(m.routes ?? {}) }; routes[o.value] = { system: r.system, ...(x.trim() ? { group: x.trim() } : {}) }; f.mapping = { ...m, routes }; markDirty(); }, { placeholder: `Standardgruppe (${defaultGroup})`, 'aria-label': `${o.label}: Gruppe`, title: `Leer = Standardgruppe ${defaultGroup}` })) : null);
      })));
  }

  function properties()              {
    const f = def.fields.find((x) => x.id === selected);
    if (!f) return h('div', { class: 'col col-props' }, h('p', { class: 'muted' }, 'Feld links auswählen.'));
    const upd = (fn            , redraw = false) => { fn(); markDirty(); if (redraw) draw(); else drawPreview(); };
    const taken = new Set(def.fields.filter((x) => x !== f).map((x) => x.id));
    const attr = f.type === 'zammad' ? released.find((r) => r.name === f.attribute) : undefined;
    const others = def.fields.filter((x) => x !== f && x.type !== 'info' && x.type !== 'file' && x.type !== 'approver');
    const rule = f.visibleIf;
    const items          = [
      h('h2', null, 'Eigenschaften'),
      fieldWrap(input(f.label, (x) => upd(() => { f.label = x; })), { label: 'Bezeichnung' }),
      f.type !== 'info' && showAdvanced() ? fieldWrap(input(f.id, (x) => upd(() => {
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
        showAdvanced(Boolean(f.approverGroups?.length)) ? fieldWrap(listInput(f.approverGroups ?? [], (x) => upd(() => { f.approverGroups = x.length ? x : undefined; })), {
          label: 'Freigeben dürfen nur Mitglieder dieser Gruppen',
          help: 'Entra-Gruppen (Objekt-IDs) oder App-Rollen (approle:…), z. B. die Gruppe der Führungskräfte. Leer = jedes Microsoft-Konto. Verhindert Freigaben über ein eigenes Zweitkonto.',
        }) : null,
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
        fieldWrap(select(f.defaultFrom ?? '', [{ value: 'user.name', label: 'Name des Benutzers' }, { value: 'user.email', label: 'E-Mail des Benutzers' }, { value: 'user.department', label: 'Abteilung des Benutzers' }], (x) => upd(() => { f.defaultFrom = (x || undefined)                            ; }), { empty: '–' }), { label: 'Vorbelegen mit' })));
    }
    if ((f.type === 'text' || f.type === 'textarea') && showAdvanced(Boolean(f.maxLength || f.pattern))) {
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
          checkbox(!f.allowedValues?.length, 'Alle freigegebenen Werte', (x) => upd(() => { f.allowedValues = x ? undefined : attr.options .map((o) => o.value); }, true)),
          f.allowedValues?.length ? h('div', { class: 'value-grid' }, ...attr.options.map((o) => checkbox(f.allowedValues .includes(o.value), o.label, (x) => upd(() => {
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
          fieldWrap(select(rule.op, [{ value: 'eq', label: 'ist gleich' }, { value: 'neq', label: 'ist nicht' }, { value: 'in', label: 'ist einer von (Komma)' }, { value: 'notEmpty', label: 'ist ausgefüllt' }], (x) => upd(() => { rule.op = x                  ; }, true)), { label: 'Bedingung' }),
          rule.op !== 'notEmpty' ? fieldWrap(input(Array.isArray(rule.value) ? rule.value.join(',') : rule.value ?? '', (x) => upd(() => { rule.value = x; })), { label: 'Wert', help: 'Bei Auswahlfeldern der Optionswert' }) : null) : null));
      if (showAdvanced(Boolean(f.groups?.length))) items.push(h('details', { class: 'more', attrs: { open: Boolean(f.groups?.length) || undefined } }, h('summary', null, 'Nur für bestimmte Gruppen'),
        fieldWrap(listInput(f.groups ?? [], (x) => upd(() => { f.groups = x.length ? x : undefined; })), { label: 'Entra-Gruppen (Objekt-IDs)', help: 'Leer = für alle. Sonst sehen nur Mitglieder dieser Gruppen das Feld.' })));
    }
    if (f.type !== 'info' && f.type !== 'zammad') {
      const m = f.mapping ?? { target: 'article'          };
      const targets = Object.entries(MAP_LABEL).filter(([k]) => (f.type !== 'approver' || k === 'article' || k === 'none')
        && (k !== 'system' || f.type === 'select')
        && (isAdvanced() || SIMPLE_TARGETS.has(k) || k === m.target));
      const setMap = (next          , redraw = false) => upd(() => { f.mapping = next; }, redraw);
      // Werte übersetzen: einfach als Auswahl je Option, erweitert zusätzlich frei als Text
      const perOption = (choices                                    , emptyLabel        ) => h('div', { class: 'map-rows' },
        ...(f.options ?? []).map((o) => h('div', { class: 'map-row' },
          h('span', { class: 'map-from' }, o.label),
          h('span', { class: 'map-arrow', attrs: { 'aria-hidden': 'true' } }, '→'),
          select(m.valueMap?.[o.value] ?? '', choices.some((c) => c.value === m.valueMap?.[o.value]) || !m.valueMap?.[o.value] ? choices : [{ value: m.valueMap[o.value], label: m.valueMap[o.value] }, ...choices], (x) => {
            const map = { ...(m.valueMap ?? {}) };
            if (x) map[o.value] = x; else delete map[o.value];
            setMap({ ...m, valueMap: Object.keys(map).length ? map : undefined });
          }, { empty: emptyLabel, ariaLabel: `${o.label}: Ziel` }))));
      const groupChoices = (metaRes?.metadata.groups ?? []).map((g) => ({ value: g.name, label: g.name }));
      const prioChoices = (metaRes?.metadata.priorities ?? []).map((g) => ({ value: g.name, label: g.name }));
      const valueMapText = () => fieldWrap(textarea(Object.entries(m.valueMap ?? {}).map(([k, v]) => `${k} = ${v}`).join('\n'), (x) => upd(() => {
        const map                         = {};
        x.split('\n').forEach((l) => { const i = l.indexOf('='); if (i > 0) map[l.slice(0, i).trim()] = l.slice(i + 1).trim(); });
        f.mapping = { ...m, valueMap: Object.keys(map).length ? map : undefined };
      }), { rows: 3 }), { label: 'Werte übersetzen', help: m.target === 'group' ? 'z. B. „netzwerk = IT-Support::Netzwerk“' : 'Formularwert = Wert in Zammad' });
      let translate        = null;
      if (f.options?.length && m.target === 'group' && groupChoices.length && !isAdvanced()) translate = fieldWrap(perOption(groupChoices, 'Wert wie er ist'), { label: 'Welche Auswahl kommt in welche Gruppe?' });
      else if (f.options?.length && m.target === 'priority' && prioChoices.length && !isAdvanced()) translate = fieldWrap(perOption(prioChoices, 'Wert wie er ist'), { label: 'Welche Auswahl ergibt welche Priorität?' });
      else if (f.options?.length && ['tag', 'group', 'priority', 'zammad_field'].includes(m.target) && showAdvanced(Boolean(m.valueMap))) translate = valueMapText();
      items.push(h('details', { class: 'more', attrs: { open: m.target !== 'article' || undefined } }, h('summary', null, 'Übernahme ins Ticket'),
        fieldWrap(select(m.target, targets.map(([value, label]) => ({ value, label })), (x) => setMap({ target: x                   , ...(m.name ? { name: m.name } : {}), ...(x === 'system' ? { routes: m.routes } : { valueMap: m.valueMap }) }, true)), { label: 'Verwendung', help: m.target === 'system' ? 'Je nach Auswahl geht die Anfrage an ein anderes Ticketsystem bzw. eine andere Abteilung.' : 'Alle Felder stehen außerdem im Tickettext ({{alle_felder}}), außer „Nicht übernehmen“.' }),
        m.target === 'zammad_field' ? fieldWrap(input(m.name ?? '', (x) => upd(() => { f.mapping = { ...m, name: x }; })), { label: 'Name des Zammad-Feldes' }) : null,
        m.target === 'system' ? routesEditor(f, m) : translate));
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
  function ticketTab()              {
    const st = def.settings;
    const tpl = (kind        , apply                     ) => {
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
      services.length || st.services?.length ? h('div', null,
        h('p', { class: 'label' }, 'Betroffene Services'),
        h('p', { class: 'small muted' }, 'Bei einer Störung oder Wartung dieser Services zeigt das Formular einen Hinweis mit „Ich bin auch betroffen“. Tickets während einer Störung bekommen in Zammad deren Tag (inc-0001).'),
        h('div', { class: 'value-grid' }, ...services.map((sv) => checkbox((st.services ?? []).includes(sv.id), sv.name, (x) => {
          const set = new Set(st.services ?? []);
          x ? set.add(sv.id) : set.delete(sv.id);
          st.services = set.size ? [...set] : undefined;
          markDirty();
        })))) : null,
      fieldWrap(input(st.titleTemplate, (x) => { st.titleTemplate = x; markDirty(); }), { label: 'Ticket-Titel', help: `Platzhalter: ${fieldsHelp}, {{benutzer.name}}, {{benutzer.abteilung}}, {{formular.name}}, {{datum}}` }),
      tpl('title', (c) => { st.titleTemplate = c; }),
      isAdvanced() ? fieldWrap(textarea(st.bodyTemplate, (x) => { st.bodyTemplate = x; markDirty(); }, { rows: 8, class: 'code' }), { label: 'Tickettext (HTML)', help: '{{alle_felder}} fügt eine Tabelle mit allen ausgefüllten Feldern ein. Eingaben der Benutzer werden immer sicher maskiert.' })
        : h('div', { class: 'field' }, h('p', { class: 'label' }, 'Tickettext'), h('p', { class: 'small muted' }, 'Das Ticket enthält alle ausgefüllten Felder als übersichtliche Tabelle. Eigenen Text (HTML) gestalten: Ansicht „Erweitert“ unten links.')),
      isAdvanced() ? tpl('body', (c) => { st.bodyTemplate = c; }) : null,
      fieldWrap(textarea(st.successText ?? '', (x) => { st.successText = x; markDirty(); }, { rows: 3 }), { label: 'Text nach dem Absenden' }),
      tpl('success', (c) => { st.successText = c; }),
    );
    if (!editable) box.querySelectorAll('input,textarea,select,button').forEach((el) => el.setAttribute('disabled', ''));
    return box;
  }

  function generalTab()              {
    // Bei Vier-Augen-Prinzip: vorgemerkte Angaben aus dem Entwurf zeigen
    const staged = latest?.status !== 'published' ? latest?.pendingMeta ?? null : null;
    const m = { ...meta, ...(staged ?? {}) };
    return h('div', { class: 'panel stack' },
      h('h2', null, 'Allgemein'),
      s.requireApproval
        ? notice('info', 'Vier-Augen-Prinzip: Name, Kurzbeschreibung, Sichtbarkeit und „Im Portal anzeigen“ gelten erst, wenn die nächste Version freigegeben ist. Kategorie und Reihenfolge gelten sofort.')
        : notice('info', 'Diese Angaben gelten sofort und sind nicht versioniert.'),
      staged ? notice('warn', 'Geänderte Angaben sind vorgemerkt und gelten mit der Freigabe der nächsten Version.') : null,
      fieldWrap(input(m.name, (x) => { m.name = x; }), { label: 'Name' }),
      fieldWrap(input(m.category, (x) => { m.category = x; }), { label: 'Kategorie' }),
      fieldWrap(textarea(m.description, (x) => { m.description = x; }, { rows: 2 }), { label: 'Kurzbeschreibung' }),
      fieldWrap(listInput(m.visibleGroups, (x) => { m.visibleGroups = x; }, 'Leer = für alle'), { label: 'Sichtbar für Entra-Gruppen' }),
      fieldWrap(input(String(m.sort), (x) => { m.sort = Number(x) || 0; }, { type: 'number' }), { label: 'Reihenfolge' }),
      checkbox(m.active, 'Im Portal anzeigen', (x) => { m.active = x; }),
      h('div', { class: 'row' },
        editable ? button('Speichern', async () => {
          try {
            const r = await put                      (base, m);
            if (r.staged) { toast('Vorgemerkt – gilt nach der Freigabe der nächsten Version'); navigate(curPath(), true); return; }
            Object.assign(meta, m); toast('Gespeichert'); draw();
          } catch (err) { toast(errorText(err), 'error'); }
        }, { kind: 'primary' }) : null,
        can('form.publish', s.id) ? button('Formular löschen', async () => {
          if (!await confirmDialog('Formular löschen?', `„${meta.name}“ und alle Versionen werden gelöscht.`, 'Löschen', true)) return;
          await del(base); dirty = false; toast('Gelöscht'); navigate(`/admin/systeme/${s.id}/formulare`);
        }, { kind: 'danger' }) : null));
  }

  function versionsTab()              {
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
  onModeChange(() => { if (!host.isConnected) return false; draw(); return true; });
  return host;
}
