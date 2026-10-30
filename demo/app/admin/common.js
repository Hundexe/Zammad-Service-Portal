// Gemeinsames für die Verwaltung: Systemliste, Navigation.
import { h, icon } from '../lib/dom.js?v=142b079f7fc6';
import { get } from '../lib/api.js?v=142b079f7fc6';
import { can, canAnywhere, curPath, link, navigate, state, statusEnabled } from '../lib/app.js?v=142b079f7fc6';
import { modeToggle } from './mode.js?v=142b079f7fc6';

                              
                                                                                                                        
                                                                                                                          
                                                                                                                                    
                                                                         
                                                   
 

export const admin = {
  systems: []                 ,
  canCreate: false,
  systemId: null                 ,
  loaded: false,
};

export async function loadAdminSystems(force = false)                {
  if (admin.loaded && !force) return;
  const r = await get                                                ('/api/admin/systems');
  admin.systems = r.systems;
  admin.canCreate = r.canCreate;
  admin.loaded = true;
  if (!admin.systemId || !admin.systems.some((s) => s.id === admin.systemId)) admin.systemId = admin.systems[0]?.id ?? null;
}

export function adminSystem(id        )              {
  const s = admin.systems.find((x) => x.id === id);
  if (!s) throw new Error('Ticketsystem nicht gefunden oder keine Berechtigung');
  admin.systemId = s.id;
  return s;
}

export function sidebar(path        )              {
  const sid = admin.systemId;
  const item = (href        , label        , show = true) => show
    ? h('li', null, h('a', { class: path === href || (href !== '/admin' && href !== '/admin/systeme' && !/^\/admin\/systeme\/[^/]+$/.test(href) && path.startsWith(href + '/')) ? 'active' : undefined, attrs: { href, 'data-link': '', 'aria-current': path === href ? 'page' : undefined } }, label))
    : null;
  const sysSelect = admin.systems.length > 1 ? (() => {
    const sel = h('select', { attrs: { 'aria-label': 'Ticketsystem für die Verwaltung' } }, ...admin.systems.map((s) => h('option', { attrs: { value: s.id } }, s.name)));
    sel.value = sid ?? '';
    sel.addEventListener('change', () => {
      admin.systemId = sel.value;
      const rest = path.replace(/^\/admin\/systeme\/[^/]+/, '');
      navigate(path.startsWith('/admin/systeme/') ? `/admin/systeme/${sel.value}${rest.split('/').slice(0, 2).join('/')}` : path);
    });
    return sel;
  })() : null;
  const current = admin.systems.find((s) => s.id === sid);
  return h('nav', { class: 'sidebar', attrs: { 'aria-label': 'Verwaltung' } },
    h('ul', null, item('/admin', 'Übersicht')),
    h('p', { class: 'nav-title' }, 'Ticketsystem'),
    sysSelect ?? (current ? h('p', { class: 'nav-system' }, current.name) : null),
    sid ? h('ul', null,
      item(`/admin/systeme/${sid}`, 'Verbindung', can('system.manage', sid)),
      item(`/admin/systeme/${sid}/objekte`, 'Zammad-Objekte', can('attribute.release', sid)),
      item(`/admin/systeme/${sid}/formulare`, 'Formulare', can('form.edit', sid) || can('form.publish', sid) || can('form.approve', sid)),
      item(`/admin/systeme/${sid}/vorlagen`, 'Vorlagen', can('template.edit', sid)),
      item(`/admin/systeme/${sid}/uebersichten`, 'Übersichten', can('overview.edit', sid)),
      item(`/admin/systeme/${sid}/branding`, 'Stil, Farben, Logo', can('branding.edit', sid) || can('form.approve', sid)),
    ) : null,
    canAnywhere('system.manage') ? h('ul', { class: 'nav-sub' }, item('/admin/systeme', 'Alle Ticketsysteme')) : null,
    statusEnabled() && (canAnywhere('status.manage') || canAnywhere('problem.manage')) ? h('p', { class: 'nav-title' }, 'Betrieb') : null,
    statusEnabled() && (canAnywhere('status.manage') || canAnywhere('problem.manage')) ? h('ul', null, item('/admin/status', 'Status und Störungen')) : null,
    h('p', { class: 'nav-title' }, 'Portal'),
    h('ul', null,
      item('/admin/rollen', 'Rollen und Rechte', can('role.manage')),
      item('/admin/benutzer', 'Benutzer', can('user.manage')),
      item('/admin/zustellung', 'Zustellung', canAnywhere('system.manage')),
      item('/admin/export', 'Export und Import', can('system.manage')),
      item('/admin/audit', 'Audit-Log', canAnywhere('audit.read')),
      item('/admin/updates', 'Updates', can('update.read') || can('update.install')),
      item('/admin/einstellungen', 'Anmeldeseite', can('settings.manage')),
      item('/admin/funktionen', 'Funktionen', can('settings.manage')),
    ),
    modeToggle(() => navigate(curPath(), true)),
    h('div', { class: 'sidebar-foot' }, link('/', icon('back', 14), 'Zum Portal'), h('span', { class: 'muted small' }, state.me?.user.displayName ?? '')),
  );
}
