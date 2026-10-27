// Portal für Mitarbeitende: Startseite, Formular, Tickets, Ticketverlauf, Anfragen, Konto.
import { h, icon, mount, fmtDate, relTime, type Child } from '../lib/dom.ts';
import { ApiError, fileToBase64, get, post } from '../lib/api.ts';
import { button, emptyState, errorText, notice, pageHead, statusBadge, tabs, textarea, ticketState, toast, table, fieldWrap } from '../lib/ui.ts';
import { currentSystem, link, loadMe, loadSystems, navigate, selectSystem, state, systemSwitch, assetUrl, curPath, setUrl } from '../lib/app.ts';
import { renderForm } from '../lib/formrender.ts';
import type { FormDefinition } from '../../shared/form.ts';
import { passwordForm, totpSetupBlock } from './login.ts';

interface FormListItem { id: string; slug: string; name: string; description: string; category: string }
interface Ticket { id: number; number: string; title: string; state: string; closed: boolean; priority: string | null; group: string | null; createdAt: string; updatedAt: string }
interface Overview { id: string; name: string; stateFilter: string; columns: string[] }
interface PendingRequest { id: string; title: string; status: string; created_at: number }

async function systemOrDefault(systemId?: string) {
  if (!state.systems.length) await loadSystems();
  if (systemId && state.systems.some((s) => s.id === systemId)) selectSystem(systemId);
  else if (state.systemId) selectSystem(state.systemId);
  return currentSystem();
}

function noSystems() {
  return h('div', { class: 'container' }, emptyState('Kein Ticketsystem verfügbar', 'Für Ihr Konto ist noch kein Ticketsystem freigeschaltet. Bitte wenden Sie sich an die IT.'));
}

/** Passendes Symbol für ein Formular, abgeleitet aus Name, Beschreibung und Kategorie. */
const FORM_ICONS: [RegExp, string][] = [
  [/drucker|druck|scanner|print/i, 'printer'],
  [/vpn|zugang|zugriff|netz|wlan|remote/i, 'key'],
  [/berechtigung|rechte|freigabe|rolle/i, 'shield'],
  [/passwort|kennwort|konto|account|anmeld/i, 'lock'],
  [/störung|fehler|problem|defekt|funktioniert nicht|ausfall/i, 'bolt'],
  [/software|programm|lizenz|app\b|installier/i, 'apps'],
  [/hardware|laptop|notebook|monitor|rechner|pc\b|maus|tastatur|zubehör/i, 'laptop'],
  [/telefon|handy|smartphone|mobil/i, 'phone'],
  [/mail|postfach|verteiler/i, 'mail'],
  [/mitarbeit|eintritt|austritt|onboarding|benutzer/i, 'person'],
];
function formIcon(f: FormListItem): string {
  // Name und Kategorie zählen mehr als die Beschreibung („Störung melden … Drucker“ ist eine Störung)
  for (const text of [f.name, f.category, f.description]) {
    const hit = FORM_ICONS.find(([re]) => re.test(text ?? ''));
    if (hit) return hit[1];
  }
  return 'chat';
}

export async function homePage(p: Record<string, string>) {
  const sys = await systemOrDefault(p.systemId);
  if (!sys) return noSystems();
  const [forms, tickets] = await Promise.all([
    get<{ forms: FormListItem[] }>(`/api/portal/systems/${sys.id}/forms`),
    get<{ tickets: Ticket[]; pending: PendingRequest[]; unavailable: boolean }>(`/api/portal/systems/${sys.id}/tickets`).catch(() => null),
  ]);
  let filter = '';
  const listHost = h('div');
  const drawList = () => {
    const q = filter.trim().toLowerCase();
    const shown = forms.forms.filter((f) => !q || `${f.name} ${f.description} ${f.category}`.toLowerCase().includes(q));
    if (!shown.length) { mount(listHost, emptyState(q ? 'Nichts gefunden' : 'Noch keine Formulare', q ? 'Versuchen Sie einen anderen Begriff.' : 'Für dieses Ticketsystem wurden noch keine Formulare veröffentlicht.')); return; }
    const groups = new Map<string, FormListItem[]>();
    for (const f of shown) groups.set(f.category || '', [...(groups.get(f.category || '') ?? []), f]);
    mount(listHost, ...[...groups.entries()].map(([cat, items]) => h('section', { class: 'form-group' },
      cat ? h('h2', { class: 'group-title' }, cat) : null,
      h('ul', { class: 'form-list' }, ...items.map((f) => h('li', null, link(`/s/${sys.id}/formular/${f.id}`,
        h('span', { class: 'form-icon', attrs: { 'aria-hidden': 'true' } }, icon(formIcon(f), 22)),
        h('span', { class: 'form-text' },
          h('span', { class: 'form-name' }, f.name),
          f.description ? h('span', { class: 'form-desc' }, f.description) : null),
        h('span', { class: 'form-go', attrs: { 'aria-hidden': 'true' } }, icon('next', 18)))))))));
  };
  drawList();
  const search = h('input', { class: 'search', attrs: { type: 'search', placeholder: 'Formular suchen, z. B. VPN, Drucker, Laptop', 'aria-label': 'Formulare durchsuchen' } });
  search.addEventListener('input', () => { filter = search.value; drawList(); });

  const b = sys.branding;
  const switcher = systemSwitch((id) => `/s/${id}`);
  const open = tickets?.tickets ?? [];
  return h('div', { class: 'home' },
    h('section', { class: 'hero', attrs: { 'aria-labelledby': 'h-forms' } },
      b.logoDarkId ? h('img', { class: 'hero-logo', attrs: { src: assetUrl(b.logoDarkId), alt: b.displayName } }) : null,
      h('h1', { id: 'h-forms' }, b.welcomeText || 'Wie können wir helfen?'),
      h('p', { class: 'hero-sub' }, `Wählen Sie ein Formular. Ihre Anfrage geht an ${sys.name}.`),
      switcher ? h('p', { class: 'switch-label', id: 'switch-label' }, 'Anfrage geht an') : null,
      switcher,
      forms.forms.length > 6 ? h('div', { class: 'search-wrap' }, icon('search', 20), search) : null),
    h('div', { class: 'container' },
      sys.status === 'maintenance' ? notice('warn', `${sys.name} ist gerade in Wartung. Ihre Anfrage wird angenommen und automatisch übermittelt, sobald das System wieder bereit ist.`) : null,
      h('div', { class: 'home-grid' },
        h('section', { class: 'home-main', attrs: { 'aria-label': 'Formulare' } }, listHost),
        h('aside', { class: 'home-side', attrs: { 'aria-labelledby': 'h-open' } },
          h('div', { class: 'side-head' }, h('h2', { id: 'h-open' }, 'Offene Tickets'), link(`/s/${sys.id}/tickets`, 'Alle anzeigen')),
          tickets?.unavailable ? notice('warn', 'Tickets können gerade nicht geladen werden.') : null,
          (tickets?.pending ?? []).length ? h('ul', { class: 'mini-list' }, ...tickets!.pending.map((r) => h('li', null, h('span', { class: 'mini-title' }, r.title), statusBadge(r.status)))) : null,
          open.length
            ? h('ul', { class: 'mini-list' }, ...open.slice(0, 6).map((t) => h('li', null, link(`/s/${sys.id}/tickets/${t.id}`,
              h('span', { class: 'mini-title' }, t.title), h('span', { class: 'mini-meta' }, h('span', { class: 'num' }, `#${t.number}`), ticketState(t.state, t.closed), h('span', null, relTime(t.updatedAt)))))))
            : !tickets?.pending.length ? h('p', { class: 'muted' }, 'Keine offenen Tickets.') : null))),
  );
}

export async function formPage(p: Record<string, string>) {
  const sys = await systemOrDefault(p.systemId);
  const data = await get<{ form: { id: string; name: string; description: string; version: number }; system: { id: string; name: string; status: string }; definition: FormDefinition }>(`/api/portal/forms/${p.formId}`);
  const form = renderForm(data.definition);
  const msg = h('div', { attrs: { 'aria-live': 'polite' } });
  const host = h('div', { class: 'container narrow' });
  const submit = h('button', { class: ['btn', 'btn-primary'], attrs: { type: 'submit' } }, 'Anfrage senden');
  const el = h('form', { class: 'portal-form', attrs: { novalidate: true }, on: { submit: async (e) => {
    e.preventDefault();
    mount(msg);
    if (!form.validate()) { mount(msg, notice('error', 'Bitte prüfen Sie die markierten Felder.')); return; }
    submit.disabled = true;
    submit.textContent = 'Wird gesendet …';
    try {
      const files: Record<string, { name: string; type: string; data: string }[]> = {};
      for (const [fid, list] of Object.entries(form.files)) {
        if (!list.length) continue;
        files[fid] = await Promise.all(list.map(async (f) => ({ name: f.name, type: f.type, data: await fileToBase64(f) })));
      }
      const values = Object.fromEntries(Object.entries(form.values).filter(([k]) => !files[k] && !data.definition.fields.some((f) => f.id === k && f.type === 'file')));
      const r = await post<{ id: string; title: string; successText: string }>(`/api/portal/forms/${p.formId}/submit`, { values, files, version: data.form.version });
      mount(host, h('div', { class: 'success' },
        h('div', { class: 'success-mark', attrs: { 'aria-hidden': 'true' } }, icon('check', 28)),
        h('h1', null, 'Anfrage gesendet'),
        h('p', null, r.successText || 'Ihre Anfrage ist eingegangen.'),
        h('p', { class: 'muted' }, `„${r.title}“ wird jetzt an ${data.system.name} übermittelt. Die Ticketnummer sehen Sie gleich unter „Meine Tickets“.`),
        h('div', { class: 'row' }, link(`/s/${data.system.id}/tickets`, 'Zu meinen Tickets'), link(`/s/${data.system.id}`, 'Weitere Anfrage stellen'))));
      window.scrollTo({ top: 0 });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'validation' && err.details && typeof err.details === 'object' && !Array.isArray(err.details)) form.setErrors(err.details as Record<string, string>);
      mount(msg, notice('error', errorText(err)));
    } finally {
      submit.disabled = false;
      submit.textContent = 'Anfrage senden';
    }
  } } },
    form.el,
    msg,
    h('div', { class: 'form-actions' }, submit, link(`/s/${sys?.id ?? data.system.id}`, 'Abbrechen')),
  );
  // Sammelhinweis verschwindet, sobald korrigiert wird
  el.addEventListener('input', () => { if (msg.firstChild) mount(msg); });
  el.addEventListener('change', () => { if (msg.firstChild) mount(msg); });
  mount(host,
    h('nav', { class: 'crumbs', attrs: { 'aria-label': 'Navigation' } }, link(`/s/${data.system.id}`, icon('back', 14), 'Alle Formulare')),
    h('h1', null, data.form.name),
    data.form.description ? h('p', { class: 'sub' }, data.form.description) : null,
    data.system.status === 'maintenance' ? notice('warn', 'Das Ticketsystem ist gerade in Wartung. Ihre Anfrage wird später automatisch übermittelt.') : null,
    el);
  return host;
}

const COL_LABEL: Record<string, string> = { number: 'Nr.', title: 'Betreff', state: 'Status', priority: 'Priorität', group: 'Bereich', created_at: 'Erstellt', updated_at: 'Zuletzt geändert' };

export async function ticketsPage(p: Record<string, string>, q: URLSearchParams) {
  const sys = await systemOrDefault(p.systemId);
  if (!sys) return noSystems();
  const host = h('div', { class: 'container' });
  const load = async (overview?: string, refresh = false) => {
    const data = await get<{ overview: Overview; overviews: Overview[]; tickets: Ticket[]; pending: PendingRequest[]; unavailable: boolean }>(
      `/api/portal/systems/${sys.id}/tickets?${new URLSearchParams({ ...(overview ? { overview } : {}), ...(refresh ? { refresh: '1' } : {}) })}`);
    const cols = data.overview.columns.length ? data.overview.columns : ['number', 'title', 'state', 'updated_at'];
    mount(host,
      pageHead('Meine Tickets', `Ihre Tickets bei ${sys.name}`, [systemSwitch((id) => `/s/${id}/tickets`, true), button('Aktualisieren', () => load(data.overview.id, true), { icon: 'refresh', kind: 'ghost' })].filter((x): x is HTMLElement => x !== null)),
      tabs(data.overviews.map((o) => ({ id: o.id, label: o.name })), data.overview.id, (id) => { setUrl(`${curPath()}?ansicht=${id}`, true); void load(id); }),
      data.unavailable ? notice('warn', `${sys.name} ist gerade nicht erreichbar. Bitte später erneut versuchen.`) : null,
      data.pending.length ? h('div', { class: 'pending' }, h('h2', null, 'Noch nicht übermittelt'), table(data.pending, [
        { label: 'Betreff', render: (r) => r.title },
        { label: 'Status', render: (r) => statusBadge(r.status) },
        { label: 'Gesendet', render: (r) => fmtDate(r.created_at) },
      ])) : null,
      table(data.tickets, cols.map((c) => ({
        label: COL_LABEL[c] ?? c,
        class: c === 'number' ? 'num' : c === 'title' ? 'grow' : undefined,
        render: (t: Ticket): Child => c === 'number' ? `#${t.number}` : c === 'title' ? link(`/s/${sys.id}/tickets/${t.id}`, t.title)
          : c === 'state' ? ticketState(t.state, t.closed) : c === 'created_at' ? fmtDate(t.createdAt) : c === 'updated_at' ? relTime(t.updatedAt)
          : c === 'priority' ? (t.priority ?? '').replace(/^\d\s/, '') : c === 'group' ? (t.group ?? '').split('::').pop() ?? '' : '',
      })), { onRow: (t) => navigate(`/s/${sys.id}/tickets/${t.id}`), empty: data.overview.stateFilter === 'closed' ? 'Keine erledigten Tickets' : 'Keine Tickets in dieser Ansicht' }),
    );
  };
  await load(q.get('ansicht') ?? undefined);
  return host;
}

export async function ticketDetailPage(p: Record<string, string>) {
  const sys = await systemOrDefault(p.systemId);
  if (!sys) return noSystems();
  const host = h('div', { class: 'container narrow' });
  const load = async () => {
    const d = await get<{ ticket: Ticket; allowReplies: boolean; articles: { id: number; from: string; sender: string; createdAt: string; text: string; attachments: { id: number; filename: string; size: number }[] }[] }>(`/api/portal/systems/${sys.id}/tickets/${p.ticketId}`);
    let reply = '';
    const replyFiles: File[] = [];
    const fileInput = h('input', { attrs: { type: 'file', multiple: true, class: 'visually-hidden', id: 'reply-files' } });
    const fileList = h('ul', { class: 'file-list' });
    const drawFiles = () => fileList.replaceChildren(...replyFiles.map((f, i) => h('li', null, icon('file', 16), h('span', { class: 'file-name' }, f.name),
      h('button', { class: 'icon-btn', attrs: { type: 'button', 'aria-label': `${f.name} entfernen` }, on: { click: () => { replyFiles.splice(i, 1); drawFiles(); } } }, icon('x', 16)))));
    fileInput.addEventListener('change', () => { if (fileInput.files) replyFiles.push(...Array.from(fileInput.files).slice(0, 5 - replyFiles.length)); fileInput.value = ''; drawFiles(); });
    const msg = h('div', { attrs: { 'aria-live': 'polite' } });
    mount(host,
      h('nav', { class: 'crumbs' }, link(`/s/${sys.id}/tickets`, icon('back', 14), 'Meine Tickets')),
      h('div', { class: 'ticket-head' },
        h('h1', null, d.ticket.title),
        h('p', { class: 'ticket-meta' }, h('span', { class: 'num' }, `#${d.ticket.number}`), ticketState(d.ticket.state, d.ticket.closed), h('span', { class: 'muted' }, `erstellt ${fmtDate(d.ticket.createdAt)}`))),
      h('ol', { class: 'thread' }, ...d.articles.map((a) => h('li', { class: ['msg', a.sender === 'Customer' ? 'msg-me' : 'msg-it'] },
        h('div', { class: 'msg-head' }, h('strong', null, a.sender === 'Customer' ? 'Sie' : a.from || 'IT-Service'), h('span', { class: 'muted' }, fmtDate(a.createdAt))),
        h('div', { class: 'msg-body' }, a.text),
        a.attachments.length ? h('ul', { class: 'attachments' }, ...a.attachments.map((f) => h('li', null,
          h('a', { attrs: { href: `/api/portal/systems/${sys.id}/tickets/${d.ticket.id}/articles/${a.id}/attachments/${f.id}`, download: f.filename } }, icon('file', 14), f.filename)))) : null))),
      d.allowReplies ? h('form', { class: 'reply', on: { submit: async (e) => {
        e.preventDefault();
        if (!reply.trim()) { mount(msg, notice('error', 'Bitte eine Nachricht eingeben.')); return; }
        try {
          const files = await Promise.all(replyFiles.map(async (f) => ({ name: f.name, type: f.type, data: await fileToBase64(f) })));
          await post(`/api/portal/systems/${sys.id}/tickets/${d.ticket.id}/reply`, { text: reply, files });
          toast('Antwort gesendet');
          await load();
        } catch (err) { mount(msg, notice('error', errorText(err))); }
      } } },
        h('h2', null, d.ticket.closed ? 'Ticket wieder öffnen' : 'Antworten'),
        d.ticket.closed ? h('p', { class: 'muted small' }, 'Eine Antwort öffnet das Ticket in der Regel wieder.') : null,
        fieldWrap(textarea('', (v) => { reply = v; }, { rows: 5, maxlength: 10000, required: true }), { label: 'Ihre Nachricht' }),
        h('div', { class: 'row' }, h('label', { class: ['btn', 'btn-ghost'], attrs: { for: 'reply-files' } }, icon('clip', 16), 'Datei anhängen'), fileInput),
        fileList, msg,
        h('div', { class: 'form-actions' }, h('button', { class: ['btn', 'btn-primary'], attrs: { type: 'submit' } }, 'Antwort senden'))) : null,
    );
  };
  await load();
  return host;
}

export async function requestsPage() {
  const r = await get<{ requests: { id: string; systemName: string; system_id: string; title: string; status: string; ticket_number: string | null; ticket_id: number | null; created_at: number }[] }>('/api/portal/requests');
  return h('div', { class: 'container' },
    pageHead('Meine Anfragen', 'Alles, was Sie über das Portal gesendet haben'),
    table(r.requests, [
      { label: 'Gesendet', render: (x) => fmtDate(x.created_at) },
      { label: 'Betreff', class: 'grow', render: (x) => x.ticket_id ? link(`/s/${x.system_id}/tickets/${x.ticket_id}`, x.title) : x.title },
      { label: 'Ticketsystem', render: (x) => x.systemName },
      { label: 'Ticket', class: 'num', render: (x) => x.ticket_number ? `#${x.ticket_number}` : '' },
      { label: 'Status', render: (x) => statusBadge(x.status) },
    ], { empty: 'Sie haben noch keine Anfragen gesendet.' }));
}

export async function accountPage() {
  const me = state.me!;
  const host = h('div', { class: 'container narrow' });
  const draw = async () => {
    const sec: Child[] = [];
    if (me.user.kind === 'local') {
      sec.push(h('section', { class: 'panel' }, h('h2', null, 'Passwort ändern'), passwordForm(async () => { toast('Passwort geändert. Andere Sitzungen wurden abgemeldet.'); await loadMe(); }, false)));
      if (!state.me!.user.totpEnabled) {
        sec.push(h('section', { class: 'panel' }, h('h2', null, 'Zwei-Faktor-Anmeldung'), h('p', { class: 'muted' }, 'Schützt Ihr Konto zusätzlich mit einem Code aus einer Authenticator-App.'),
          await totpSetupBlock(async () => { toast('Zwei-Faktor-Anmeldung ist aktiv'); await loadMe(); await draw(); }).catch((err) => notice('error', errorText(err)))));
      } else {
        sec.push(h('section', { class: 'panel' }, h('h2', null, 'Zwei-Faktor-Anmeldung'), notice('ok', 'Aktiv. Zum Zurücksetzen (z. B. bei neuem Handy) wenden Sie sich an die IT.')));
      }
    } else {
      sec.push(h('section', { class: 'panel' }, h('h2', null, 'Anmeldung über Microsoft'), h('p', null, 'Passwort und Zwei-Faktor-Anmeldung verwalten Sie in Ihrem Microsoft-Konto.')));
    }
    mount(host,
      pageHead('Konto und Sicherheit'),
      h('section', { class: 'panel' }, h('dl', { class: 'facts' },
        h('dt', null, 'Name'), h('dd', null, me.user.displayName),
        h('dt', null, 'E-Mail'), h('dd', null, me.user.email ?? '–'),
        h('dt', null, 'Abteilung'), h('dd', null, me.user.department ?? '–'),
        h('dt', null, 'Anmeldung'), h('dd', null, me.user.kind === 'entra' ? 'Microsoft (Entra ID)' : `Lokales Konto (${me.user.username})`))),
      ...sec);
  };
  await draw();
  return host;
}

