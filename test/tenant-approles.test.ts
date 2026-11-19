// App-Rollen bei mehreren erlaubten Tenants: Der Administrator eines Partner-Tenants darf seinen Leuten
// keine Portal-Rechte über eine gleichnamige App-Rolle verschaffen. Konten sind oid + Tenant.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startPortal, Client, ENTRA_USERS, TENANT_A, TENANT_B, type Portal } from './helpers.ts';
import { appRoleName, qualifyForeignAppRoles, upsertEntraUser, getUser } from '../src/server/services/users.ts';

let p: Portal;
const ANNA = ENTRA_USERS[0]!; // Heimat-Tenant A
const BEN = ENTRA_USERS[1]!;  // Partner-Tenant B

before(async () => {
  ANNA.roles = ['PortalAdmin'];
  BEN.roles = ['PortalAdmin'];
  p = await startPortal();
});
after(async () => { await p.close(); });

function assign(subject: string, id: string): void {
  const role = p.app.db.get<{ id: string }>("SELECT id FROM roles WHERE name = 'Auditor'")!;
  p.app.db.run("INSERT INTO role_assignments (id, role_id, subject_type, subject_value, system_id, created_at) VALUES (?, ?, 'group', ?, NULL, ?)", id, role.id, subject, Date.now());
}

test('appRoleName: Heimat-Tenant ohne, Partner-Tenant mit Tenant im Namen', () => {
  assert.equal(appRoleName('PortalAdmin', TENANT_A, TENANT_A), 'approle:PortalAdmin');
  assert.equal(appRoleName('PortalAdmin', TENANT_A.toUpperCase(), TENANT_A), 'approle:PortalAdmin');
  assert.equal(appRoleName('PortalAdmin', TENANT_B, TENANT_A), `approle:${TENANT_B}:PortalAdmin`);
  assert.equal(appRoleName('PortalAdmin', TENANT_B, ''), 'approle:PortalAdmin', 'ohne Heimat-Tenant (ein Tenant) wie bisher');
});

test('Zuordnung „approle:PortalAdmin“ wirkt nur für den Heimat-Tenant', async () => {
  assign('approle:PortalAdmin', 'ra-home');
  const anna = new Client(p.url);
  await anna.loginEntra(p, ANNA.oid);
  assert.equal((await anna.get('/api/admin/audit')).status, 200, 'Heimat-Tenant: Rolle wirkt');
  const ben = new Client(p.url);
  await ben.loginEntra(p, BEN.oid);
  assert.equal((await ben.get('/api/admin/audit')).status, 403, 'Partner-Tenant: gleichnamige Rolle wirkt nicht');
  const row = p.app.db.get<{ groups_json: string }>('SELECT groups_json FROM users WHERE entra_oid = ?', BEN.oid)!;
  assert.ok(JSON.parse(row.groups_json).includes(`approle:${TENANT_B}:PortalAdmin`));
});

test('Partner-Tenant: nur mit ausdrücklicher Zuordnung „approle:<Tenant>:Name“', async () => {
  assign(`approle:${TENANT_B}:PortalAdmin`, 'ra-partner');
  const ben = new Client(p.url);
  await ben.loginEntra(p, BEN.oid);
  assert.equal((await ben.get('/api/admin/audit')).status, 200);
  p.app.db.run("DELETE FROM role_assignments WHERE id IN ('ra-home', 'ra-partner')");
});

test('Beim Start: alte, ungekennzeichnete App-Rollen von Partner-Konten werden nachbenannt', () => {
  const ben = p.app.db.get<{ id: string }>('SELECT id FROM users WHERE entra_oid = ?', BEN.oid)!;
  p.app.db.run('UPDATE users SET groups_json = ? WHERE id = ?', JSON.stringify(['it-admins', 'approle:PortalAdmin', `approle:${TENANT_B}:Schon`]), ben.id);
  assert.equal(qualifyForeignAppRoles(p.app.db, TENANT_A), 1);
  assert.deepEqual(JSON.parse(getUser(p.app.db, ben.id)!.groups_json), ['it-admins', `approle:${TENANT_B}:PortalAdmin`, `approle:${TENANT_B}:Schon`]);
  assert.equal(qualifyForeignAppRoles(p.app.db, TENANT_A), 0, 'idempotent');
  // Konten des Heimat-Tenants bleiben unverändert
  const anna = p.app.db.get<{ groups_json: string }>('SELECT groups_json FROM users WHERE entra_oid = ?', ANNA.oid)!;
  assert.ok(JSON.parse(anna.groups_json).includes('approle:PortalAdmin'));
});

test('Konto = oid + Tenant: dieselbe oid aus einem anderen Tenant übernimmt kein Konto', () => {
  assert.throws(() => upsertEntraUser(p.app.db, { oid: ANNA.oid, tid: TENANT_B, name: 'Fremd', roles: ['PortalAdmin'] }, {}, (e) => e, TENANT_A), /oid_anderer_tenant/);
  const anna = p.app.db.get<{ display_name: string; tenant_id: string }>('SELECT display_name, tenant_id FROM users WHERE entra_oid = ?', ANNA.oid)!;
  assert.equal(anna.display_name, 'Anna Becker');
  assert.equal(anna.tenant_id, TENANT_A);
  // Ältere Einträge ohne Tenant werden beim nächsten Login ergänzt
  p.app.db.run("INSERT INTO users (id, kind, entra_oid, tenant_id, email, display_name, groups_json, created_at) VALUES ('alt', 'entra', 'oid-alt', NULL, NULL, 'Alt', '[]', 0)");
  const u = upsertEntraUser(p.app.db, { oid: 'oid-alt', tid: TENANT_A, name: 'Alt' }, {}, (e) => e, TENANT_A);
  assert.equal(u.id, 'alt');
  assert.equal(u.tenant_id, TENANT_A);
});
