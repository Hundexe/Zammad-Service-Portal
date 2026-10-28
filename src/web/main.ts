// Einstiegspunkt des Frontends.
import { h, mount, type Child } from './lib/dom.ts';
import { get } from './lib/api.ts';
import { applyBranding, currentSystem, link, loadMe, loadSystems, navBrand, navLinks, themeToggle, render, route, selectSystem, setLayouts, setPrepare, state, userMenu, navigate } from './lib/app.ts';
import { notice } from './lib/ui.ts';
import { DEMO, setDemoBackend } from './lib/env.ts';
import { loginPage } from './pages/login.ts';
import { accountPage, formPage, homePage, requestsPage, ticketDetailPage, ticketsPage } from './pages/portal.ts';
import { approvalDetailPage, approvalsPage } from './pages/approvals.ts';
import { approvalsNavLink, bell, refreshCounts, startPolling } from './lib/notify.ts';
import { sidebar, loadAdminSystems, admin } from './admin/common.ts';
import { objectsPage, systemEditPage, systemsListPage } from './admin/systems.ts';
import { formEditorPage, formsListPage } from './admin/forms.ts';
import { brandingPage, loginSettingsPage, overviewsPage, templatesPage } from './admin/content.ts';
import { rolesPage, usersPage } from './admin/access.ts';
import { auditPage, dashboardPage, deliveryPage, updatesPage } from './admin/ops.ts';
import { transferPage } from './admin/transfer.ts';

function skipLink(): HTMLElement {
  return h('a', { class: 'skip', attrs: { href: '#main' } }, 'Zum Inhalt springen');
}

function portalLayout(content: Child, path: string): Child {
  const sys = currentSystem();
  const b = sys?.branding ?? state.config!.branding;
  applyBranding(b);
  document.body.dataset.layout = 'portal';
  const base = sys ? `/s/${sys.id}` : '/';
  const onTickets = path.includes('/tickets');
  const onApprovals = path.startsWith('/freigaben');
  const extra = navLinks(b);
  const onOther = path === '/anfragen' || path === '/konto' || onApprovals;
  void refreshCounts();
  return [
    skipLink(),
    h('header', { class: 'band' },
      h('div', { class: 'band-inner' },
        h('a', { class: 'brand', attrs: { href: base, 'data-link': '', 'aria-label': `${b.displayName} – Startseite` } }, ...navBrand(b)),
        h('nav', { class: 'main-nav', attrs: { 'aria-label': 'Hauptnavigation' } },
          h('a', { class: !onTickets && !onOther ? 'active' : undefined, attrs: { href: base, 'data-link': '' } }, 'Anfrage stellen'),
          sys ? h('a', { class: onTickets ? 'active' : undefined, attrs: { href: `${base}/tickets`, 'data-link': '' } }, 'Meine Tickets') : null,
          approvalsNavLink(onApprovals),
          ...extra.inline),
        extra.menu,
        bell(),
        themeToggle(),
        userMenu())),
    h('main', { id: 'main', class: 'portal-main' }, content),
    h('footer', { class: 'foot' }, h('div', { class: 'band-inner' },
      h('span', null, b.footerText || b.displayName),
      h('span', { class: 'spacer' }),
      b.imprintUrl ? h('a', { attrs: { href: b.imprintUrl, rel: 'noopener noreferrer', target: '_blank' } }, 'Impressum') : null,
      b.privacyUrl ? h('a', { attrs: { href: b.privacyUrl, rel: 'noopener noreferrer', target: '_blank' } }, 'Datenschutz') : null)),
  ];
}

function adminLayout(content: Child, path: string): Child {
  const b = state.config!.branding;
  applyBranding(b);
  document.body.dataset.layout = 'admin';
  return [
    skipLink(),
    h('header', { class: 'band band-admin' }, h('div', { class: 'band-inner wide' },
      h('a', { class: 'brand', attrs: { href: '/admin', 'data-link': '' } }, h('span', { class: 'brand-mark', attrs: { 'aria-hidden': 'true' } }, b.displayName.slice(0, 1)), h('span', { class: 'brand-name' }, 'Verwaltung')),
      h('span', { class: 'spacer' }),
      themeToggle(),
      userMenu())),
    h('div', { class: 'admin-shell' }, sidebar(path), h('main', { id: 'main', class: 'admin-main' }, content)),
  ];
}

function bareLayout(content: Child): Child {
  document.body.dataset.layout = 'bare';
  return h('main', { id: 'main' }, content);
}

setLayouts({ portal: portalLayout, admin: adminLayout, bare: (c) => bareLayout(c) });
setPrepare({
  portal: async (p) => {
    if (!state.systems.length) await loadSystems();
    if (p.systemId && state.systems.some((s) => s.id === p.systemId)) selectSystem(p.systemId);
  },
  admin: async (p) => {
    if (!state.me?.isAdmin) return;
    await loadAdminSystems();
    if (p.systemId) admin.systemId = p.systemId;
  },
});

const adminRoute = (path: string, page: (p: Record<string, string>, q: URLSearchParams) => Promise<Child> | Child) =>
  route(path, 'admin', async (p, q) => {
    if (!state.me?.isAdmin) return notice('error', 'Keine Berechtigung für die Verwaltung.');
    await loadAdminSystems();
    return page(p, q);
  });

route('/login', 'bare', loginPage, false);
route('/', 'portal', async () => {
  await loadSystems();
  const sys = currentSystem();
  if (sys) { navigate(`/s/${sys.id}`, true); return h('div'); }
  return homePage({});
});
route('/s/:systemId', 'portal', homePage);
route('/s/:systemId/formular/:formId', 'portal', formPage);
route('/s/:systemId/tickets', 'portal', ticketsPage);
route('/s/:systemId/tickets/:ticketId', 'portal', ticketDetailPage);
route('/anfragen', 'portal', requestsPage);
route('/freigaben', 'portal', approvalsPage);
route('/freigaben/:approvalId', 'portal', approvalDetailPage);
route('/konto', 'portal', accountPage);

adminRoute('/admin', dashboardPage);
adminRoute('/admin/systeme', systemsListPage);
adminRoute('/admin/systeme/:systemId', systemEditPage);
adminRoute('/admin/systeme/:systemId/objekte', objectsPage);
adminRoute('/admin/systeme/:systemId/formulare', formsListPage);
adminRoute('/admin/systeme/:systemId/formulare/:formId', formEditorPage);
adminRoute('/admin/systeme/:systemId/vorlagen', templatesPage);
adminRoute('/admin/systeme/:systemId/uebersichten', overviewsPage);
adminRoute('/admin/systeme/:systemId/branding', brandingPage);
adminRoute('/admin/rollen', rolesPage);
adminRoute('/admin/benutzer', usersPage);
adminRoute('/admin/zustellung', deliveryPage);
adminRoute('/admin/export', transferPage);
adminRoute('/admin/audit', auditPage);
adminRoute('/admin/updates', updatesPage);
adminRoute('/admin/einstellungen', loginSettingsPage);

/**
 * Links, Schaltflächen und Bilder der Oberfläche lassen sich nicht wegziehen (sonst entsteht beim Klicken
 * mit leichter Mausbewegung ein Drag-Bild mit URL). Ausnahmen: alles mit draggable="true"
 * (z. B. Felder im Formular-Editor) und Texte in Eingabefeldern.
 */
document.addEventListener('dragstart', (e) => {
  const t = e.target instanceof Element ? e.target : (e.target as Node | null)?.parentElement;
  if (!t || t.closest('[draggable="true"]')) return;
  if (t.closest('a, button, img, svg, summary, label, .btn')) e.preventDefault();
});

async function boot() {
  try {
    if (DEMO) {
      // Statische Demo: Simulator laden, Hinweis einblenden
      const { createDemoBackend } = await import('./demo/backend.ts');
      setDemoBackend(await createDemoBackend());
      document.body.appendChild(h('aside', { class: 'demo-banner', attrs: { role: 'note' } },
        h('strong', null, 'Demo'), ' mit Beispieldaten – Änderungen bleiben nur in diesem Tab. ',
        h('a', { attrs: { href: 'https://github.com/Hundexe/Zammad-Service-Portal', target: '_blank', rel: 'noopener noreferrer' } }, 'Projekt auf GitHub')));
    }
    state.config = await get('/api/public/config');
    applyBranding(state.config!.branding);
    const me = await loadMe();
    if (me?.state === 'active') await loadSystems().catch(() => undefined);
    startPolling();
    await render();
  } catch {
    mount(document.getElementById('app')!, h('main', { class: 'center-page' }, h('h1', null, 'Portal nicht erreichbar'), h('p', null, 'Bitte später erneut versuchen.')));
  }
}

void link;
void boot();
