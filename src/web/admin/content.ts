// Verwaltung: Vorlagen, Übersichten, Farben und Logos.
import { h, icon, mount, fmtDate } from '../lib/dom.ts';
import { fileToBase64, get, post, put, del } from '../lib/api.ts';
import { badge, button, checkbox, confirmDialog, dialog, errorText, fieldWrap, input, notice, pageHead, select, statusBadge, table, textarea, toast } from '../lib/ui.ts';
import { can, navigate, state, curPath, assetUrl, bandLogoId } from '../lib/app.ts';
import { adminSystem, loadAdminSystems } from './common.ts';
import { exportFormsFile, importFormsDialog } from './forms.ts';
import { contrastWarnings, effectiveColors, LOGO_LIMITS, NAV_LINKS_MAX, PALETTES, THEMES, THEME_INFO, themeOf, type Branding, type NavLink, type Palette, type ThemeId } from '../../shared/branding.ts';

const KIND: Record<string, string> = { title: 'Ticket-Titel', body: 'Tickettext', success: 'Text nach dem Absenden' };

export async function templatesPage(p: Record<string, string>) {
  await loadAdminSystems();
  const s = adminSystem(p.systemId);
  const r = await get<{ templates: { id: string; kind: string; name: string; content: string; updatedAt: number }[] }>(`/api/admin/systems/${s.id}/templates`);
  const edit = async (t?: { id: string; kind: string; name: string; content: string }) => {
    const v = { kind: t?.kind ?? 'body', name: t?.name ?? '', content: t?.content ?? '' };
    const msg = h('div');
    await dialog(t ? 'Vorlage bearbeiten' : 'Vorlage anlegen', h('div', { class: 'stack' }, msg,
      fieldWrap(select(v.kind, Object.entries(KIND).map(([value, label]) => ({ value, label })), (x) => { v.kind = x; }), { label: 'Art' }),
      fieldWrap(input(v.name, (x) => { v.name = x; }), { label: 'Name' }),
      fieldWrap(textarea(v.content, (x) => { v.content = x; }, { rows: 10, class: 'code' }), { label: 'Inhalt', help: 'Platzhalter wie {{benutzer.name}}, {{formular.name}}, {{alle_felder}} oder Feld-IDs, z. B. {{beschreibung}}. Keine Skripte, keine Logik.' })),
    (close) => [
      button('Abbrechen', () => close(), { kind: 'ghost' }),
      button('Speichern', async () => {
        try {
          if (t) await put(`/api/admin/systems/${s.id}/templates/${t.id}`, v); else await post(`/api/admin/systems/${s.id}/templates`, v);
          close(); toast('Gespeichert'); navigate(curPath(), true);
        } catch (err) { mount(msg, notice('error', errorText(err))); }
      }, { kind: 'primary' }),
    ], { wide: true });
  };
  return h('div', null,
    pageHead('Vorlagen', 'Textbausteine für Ticket-Titel, Tickettext und Bestätigung, die im Formular-Editor übernommen werden können', [
      button('In Datei exportieren', () => void exportFormsFile(s.id), { icon: 'down' }),
      button('Aus Datei übernehmen …', () => void importFormsDialog(s.id, s.name, true), { icon: 'file' }),
      button('Vorlage anlegen', () => edit(), { kind: 'primary', icon: 'plus' }),
    ]),
    table(r.templates, [
      { label: 'Name', class: 'grow', render: (t) => t.name },
      { label: 'Art', render: (t) => KIND[t.kind] ?? t.kind },
      { label: 'Geändert', render: (t) => fmtDate(t.updatedAt) },
      { label: '', render: (t) => button('Löschen', async () => {
        if (await confirmDialog('Vorlage löschen?', `„${t.name}“ wird gelöscht. Formulare, die sie übernommen haben, bleiben unverändert.`, 'Löschen', true)) {
          await del(`/api/admin/systems/${s.id}/templates/${t.id}`); toast('Gelöscht'); navigate(curPath(), true);
        }
      }, { kind: 'ghost', icon: 'trash' }) },
    ], { onRow: (t) => edit(t), empty: 'Noch keine Vorlagen.' }));
}

const COLS: Record<string, string> = { number: 'Nr.', title: 'Betreff', state: 'Status', priority: 'Priorität', group: 'Bereich', created_at: 'Erstellt', updated_at: 'Zuletzt geändert' };
const FILTER: Record<string, string> = { open: 'Offene Tickets', closed: 'Erledigte Tickets', all: 'Alle Tickets' };

export async function overviewsPage(p: Record<string, string>) {
  await loadAdminSystems();
  const s = adminSystem(p.systemId);
  const r = await get<{ overviews: { id: string; name: string; stateFilter: string; columns: string[]; sortBy: string; sortDir: string; sort: number }[] }>(`/api/admin/systems/${s.id}/overviews`);
  const edit = async (o?: typeof r.overviews[number]) => {
    const v = { name: o?.name ?? '', stateFilter: o?.stateFilter ?? 'open', columns: o?.columns ?? ['number', 'title', 'state', 'updated_at'], sortBy: o?.sortBy ?? 'updated_at', sortDir: o?.sortDir ?? 'desc', sort: o?.sort ?? r.overviews.length };
    const msg = h('div');
    await dialog(o ? 'Übersicht bearbeiten' : 'Übersicht anlegen', h('div', { class: 'stack' }, msg,
      fieldWrap(input(v.name, (x) => { v.name = x; }), { label: 'Name', help: 'Erscheint als Reiter unter „Meine Tickets“.' }),
      fieldWrap(select(v.stateFilter, Object.entries(FILTER).map(([value, label]) => ({ value, label })), (x) => { v.stateFilter = x; }), { label: 'Zeigt' }),
      h('p', { class: 'label' }, 'Spalten'),
      h('div', { class: 'value-grid' }, ...Object.entries(COLS).map(([k, l]) => checkbox(v.columns.includes(k), l, (x) => { v.columns = x ? [...v.columns, k] : v.columns.filter((c) => c !== k); }))),
      h('div', { class: 'grid-2' },
        fieldWrap(select(v.sortBy, Object.entries(COLS).map(([value, label]) => ({ value, label })), (x) => { v.sortBy = x; }), { label: 'Sortieren nach' }),
        fieldWrap(select(v.sortDir, [{ value: 'desc', label: 'Absteigend (neueste zuerst)' }, { value: 'asc', label: 'Aufsteigend' }], (x) => { v.sortDir = x; }), { label: 'Richtung' })),
      fieldWrap(input(String(v.sort), (x) => { v.sort = Number(x) || 0; }, { type: 'number' }), { label: 'Reihenfolge' })),
    (close) => [
      button('Abbrechen', () => close(), { kind: 'ghost' }),
      button('Speichern', async () => {
        const order = Object.keys(COLS);
        const body = { ...v, columns: order.filter((c) => v.columns.includes(c)) };
        try {
          if (o) await put(`/api/admin/systems/${s.id}/overviews/${o.id}`, body); else await post(`/api/admin/systems/${s.id}/overviews`, body);
          close(); toast('Gespeichert'); navigate(curPath(), true);
        } catch (err) { mount(msg, notice('error', errorText(err))); }
      }, { kind: 'primary' }),
    ]);
  };
  return h('div', null,
    pageHead('Übersichten', 'Reiter unter „Meine Tickets“ im Portal', [button('Übersicht anlegen', () => edit(), { kind: 'primary', icon: 'plus' })]),
    table(r.overviews, [
      { label: 'Name', class: 'grow', render: (o) => o.name },
      { label: 'Zeigt', render: (o) => FILTER[o.stateFilter] },
      { label: 'Spalten', render: (o) => o.columns.map((c) => COLS[c] ?? c).join(', ') },
      { label: '', render: (o) => button('Löschen', async () => {
        if (await confirmDialog('Übersicht löschen?', `„${o.name}“ wird gelöscht.`, 'Löschen', true)) { await del(`/api/admin/systems/${s.id}/overviews/${o.id}`); toast('Gelöscht'); navigate(curPath(), true); }
      }, { kind: 'ghost', icon: 'trash' }) },
    ], { onRow: (o) => edit(o), empty: 'Keine Übersichten – das Portal zeigt dann „Offene Tickets“ und „Erledigt“.' }));
}

// ---------------------------------------------------------------- Branding
function colorField(label: string, value: string, onChange: (v: string) => void, help?: string): HTMLElement {
  const picker = h('input', { attrs: { type: 'color', 'aria-label': `${label} auswählen` } });
  picker.value = value;
  const text = input(value, (x) => { if (/^#[0-9a-fA-F]{6}$/.test(x)) { picker.value = x; onChange(x.toLowerCase()); } }, { maxlength: 7, class: 'hex', pattern: '#[0-9a-fA-F]{6}' });
  picker.addEventListener('input', () => { text.value = picker.value; onChange(picker.value); });
  const wrap = fieldWrap(text, { label, help });
  wrap.querySelector('input')!.before(picker);
  wrap.classList.add('color-field');
  return wrap;
}

function logoField(label: string, id: string | null | undefined, kind: 'logo' | 'favicon', uploadUrl: string, onChange: (id: string | null) => void, onBand = false): HTMLElement {
  const preview = h('div', { class: ['logo-preview', onBand && 'on-band'] });
  const draw = (cur: string | null | undefined) => mount(preview, cur ? h('img', { attrs: { src: assetUrl(cur), alt: '' } }) : h('span', { class: 'muted small' }, 'kein Bild'));
  draw(id);
  const fileInput = h('input', { attrs: { type: 'file', accept: kind === 'logo' ? '.png,.jpg,.jpeg,.webp,.svg' : '.png,.ico,.svg', class: 'visually-hidden' } });
  const fid = `up-${label.replace(/\W/g, '')}`;
  fileInput.id = fid;
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    try {
      const r = await post<{ id: string }>(uploadUrl, { kind, data: await fileToBase64(f) });
      draw(r.id); onChange(r.id); toast('Hochgeladen – Entwurf speichern nicht vergessen');
    } catch (err) { toast(errorText(err), 'error'); }
    fileInput.value = '';
  });
  return h('div', { class: 'field' }, h('p', { class: 'label' }, label),
    h('div', { class: 'logo-row' }, preview, fileInput, h('label', { class: ['btn', 'btn-secondary'], attrs: { for: fid } }, 'Datei wählen'),
      button('Entfernen', () => { draw(null); onChange(null); }, { kind: 'ghost' })));
}

/** Schieberegler für eine Logohöhe in Pixeln. */
function sizeField(label: string, value: number, lim: { min: number; max: number; default: number }, onChange: (v: number) => void): HTMLElement {
  const out = h('span', { class: 'size-value' }, `${value} px`);
  const range = h('input', { attrs: { type: 'range', min: lim.min, max: lim.max, step: 1, value, 'aria-label': label } });
  range.addEventListener('input', () => { out.textContent = `${range.value} px`; onChange(Number(range.value)); });
  const reset = h('button', { class: 'link-btn', attrs: { type: 'button' }, on: { click: () => { range.value = String(lim.default); out.textContent = `${lim.default} px`; onChange(lim.default); } } }, 'Standard');
  return h('div', { class: 'field' }, h('p', { class: 'label' }, label), h('div', { class: 'size-row' }, range, out, reset));
}

/** Liste zusätzlicher Links für die Navigationsleiste. */
function linksField(initial: NavLink[], onChange: (v: NavLink[]) => void): HTMLElement {
  const links = initial.map((l) => ({ ...l }));
  const host = h('div', { class: 'stack' });
  const draw = () => {
    mount(host,
      ...links.map((l, i) => h('div', { class: 'link-row' },
        input(l.label, (v) => { l.label = v; onChange(links); }, { placeholder: 'Bezeichnung, z. B. Intranet', maxlength: 40, 'aria-label': `Link ${i + 1}: Bezeichnung` }),
        input(l.url, (v) => { l.url = v.trim(); onChange(links); }, { placeholder: 'https://…', maxlength: 500, 'aria-label': `Link ${i + 1}: Adresse` }),
        h('button', { class: 'icon-btn', attrs: { type: 'button', 'aria-label': `Link ${i + 1} entfernen` }, on: { click: () => { links.splice(i, 1); onChange(links); draw(); } } }, icon('x', 16)))),
      links.length < NAV_LINKS_MAX ? button('Link hinzufügen', () => { links.push({ label: '', url: 'https://' }); onChange(links); draw(); }, { icon: 'plus', kind: 'ghost' }) : null);
  };
  draw();
  return h('div', { class: 'field' }, h('p', { class: 'label' }, 'Links in der Navigationsleiste'),
    h('p', { class: 'help', style: { marginTop: '0' } }, `Bis zu ${NAV_LINKS_MAX} Links, z. B. Intranet, Wissensdatenbank oder Telefonliste. Web-Links öffnen in einem neuen Tab. Erlaubt: https://, http://, mailto:, tel:`),
    host);
}

function setColors(el: HTMLElement, c: Palette): void {
  el.style.setProperty('--brand', c.primaryColor);
  el.style.setProperty('--band', c.headerColor);
  el.style.setProperty('--band-text', c.headerTextColor);
  el.style.setProperty('--brand-accent', c.accentColor);
}

/** Kleine Vorschau eines Stils (Farbfläche, Zeile, Schaltfläche) – wird mit dem Stil selbst gezeichnet. */
function themeMini(id: ThemeId, title: string): HTMLElement {
  return h('div', { class: 'theme-mini', attrs: { 'data-style': id, 'aria-hidden': 'true' } },
    h('div', { class: 'tm-hero' }, h('span', { class: 'tm-title' }, title)),
    h('div', { class: 'tm-card' }, h('span', { class: 'tm-dot' }), h('span', { class: 'tm-line' })),
    h('div', { class: 'tm-card' }, h('span', { class: 'tm-dot' }), h('span', { class: 'tm-line' })),
    h('span', { class: 'tm-btn' }));
}

export function brandingEditor(initial: Branding, uploadUrl: string, extra: { onChange?: () => void } = {}): { el: HTMLElement; value: Branding } {
  const b: Branding = { theme: 'standard', colorMode: 'custom', ...initial };
  const warn = h('div', { attrs: { 'aria-live': 'polite' } });
  const preview = h('div', { class: 'brand-preview', attrs: { 'aria-label': 'Vorschau' } });
  const minis = new Map<ThemeId, HTMLElement>();
  const colorsHost = h('div', { class: 'stack' });
  let gridEl: HTMLElement | null = null;
  const draw = () => {
    const ws = contrastWarnings(b);
    mount(warn, ws.length ? notice('warn', h('ul', null, ...ws.map((w) => h('li', null, w)))) : notice('ok', 'Kontraste erfüllen WCAG AA.'));
    const c = effectiveColors(b);
    gridEl?.style.setProperty('--band-preview', c.headerColor);
    preview.setAttribute('data-style', themeOf(b));
    setColors(preview, c);
    for (const [id, mini] of minis) setColors(mini, b.colorMode === 'theme' ? THEME_INFO[id].palette : c);
    mount(preview,
      h('div', { class: 'bp-nav' }, b.logoLightId ? h('img', { attrs: { src: assetUrl(b.logoLightId), alt: '' }, style: { height: `${Math.round((b.logoNavHeight ?? LOGO_LIMITS.nav.default) * 0.8)}px`, maxWidth: '70%' } }) : h('span', { class: 'brand-mark' }, (b.displayName || '?').slice(0, 1)), b.logoLightId ? null : h('span', null, b.displayName || 'Name'),
        (b.navLinks ?? []).length ? h('span', { class: 'bp-links' }, ...(b.navLinks ?? []).map((l) => h('span', null, l.label || '…'))) : null),
      h('div', { class: 'bp-hero' },
        bandLogoId(b) ? h('img', { attrs: { src: assetUrl(bandLogoId(b)!), alt: '' }, style: { height: `${Math.round((b.logoHeroHeight ?? LOGO_LIMITS.hero.default) * 0.64)}px`, maxWidth: '85%' } }) : null,
        h('p', { class: 'bp-title' }, b.welcomeText || 'Wie können wir helfen?')),
      h('div', { class: 'bp-body' },
        h('div', { class: 'bp-row' }, h('span', { class: 'form-icon' }, icon('bolt', 18)), h('span', null, 'Störung melden'), icon('next', 16)),
        h('div', { class: 'bp-row' }, h('span', { class: 'form-icon' }, icon('laptop', 18)), h('span', null, 'Hardware anfordern'), icon('next', 16)),
        h('p', { class: 'bp-actions' }, h('span', { class: ['btn', 'btn-primary'] }, 'Anfrage senden'), h('span', { class: ['btn', 'btn-secondary'] }, 'Abbrechen'), h('span', { class: 'bp-link' }, 'Ein Link'), badge('Akzent', 'info'))),
      b.footerText ? h('div', { class: 'bp-foot' }, b.footerText) : null);
    extra.onChange?.();
  };
  const set = <K extends keyof Branding>(k: K) => (v: Branding[K]) => { b[k] = v; draw(); };

  // Stil
  const radioName = `theme-${Math.random().toString(36).slice(2, 8)}`;
  const picker = h('fieldset', { class: 'theme-picker' },
    h('legend', { class: 'visually-hidden' }, 'Gestaltungsstil'),
    ...THEMES.map((id) => {
      const info = THEME_INFO[id];
      const radio = h('input', { attrs: { type: 'radio', name: radioName, value: id } }) as HTMLInputElement;
      radio.checked = themeOf(b) === id;
      radio.addEventListener('change', () => { if (radio.checked) { b.theme = id; drawColors(); draw(); } });
      const mini = themeMini(id, info.name);
      minis.set(id, mini);
      return h('label', { class: 'theme-option' }, radio, mini, h('span', { class: 'theme-option-name' }, info.name), h('span', { class: 'theme-option-desc' }, info.description));
    }));

  // Farben: die des Stils oder eigene (mit fertigen Kombinationen)
  const swatch = (p: Palette) => h('span', { class: 'palette-swatch', attrs: { 'aria-hidden': 'true' } },
    h('span', { style: { background: p.headerColor } }), h('span', { style: { background: p.primaryColor } }), h('span', { style: { background: p.accentColor } }));
  const applyPalette = (p: Palette) => { Object.assign(b, p); drawColors(); draw(); };
  function drawColors(): void {
    const mode = b.colorMode === 'theme' ? 'theme' : 'custom';
    const themePalette = THEME_INFO[themeOf(b)].palette;
    mount(colorsHost,
      h('div', { class: 'color-mode' },
        select(mode, [
          { value: 'theme', label: `Farben des Stils „${THEME_INFO[themeOf(b)].name}“ verwenden` },
          { value: 'custom', label: 'Eigene Farben' },
        ], (v) => { b.colorMode = v as 'theme' | 'custom'; drawColors(); draw(); })),
      mode === 'custom' ? h('div', { class: 'stack' },
        h('div', null,
          h('p', { class: 'label' }, 'Fertige Farbkombinationen'),
          h('div', { class: 'palette-row' },
            h('button', { class: 'palette-chip', attrs: { type: 'button' }, on: { click: () => applyPalette(themePalette) } }, swatch(themePalette), `Wie „${THEME_INFO[themeOf(b)].name}“`),
            ...PALETTES.map((p) => h('button', { class: 'palette-chip', attrs: { type: 'button' }, on: { click: () => applyPalette(p.palette) } }, swatch(p.palette), p.name)))),
        h('div', { class: 'grid-2' },
          colorField('Farbfläche', b.headerColor, set('headerColor'), 'Große Fläche auf Start- und Anmeldeseite'),
          colorField('Schrift auf der Farbfläche', b.headerTextColor, set('headerTextColor')),
          colorField('Primärfarbe', b.primaryColor, set('primaryColor'), 'Schaltflächen, Links, Symbole'),
          colorField('Akzentfarbe', b.accentColor, set('accentColor'), 'Markierungen'),
        )) : h('p', { class: 'help' }, 'Der Stil bringt eigene, aufeinander abgestimmte Farben mit. Für eigene Farben „Eigene Farben“ wählen – die bisherigen bleiben gespeichert.'));
  }
  drawColors();

  const el = h('div', { class: 'branding-grid' },
    h('div', { class: 'stack' },
      fieldWrap(input(b.displayName, set('displayName')), { label: 'Anzeigename', help: 'Steht in der Navigationsleiste, wenn kein helles Logo hinterlegt ist, und im Browser-Tab.' }),
      h('div', null, h('p', { class: 'label' }, 'Stil'), h('p', { class: 'help', style: { marginTop: '0', marginBottom: '.6rem' } }, 'Gilt im Portal, solange dieses Ticketsystem gewählt ist (die Anmeldeseite hat ihre eigene Einstellung). Helles und dunkles Design werden automatisch unterstützt.'), picker),
      h('div', null, h('p', { class: 'label' }, 'Farben'), colorsHost),
      logoField('Logo auf der Farbfläche', b.logoDarkId, 'logo', uploadUrl, set('logoDarkId'), true),
      logoField('Logo für die Navigationsleiste (helle Fläche, optional)', b.logoLightId, 'logo', uploadUrl, set('logoLightId')),
      logoField('Favicon', b.faviconId, 'favicon', uploadUrl, set('faviconId')),
      h('div', { class: 'stack' },
        sizeField('Logogröße in der Navigationsleiste', b.logoNavHeight ?? LOGO_LIMITS.nav.default, LOGO_LIMITS.nav, (v) => { b.logoNavHeight = v; draw(); }),
        sizeField('Logogröße auf der Farbfläche', b.logoHeroHeight ?? LOGO_LIMITS.hero.default, LOGO_LIMITS.hero, (v) => { b.logoHeroHeight = v; draw(); })),
      linksField(b.navLinks ?? [], (v) => { b.navLinks = v; draw(); }),
      fieldWrap(input(b.welcomeText, set('welcomeText')), { label: 'Begrüßung auf der Startseite' }),
      fieldWrap(textarea(b.footerText, set('footerText'), { rows: 2 }), { label: 'Fußzeile' }),
      h('div', { class: 'grid-2' },
        fieldWrap(input(b.imprintUrl ?? '', set('imprintUrl'), { type: 'url', placeholder: 'https://' }), { label: 'Link Impressum' }),
        fieldWrap(input(b.privacyUrl ?? '', set('privacyUrl'), { type: 'url', placeholder: 'https://' }), { label: 'Link Datenschutz' })),
    ),
    h('div', { class: 'stack sticky-top' }, h('p', { class: 'label' }, 'Vorschau'), preview, warn),
  );
  gridEl = el;
  draw();
  return { el, value: b };
}

export async function brandingPage(p: Record<string, string>) {
  await loadAdminSystems();
  const s = adminSystem(p.systemId);
  const d = await get<{ published: Branding; latest: { id: string; version: number; status: string; branding: Branding; createdBy: string | null; submittedBy: string | null } | null; versions: { id: string; version: number; status: string; createdAt: number }[] }>(`/api/admin/systems/${s.id}/branding`);
  const editor = brandingEditor(d.latest?.branding ?? d.published, `/api/admin/systems/${s.id}/assets`);
  const pending = d.latest?.status === 'pending' ? d.latest : null;
  const msg = h('div');
  const mayApprove = pending && can('form.approve', s.id) && pending.submittedBy !== state.me?.user.id && pending.createdBy !== state.me?.user.id;
  return h('div', null,
    pageHead('Stil, Farben und Logo', `Erscheinungsbild von ${s.name} – so erkennen die Mitarbeitenden, wohin ihre Anfrage geht`),
    msg,
    pending ? notice('warn', h('span', null, `Version ${pending.version} wartet auf Freigabe.`,
      mayApprove ? h('span', { class: 'row inline' },
        button('Freigeben', async () => { await post(`/api/admin/systems/${s.id}/branding/versions/${pending.id}/approve`); toast('Freigegeben'); navigate(curPath(), true); }, { kind: 'primary' }),
        button('Ablehnen', async () => { await post(`/api/admin/systems/${s.id}/branding/versions/${pending.id}/reject`); toast('Abgelehnt'); navigate(curPath(), true); }, { kind: 'ghost' })) : null)) : null,
    h('section', { class: 'panel' }, editor.el),
    can('branding.edit', s.id) && !pending ? h('div', { class: 'form-actions sticky' },
      button('Entwurf speichern', async () => {
        try { await put(`/api/admin/systems/${s.id}/branding/draft`, { branding: editor.value }); toast('Entwurf gespeichert'); } catch (err) { mount(msg, notice('error', errorText(err))); }
      }),
      button(s.requireApproval ? 'Zur Freigabe senden' : 'Veröffentlichen', async () => {
        try {
          await put(`/api/admin/systems/${s.id}/branding/draft`, { branding: editor.value });
          const r = await post<{ status: string }>(`/api/admin/systems/${s.id}/branding/publish`);
          toast(r.status === 'pending' ? 'Zur Freigabe gesendet' : 'Veröffentlicht');
          navigate(curPath(), true);
        } catch (err) { mount(msg, notice('error', errorText(err))); }
      }, { kind: 'primary' })) : null,
    h('details', { class: 'panel' }, h('summary', null, 'Versionen'), table(d.versions, [
      { label: 'Version', render: (v) => String(v.version) }, { label: 'Status', render: (v) => statusBadge(v.status) }, { label: 'Datum', render: (v) => fmtDate(v.createdAt) },
    ])),
  );
}

export async function loginSettingsPage() {
  const d = await get<{ branding: Branding }>('/api/admin/settings/branding');
  const editor = brandingEditor(d.branding, '/api/admin/assets');
  const msg = h('div');
  return h('div', null,
    pageHead('Anmeldeseite', 'Erscheinungsbild vor der Anmeldung, wenn noch kein Ticketsystem gewählt ist'),
    msg,
    h('section', { class: 'panel' }, editor.el),
    h('div', { class: 'form-actions sticky' }, button('Speichern', async () => {
      try { await put('/api/admin/settings/branding', { branding: editor.value }); toast('Gespeichert'); } catch (err) { mount(msg, notice('error', errorText(err))); }
    }, { kind: 'primary' })));
}
