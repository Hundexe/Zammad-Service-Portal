// Benachrichtigungen im Portal: Glocke mit Zähler, Liste der Nachrichten, Zähler offener Freigaben.
// Die Zähler werden bei jedem Seitenwechsel und jede Minute (nur bei sichtbarem Tab) neu geholt.
import { h, icon, mount, relTime } from './dom.js?v=142b079f7fc6';
import { get, post } from './api.js?v=142b079f7fc6';
import { link, navigate, state } from './app.js?v=142b079f7fc6';
import { errorText } from './ui.js?v=142b079f7fc6';

export const counts = { unread: 0, approvalsOpen: 0 };
const listeners = new Set            ();
let polling = false;
let inflight                       = null;

function emit() { for (const l of listeners) l(); }

export function refreshCounts()                {
  if (state.me?.state !== 'active') return Promise.resolve();
  inflight ??= get                                           ('/api/portal/notifications/count')
    .then((r) => { counts.unread = r.unread; counts.approvalsOpen = r.approvalsOpen; emit(); })
    .catch(() => undefined)
    .finally(() => { inflight = null; });
  return inflight;
}

export function startPolling()       {
  if (polling) return;
  polling = true;
  setInterval(() => { if (document.visibilityState === 'visible') void refreshCounts(); }, 60_000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void refreshCounts(); });
}

/** Element, das sich bei neuen Zählerständen selbst aktualisiert, solange es im Dokument ist. */
function live                       (el   , update                 )    {
  let attached = false;
  const fn = () => {
    if (el.isConnected) attached = true;
    else if (attached) { listeners.delete(fn); return; }
    update(el);
  };
  listeners.add(fn);
  update(el);
  return el;
}

function countBadge(n        , label        )                     {
  return n > 0 ? h('span', { class: 'count', attrs: { 'aria-label': label } }, n > 99 ? '99+' : String(n)) : null;
}

/** Menüpunkt "Freigaben" in der Hauptnavigation – nur sichtbar, wenn etwas wartet oder die Seite offen ist. */
export function approvalsNavLink(active         )              {
  const a = h('a', { class: active ? 'active' : undefined, attrs: { href: '/freigaben', 'data-link': '' } });
  return live(a, (el) => {
    el.hidden = !active && counts.approvalsOpen === 0;
    mount(el, 'Freigaben', countBadge(counts.approvalsOpen, `${counts.approvalsOpen} offen`));
  });
}

                                                                                                                                      

/** Glocke mit aufklappbarer Liste. */
export function bell()              {
  const panel = h('div', { class: 'menu notif-panel', attrs: { role: 'region', 'aria-label': 'Benachrichtigungen' } });
  const summary = h('summary', { attrs: { 'aria-label': 'Benachrichtigungen' } });
  const details = h('details', { class: ['user-menu', 'notif-menu'] }, summary, panel);
  live(summary, (el) => {
    mount(el, icon('bell', 20), countBadge(counts.unread, `${counts.unread} ungelesen`));
    el.setAttribute('aria-label', counts.unread ? `Benachrichtigungen, ${counts.unread} ungelesen` : 'Benachrichtigungen');
  });

  const load = async () => {
    mount(panel, h('p', { class: 'muted small notif-empty' }, 'Wird geladen …'));
    try {
      const r = await get                                                                  ('/api/portal/notifications');
      counts.unread = r.unread; counts.approvalsOpen = r.approvalsOpen; emit();
      const open = async (n      ) => {
        details.open = false;
        if (!n.read) { await post('/api/portal/notifications/read', { ids: [n.id] }).catch(() => undefined); void refreshCounts(); }
        if (n.link) navigate(n.link);
      };
      mount(panel,
        h('div', { class: 'notif-head' }, h('strong', null, 'Benachrichtigungen'),
          r.unread ? h('button', { class: 'link-btn', attrs: { type: 'button' }, on: { click: async () => {
            await post('/api/portal/notifications/read', {}).catch(() => undefined);
            await refreshCounts(); await load();
          } } }, 'Alle gelesen') : null),
        r.approvalsOpen ? h('div', { class: 'notif-cta' }, link('/freigaben', icon('shield', 16), `${r.approvalsOpen} ${r.approvalsOpen === 1 ? 'Anfrage wartet' : 'Anfragen warten'} auf Ihre Freigabe`)) : null,
        r.notifications.length
          ? h('ul', { class: 'notif-list' }, ...r.notifications.map((n) => h('li', null,
            h('button', { class: ['notif', !n.read && 'unread'], attrs: { type: 'button' }, on: { click: () => void open(n) } },
              h('span', { class: 'notif-title' }, n.title),
              n.body ? h('span', { class: 'notif-body' }, n.body) : null,
              h('span', { class: 'notif-time' }, relTime(n.createdAt))))))
          : h('p', { class: 'muted small notif-empty' }, 'Keine Benachrichtigungen.'));
    } catch (err) {
      mount(panel, h('p', { class: 'error small notif-empty' }, errorText(err)));
    }
  };
  details.addEventListener('toggle', () => { if (details.open) void load(); });
  return details;
}

// Klick daneben schließt die Liste
document.addEventListener('click', (e) => {
  for (const d of document.querySelectorAll                    ('details.notif-menu[open], details.links-menu[open]')) if (!d.contains(e.target        )) d.open = false;
});
