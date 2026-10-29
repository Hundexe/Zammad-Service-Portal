// Verwaltung: Ticketsysteme (Verbindung, Verhalten) und Freigabe von Zammad-Objekten.
import { h, mount, relTime, type Child } from '../lib/dom.ts';
import { get, post, put, del } from '../lib/api.ts';
import { badge, button, checkbox, confirmDialog, dialog, errorText, fieldWrap, input, listInput, notice, pageHead, select, statusBadge, table, toast, emptyState } from '../lib/ui.ts';
import { can, link, navigate } from '../lib/app.ts';
import { admin, adminSystem, loadAdminSystems, type AdminSystem } from './common.ts';

interface Meta {
  groups: { id: number; name: string }[];
  states: { id: number; name: string }[];
  priorities: { id: number; name: string }[];
  fields: { name: string; display: string; type: string; options?: { value: string; label: string }[]; portalType: string | null }[];
}

export async function systemsListPage() {
  await loadAdminSystems(true);
  return h('div', null,
    pageHead('Ticketsysteme', 'Zammad-Instanzen, an die das Portal Anfragen schickt', admin.canCreate ? [button('Ticketsystem hinzufügen', () => void createSystemDialog(), { kind: 'primary', icon: 'plus' })] : []),
    table(admin.systems, [
      { label: 'Name', class: 'grow', render: (s) => link(`/admin/systeme/${s.id}`, s.name) },
      { label: 'Kürzel', render: (s) => s.slug },
      { label: 'Adresse', render: (s) => h('span', { class: 'mono-ish' }, s.baseUrl) },
      { label: 'Status', render: (s) => statusBadge(s.status) },
    ], { onRow: (s) => navigate(`/admin/systeme/${s.id}`), empty: 'Noch kein Ticketsystem angelegt.' }),
  );
}

async function createSystemDialog() {
  const v = { name: '', slug: '', baseUrl: 'https://', apiToken: '', defaultGroup: 'Users' };
  const msg = h('div');
  await dialog('Ticketsystem hinzufügen', h('form', { class: 'stack', on: { submit: (e) => e.preventDefault() } },
    msg,
    fieldWrap(input('', (x) => { v.name = x; }, { required: true, placeholder: 'Zentrale IT' }), { label: 'Name', help: 'So sehen es die Mitarbeitenden.' }),
    fieldWrap(input('', (x) => { v.slug = x; }, { required: true, placeholder: 'zentrale-it', pattern: '[a-z0-9-]+' }), { label: 'Kürzel', help: 'Kleinbuchstaben, Ziffern, Bindestrich. Wird intern verwendet.' }),
    fieldWrap(input(v.baseUrl, (x) => { v.baseUrl = x; }, { type: 'url', required: true }), { label: 'Zammad-Adresse', help: 'z. B. https://zammad.firma.intern' }),
    fieldWrap(input('', (x) => { v.apiToken = x; }, { type: 'password', required: true, autocomplete: 'off' }), { label: 'API-Token', help: 'Token eines eigenen Zammad-Benutzers für das Portal (Profil → Token-Zugriff). Rechte siehe Installationsanleitung.' }),
    fieldWrap(input(v.defaultGroup, (x) => { v.defaultGroup = x; }), { label: 'Standard-Gruppe', help: 'Zammad-Gruppe für Tickets, wenn das Formular keine vorgibt.' }),
  ), (close) => [
    button('Abbrechen', () => close(), { kind: 'ghost' }),
    button('Anlegen', async () => {
      try {
        const r = await post<{ system: AdminSystem }>('/api/admin/systems', v);
        close();
        toast('Ticketsystem angelegt');
        await loadAdminSystems(true);
        navigate(`/admin/systeme/${r.system.id}`);
      } catch (err) { mount(msg, notice('error', errorText(err))); }
    }, { kind: 'primary' }),
  ]);
}

interface MetaState { fetchedAt: number | null; lastError: string | null }

/** Hinweis, wenn die Angaben aus Zammad nicht aktuell sind (Zammad nicht erreichbar). */
function staleNotice(state: MetaState | undefined): HTMLElement | null {
  if (!state?.lastError) return null;
  return notice('warn', `Zammad ist gerade nicht erreichbar (${state.lastError}). Angezeigt wird der letzte Stand${state.fetchedAt ? ` von ${relTime(state.fetchedAt)}` : ''}.`);
}

export async function systemEditPage(p: Record<string, string>) {
  await loadAdminSystems();
  const s = adminSystem(p.systemId);
  // Gruppen aus Zammad nur für die Auswahlliste – die Seite wartet höchstens kurz darauf (Zammad kann fehlen)
  const metaRes = await Promise.race([
    get<{ metadata: Meta; state?: MetaState }>(`/api/admin/systems/${s.id}/metadata`).catch(() => null),
    new Promise<null>((r) => setTimeout(() => r(null), 4000)),
  ]);
  const meta = metaRes?.metadata ?? null;
  const v = { ...s, apiToken: '' } as AdminSystem & { apiToken: string };
  const testResult = h('div', { attrs: { 'aria-live': 'polite' } });
  const msg = h('div');
  const groupOptions = (meta?.groups ?? []).map((g) => ({ value: g.name, label: g.name }));
  if (v.defaultGroup && !groupOptions.some((o) => o.value === v.defaultGroup)) groupOptions.unshift({ value: v.defaultGroup, label: `${v.defaultGroup} (nicht in Zammad gefunden)` });

  return h('div', null,
    pageHead(s.name, h('span', null, 'Verbindung und Verhalten ', statusBadge(s.status))),
    metaRes ? staleNotice(metaRes.state) : notice('warn', 'Zammad antwortet gerade nicht – die Liste der Gruppen fehlt. Speichern und „Verbindung testen“ funktionieren trotzdem.'),
    msg,
    h('section', { class: 'panel' },
      h('h2', null, 'Verbindung zu Zammad'),
      h('div', { class: 'grid-2' },
        fieldWrap(input(v.name, (x) => { v.name = x; }), { label: 'Name' }),
        fieldWrap(input(v.baseUrl, (x) => { v.baseUrl = x; }, { type: 'url' }), { label: 'Zammad-Adresse' }),
        fieldWrap(input('', (x) => { v.apiToken = x; }, { type: 'password', autocomplete: 'off', placeholder: s.hasToken ? '•••••••• (gespeichert)' : '' }), { label: 'API-Token', help: 'Leer lassen, um das gespeicherte Token zu behalten. Es wird verschlüsselt gespeichert und nie wieder angezeigt.' }),
        fieldWrap(select(v.creationMode, [
          { value: 'on_behalf_of', label: 'Im Namen des Kunden (X-On-Behalf-Of, empfohlen)' },
          { value: 'customer_field', label: 'Als Portal-Benutzer mit Kundenfeld' },
        ], (x) => { v.creationMode = x as AdminSystem['creationMode']; }), { label: 'Tickets anlegen', help: '„Im Namen des Kunden“: Zammad prüft selbst, welche Tickets ein Kunde sehen darf.' }),
      ),
      h('div', { class: 'row' }, button('Verbindung testen', async () => {
        mount(testResult, h('span', { class: 'muted' }, 'Teste …'));
        const r = await post<{ ok: boolean; user?: string; version?: string; error?: string }>(`/api/admin/systems/${s.id}/test`);
        mount(testResult, r.ok ? notice('ok', `Verbunden als ${r.user}${r.version ? `, Zammad ${r.version}` : ''}.`) : notice('error', r.error ?? 'Fehlgeschlagen'));
      }), testResult),
    ),
    h('section', { class: 'panel' },
      h('h2', null, 'Tickets und Sichtbarkeit'),
      h('div', { class: 'grid-2' },
        fieldWrap(groupOptions.length ? select(v.defaultGroup ?? '', groupOptions, (x) => { v.defaultGroup = x; }, { empty: '–' }) : input(v.defaultGroup ?? '', (x) => { v.defaultGroup = x; }), { label: 'Standard-Gruppe in Zammad' }),
        fieldWrap(input(v.portalTag, (x) => { v.portalTag = x; }), { label: 'Tag für Portal-Tickets', help: 'Jedes Ticket aus dem Portal bekommt diesen Tag. Damit können Zammad-Trigger z. B. die Eingangsbestätigung schicken.' }),
        fieldWrap(select(v.status, [{ value: 'active', label: 'Aktiv' }, { value: 'maintenance', label: 'Wartung (Anfragen werden gesammelt)' }, { value: 'inactive', label: 'Deaktiviert (nicht sichtbar)' }], (x) => { v.status = x as AdminSystem['status']; }), { label: 'Status' }),
        fieldWrap(input(String(v.sort), (x) => { v.sort = Number(x) || 0; }, { type: 'number' }), { label: 'Reihenfolge' }),
        fieldWrap(listInput(v.visibleGroups, (x) => { v.visibleGroups = x; }, 'Leer = für alle'), { label: 'Sichtbar für Entra-Gruppen', help: 'Objekt-IDs der Gruppen, eine pro Zeile. Leer = alle angemeldeten Benutzer.' }),
        fieldWrap(listInput(v.closedStates, (x) => { v.closedStates = x; }), { label: 'Zammad-Status, die als „erledigt“ gelten' }),
        fieldWrap(listInput(v.allowedGroups, (x) => { v.allowedGroups = x; }, groupOptions.length ? groupOptions.slice(0, 3).map((o) => o.value).join('\n') : 'IT-Support'), {
          label: 'Erlaubte Zammad-Gruppen',
          help: 'Nur in diese Gruppen darf das Portal Tickets legen – Formulare mit anderen Gruppen lassen sich nicht speichern. Eine pro Zeile. Leer = keine Einschränkung (nicht empfohlen).',
        }),
      ),
      !v.allowedGroups.length ? notice('warn', 'Es sind keine erlaubten Gruppen festgelegt. Ein Formular könnte Tickets in jede Gruppe legen, die der API-Benutzer sieht.') : null,
      checkbox(v.allowReplies, 'Antworten über das Portal erlauben', (x) => { v.allowReplies = x; }),
      checkbox(v.showOrgTickets, 'Tickets der eigenen Organisation anzeigen (nicht nur eigene)', (x) => { v.showOrgTickets = x; }),
      checkbox(v.hideAgentNames, `Namen der Bearbeiter ausblenden (Antworten erscheinen als „${s.name}“)`, (x) => { v.hideAgentNames = x; }),
      checkbox(v.requireApproval, 'Vier-Augen-Prinzip: Formulare und Branding erst nach Freigabe durch eine zweite Person veröffentlichen', (x) => { v.requireApproval = x; }),
    ),
    h('div', { class: 'form-actions sticky' },
      button('Speichern', async () => {
        try {
          await put(`/api/admin/systems/${s.id}`, v);
          toast('Gespeichert');
          await loadAdminSystems(true);
        } catch (err) { mount(msg, notice('error', errorText(err))); window.scrollTo({ top: 0 }); }
      }, { kind: 'primary' }),
      can('system.manage') ? button('Ticketsystem löschen', async () => {
        if (!await confirmDialog('Ticketsystem löschen?', `„${s.name}“ mit allen Formularen, Vorlagen und dem Branding wird gelöscht. Tickets in Zammad bleiben erhalten.`, 'Endgültig löschen', true)) return;
        try { await del(`/api/admin/systems/${s.id}`); toast('Gelöscht'); admin.systemId = null; await loadAdminSystems(true); navigate('/admin/systeme'); } catch (err) { mount(msg, notice('error', errorText(err))); }
      }, { kind: 'danger' }) : null,
    ),
  );
}

export async function objectsPage(p: Record<string, string>) {
  await loadAdminSystems();
  const s = adminSystem(p.systemId);
  const host = h('div');
  const draw = async (refresh = false) => {
    let meta: Meta;
    let state: MetaState | undefined;
    try {
      const r = await get<{ metadata: Meta; state?: MetaState }>(`/api/admin/systems/${s.id}/metadata${refresh ? '?refresh=1' : ''}`);
      meta = r.metadata;
      state = r.state;
    } catch (err) {
      mount(host, pageHead('Zammad-Objekte'), notice('error', errorText(err)));
      return;
    }
    const current = new Map((admin.systems.find((x) => x.id === s.id)?.releasedAttributes ?? []).map((a) => [a.name, a.allowedValues]));
    const release = new Map(current);
    const rows: Child[] = meta.fields.map((f) => {
      const enabled = release.has(f.name);
      const valuesHost = h('div', { class: 'values' });
      const drawValues = () => {
        if (!release.has(f.name) || !f.options?.length) { mount(valuesHost); return; }
        const allowed = release.get(f.name);
        mount(valuesHost,
          checkbox(allowed === null || allowed === undefined, 'Alle Werte freigeben (auch künftige)', (x) => { release.set(f.name, x ? null : f.options!.map((o) => o.value)); drawValues(); }),
          allowed ? h('div', { class: 'value-grid' }, ...f.options.map((o) => checkbox(allowed.includes(o.value), o.label, (x) => {
            const list = new Set(release.get(f.name) ?? []);
            x ? list.add(o.value) : list.delete(o.value);
            release.set(f.name, [...list]);
          }))) : null);
      };
      drawValues();
      return h('div', { class: ['attr', !f.portalType && 'attr-off'] },
        h('div', { class: 'attr-head' },
          f.portalType ? checkbox(enabled, f.display, (x) => { x ? release.set(f.name, current.get(f.name) ?? null) : release.delete(f.name); drawValues(); }) : h('span', null, f.display),
          h('span', { class: 'muted small' }, `${f.name}, ${f.type}`),
          !f.portalType ? badge('wird nicht unterstützt') : f.options ? badge(`${f.options.length} Werte`) : null),
        valuesHost);
    });
    mount(host,
      pageHead('Zammad-Objekte', `Ticket-Attribute aus dem Objekt-Manager von ${s.name}, die im Portal auswählbar sind`, [button('Aus Zammad neu laden', () => draw(true), { icon: 'refresh', kind: 'ghost' })]),
      staleNotice(state),
      notice('info', 'Freigegebene Attribute können Sie in Formularen als Feld „Zammad-Objekt“ verwenden. Die Optionen kommen live aus Zammad; Sie bestimmen hier, welche Werte die Mitarbeitenden auswählen dürfen.'),
      meta.fields.length ? h('div', { class: 'attr-list' }, ...rows) : emptyState('Keine Ticket-Attribute gefunden', 'Der API-Benutzer braucht in Zammad das Recht „admin.object“, damit das Portal die Attribute lesen kann.'),
      h('div', { class: 'form-actions sticky' }, button('Freigabe speichern', async () => {
        try {
          await put(`/api/admin/systems/${s.id}/release`, { release: [...release.entries()].map(([name, allowedValues]) => ({ name, allowedValues })) });
          toast('Freigabe gespeichert');
          await loadAdminSystems(true);
        } catch (err) { toast(errorText(err), 'error'); }
      }, { kind: 'primary' })),
    );
  };
  await draw();
  return host;
}
