// Verwaltung: Rollen, Rechte-Zuordnungen und lokale Benutzer.
import { h, mount, fmtDate } from '../lib/dom.js?v=142b079f7fc6';
import { get, post, put, del } from '../lib/api.js?v=142b079f7fc6';
import { badge, button, checkbox, confirmDialog, copyButton, dialog, errorText, fieldWrap, input, notice, pageHead, select, table, toast } from '../lib/ui.js?v=142b079f7fc6';
import { navigate, state, curPath, curSearch } from '../lib/app.js?v=142b079f7fc6';
import { admin, loadAdminSystems } from './common.js?v=142b079f7fc6';

                                                                                                         
                                                                                                                                                                 
                                                                                   

export async function rolesPage() {
  await loadAdminSystems();
  const [r, meta] = await Promise.all([
    get                                              ('/api/admin/roles'),
    get                             ('/api/admin/meta'),
  ]);
  const permLabel = (k        ) => k === '*' ? 'Alle Rechte' : meta.permissions.find((p) => p.key === k)?.label ?? k;
  const roleName = (id        ) => r.roles.find((x) => x.id === id)?.name ?? '?';

  const editRole = async (role       ) => {
    const v = { name: role?.name ?? '', description: role?.description ?? '', permissions: [...(role?.permissions ?? [])] };
    const msg = h('div');
    await dialog(role ? 'Rolle bearbeiten' : 'Rolle anlegen', h('div', { class: 'stack' }, msg,
      fieldWrap(input(v.name, (x) => { v.name = x; }), { label: 'Name' }),
      fieldWrap(input(v.description, (x) => { v.description = x; }), { label: 'Beschreibung' }),
      h('p', { class: 'label' }, 'Rechte'),
      h('div', { class: 'perm-list' }, ...meta.permissions.map((p) => checkbox(v.permissions.includes(p.key), p.label + (p.global ? ' (nur global)' : ''), (x) => {
        v.permissions = x ? [...v.permissions, p.key] : v.permissions.filter((k) => k !== p.key);
      })))),
    (close) => [button('Abbrechen', () => close(), { kind: 'ghost' }), button('Speichern', async () => {
      try {
        if (role) await put(`/api/admin/roles/${role.id}`, v); else await post('/api/admin/roles', v);
        close(); toast('Gespeichert'); navigate(curPath(), true);
      } catch (err) { mount(msg, notice('error', errorText(err))); }
    }, { kind: 'primary' })], { wide: true });
  };

  const assign = async () => {
    const v = { roleId: r.roles.find((x) => x.name === 'Ziel-Admin')?.id ?? r.roles[0].id, subjectType: 'group', subjectValue: '', systemId: '' };
    const msg = h('div');
    const valueHelp = h('p', { class: 'help' });
    const setHelp = () => { valueHelp.textContent = v.subjectType === 'group' ? 'Objekt-ID der Entra-Gruppe (z. B. aus dem Entra Admin Center) oder „approle:Name“ für eine App-Rolle.' : v.subjectType === 'user' ? 'Benutzername, E-Mail-Adresse oder ID. Entra-Benutzer erscheinen nach der ersten Anmeldung.' : 'Gilt für alle angemeldeten Benutzer.'; };
    setHelp();
    const valueInput = input('', (x) => { v.subjectValue = x; });
    await dialog('Rolle zuordnen', h('div', { class: 'stack' }, msg,
      fieldWrap(select(v.roleId, r.roles.map((x) => ({ value: x.id, label: x.name })), (x) => { v.roleId = x; }), { label: 'Rolle' }),
      fieldWrap(select(v.subjectType, [{ value: 'group', label: 'Entra-Gruppe' }, { value: 'user', label: 'Einzelne Person' }, { value: 'all', label: 'Alle angemeldeten Benutzer' }], (x) => { v.subjectType = x; valueInput.disabled = x === 'all'; setHelp(); }), { label: 'Wem' }),
      h('div', { class: 'field' }, h('label', { attrs: { for: 'assign-value' } }, 'Gruppe oder Person'), (() => { valueInput.id = 'assign-value'; return valueInput; })(), valueHelp),
      fieldWrap(select(v.systemId, admin.systems.map((s) => ({ value: s.id, label: s.name })), (x) => { v.systemId = x; }, { empty: 'Alle Ticketsysteme' }), { label: 'Gilt für' })),
    (close) => [button('Abbrechen', () => close(), { kind: 'ghost' }), button('Zuordnen', async () => {
      try { await post('/api/admin/role-assignments', { ...v, systemId: v.systemId || null }); close(); toast('Zugeordnet'); navigate(curPath(), true); } catch (err) { mount(msg, notice('error', errorText(err))); }
    }, { kind: 'primary' })]);
  };

  return h('div', null,
    pageHead('Rollen und Rechte', 'Wer im Portal was darf – global oder für einzelne Ticketsysteme', [button('Rolle zuordnen', assign, { kind: 'primary', icon: 'plus' }), button('Eigene Rolle anlegen', () => editRole())]),
    notice('info', 'Änderungen an Rollen und Zuordnungen erfordern eine frische Anmeldung. Die letzte Super-Admin-Zuordnung kann nicht entfernt werden.'),
    h('section', { class: 'panel' }, h('h2', null, 'Zuordnungen'), table(r.assignments, [
      { label: 'Rolle', render: (a) => roleName(a.roleId) },
      { label: 'Wem', class: 'grow', render: (a) => h('span', null, a.subjectType === 'group' ? badge('Gruppe') : a.subjectType === 'user' ? badge('Person') : null, ' ', a.subjectLabel) },
      { label: 'Gilt für', render: (a) => a.systemName },
      { label: '', render: (a) => button('Entfernen', async () => {
        if (!await confirmDialog('Zuordnung entfernen?', `${a.subjectLabel} verliert die Rolle „${roleName(a.roleId)}“ (${a.systemName}).`, 'Entfernen', true)) return;
        try { await del(`/api/admin/role-assignments/${a.id}`); toast('Entfernt'); navigate(curPath(), true); } catch (err) { toast(errorText(err), 'error'); }
      }, { kind: 'ghost', icon: 'trash' }) },
    ])),
    h('section', { class: 'panel' }, h('h2', null, 'Rollen'), table(r.roles, [
      { label: 'Rolle', render: (x) => h('span', null, h('strong', null, x.name), x.builtin ? h('span', { class: 'muted small' }, ' eingebaut') : null) },
      { label: 'Rechte', class: 'grow', render: (x) => x.permissions.map(permLabel).join(', ') },
      { label: '', render: (x) => x.builtin ? null : h('span', { class: 'row' }, button('Bearbeiten', () => editRole(x), { kind: 'ghost' }), button('Löschen', async () => {
        if (await confirmDialog('Rolle löschen?', `„${x.name}“ und alle Zuordnungen werden gelöscht.`, 'Löschen', true)) { await del(`/api/admin/roles/${x.id}`); toast('Gelöscht'); navigate(curPath(), true); }
      }, { kind: 'ghost', icon: 'trash' })) },
    ])),
  );
}

                                                                                                                                                                                                                                                             

function passwordDialog(title        , username        , password        ) {
  return dialog(title, h('div', { class: 'stack' },
    notice('warn', 'Das Passwort wird nur jetzt angezeigt. Bitte sicher übergeben (z. B. persönlich oder per Telefon, nicht per E-Mail). Es muss bei der ersten Anmeldung geändert werden.'),
    h('dl', { class: 'facts' }, h('dt', null, 'Benutzername'), h('dd', null, h('code', null, username)), h('dt', null, 'Passwort'), h('dd', null, h('code', { class: 'secret-pw' }, password))),
    copyButton(password, 'Passwort kopieren')),
  (close) => [button('Fertig', () => close(), { kind: 'primary' })]);
}

export async function usersPage(_p                        , q                 ) {
  const r = await get                   (`/api/admin/users${q.get('q') ? `?q=${encodeURIComponent(q.get('q') )}` : ''}`);
  const roles = await get                   ('/api/admin/roles').then((x) => x.roles).catch(() => []          );
  const create = async () => {
    const v = { username: '', displayName: '', email: '', department: '', role: 'Benutzer' };
    const msg = h('div');
    await dialog('Lokalen Benutzer anlegen', h('div', { class: 'stack' }, msg,
      notice('info', 'Das Passwort wird automatisch erzeugt (20 Zeichen) und nur einmal angezeigt. Für den Alltag ist die Anmeldung über Microsoft vorgesehen; lokale Konten sind für den Start und als Notfallzugang gedacht.'),
      fieldWrap(input('', (x) => { v.username = x; }, { autocomplete: 'off', autocapitalize: 'none' }), { label: 'Benutzername' }),
      fieldWrap(input('', (x) => { v.displayName = x; }), { label: 'Anzeigename' }),
      fieldWrap(input('', (x) => { v.email = x; }, { type: 'email' }), { label: 'E-Mail', help: 'Nötig, damit Tickets in Zammad diesem Benutzer zugeordnet werden.' }),
      fieldWrap(input('', (x) => { v.department = x; }), { label: 'Abteilung' }),
      fieldWrap(select(v.role, roles.map((x) => ({ value: x.name, label: x.name })), (x) => { v.role = x; }), { label: 'Rolle', help: 'Admin-Rollen verlangen bei der ersten Anmeldung eine Authenticator-App.' })),
    (close) => [button('Abbrechen', () => close(), { kind: 'ghost' }), button('Anlegen', async () => {
      try {
        const res = await post                                        ('/api/admin/users', v);
        close();
        await passwordDialog('Benutzer angelegt', res.username, res.password);
        navigate(curPath(), true);
      } catch (err) { mount(msg, notice('error', errorText(err))); }
    }, { kind: 'primary' })]);
  };
  const search = h('form', { class: 'row', on: { submit: (e) => { e.preventDefault(); navigate(`/admin/benutzer?q=${encodeURIComponent(sInput.value)}`); } } });
  const sInput = h('input', { attrs: { type: 'search', placeholder: 'Name, Benutzername oder E-Mail', 'aria-label': 'Benutzer suchen' } });
  sInput.value = q.get('q') ?? '';
  search.append(sInput, h('button', { class: ['btn', 'btn-secondary'], attrs: { type: 'submit' } }, 'Suchen'));
  return h('div', null,
    pageHead('Benutzer', 'Lokale Konten und Microsoft-Benutzer, die sich schon angemeldet haben', [button('Lokalen Benutzer anlegen', create, { kind: 'primary', icon: 'plus' })]),
    search,
    table(r.users, [
      { label: 'Name', class: 'grow', render: (u) => h('span', null, u.displayName, h('br'), h('span', { class: 'muted small' }, u.email ?? '')) },
      { label: 'Anmeldung', render: (u) => u.kind === 'entra' ? 'Microsoft' : `Lokal (${u.username})` },
      { label: 'Status', render: (u) => h('span', { class: 'badges' },
        u.disabled ? badge('deaktiviert', 'error') : badge('aktiv', 'ok'),
        u.locked ? badge('gesperrt', 'warn') : null,
        u.kind === 'local' && u.mustChangePassword ? badge('Erstanmeldung offen', 'info') : null,
        u.kind === 'local' && u.totpEnabled ? badge('2FA') : null) },
      { label: 'Zuletzt', render: (u) => fmtDate(u.lastLoginAt) },
      { label: '', render: (u) => h('span', { class: 'row' },
        u.kind === 'local' ? button('Neues Passwort', async () => {
          let resetTotp = false;
          const ok = await dialog('Neues Passwort erzeugen?', h('div', { class: 'stack' }, h('p', null, `Für ${u.displayName} wird ein neues Passwort erzeugt. Alle Sitzungen werden beendet.`), checkbox(false, 'Auch die Authenticator-App zurücksetzen (z. B. neues Handy)', (x) => { resetTotp = x; })),
            (close) => [button('Abbrechen', () => close(false), { kind: 'ghost' }), button('Erzeugen', () => close(true), { kind: 'primary' })]);
          if (!ok) return;
          try { const res = await post                                        (`/api/admin/users/${u.id}/reset-password`, { resetTotp }); await passwordDialog('Neues Passwort', res.username, res.password); navigate(curPath() + curSearch(), true); } catch (err) { toast(errorText(err), 'error'); }
        }, { kind: 'ghost' }) : null,
        u.locked ? button('Entsperren', async () => { await post(`/api/admin/users/${u.id}/unlock`); toast('Entsperrt'); navigate(curPath() + curSearch(), true); }, { kind: 'ghost' }) : null,
        u.id !== state.me?.user.id ? button(u.disabled ? 'Aktivieren' : 'Deaktivieren', async () => {
          try { await put(`/api/admin/users/${u.id}`, { disabled: !u.disabled }); toast('Gespeichert'); navigate(curPath() + curSearch(), true); } catch (err) { toast(errorText(err), 'error'); }
        }, { kind: 'ghost' }) : null) },
    ], { empty: 'Keine Benutzer gefunden.' }));
}
