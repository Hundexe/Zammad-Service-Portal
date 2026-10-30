// Demo-Umgebung: Portal mit Beispieldaten, zwei Zammad-Simulatoren und Entra-Simulator.
// Für Screenshots, Pentests und zum Ausprobieren – NICHT für den Produktivbetrieb.
//
//   npm run demo                  → Portal auf http://localhost:3000 (ohne Docker, ohne Caddy – nur Node.js)
//   PUBLIC_URL=https://portal.localhost:8443 node tools/demo.ts   → hinter Caddy (tools/demo-restart.sh)
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/server/config.ts';
import { createApp, type App } from '../src/server/app.ts';
import { createServer } from '../src/server/server.ts';
import { EntraClient } from '../src/server/auth/oidc.ts';
import { setLogLevel } from '../src/server/log.ts';
import { hashPassword, sha256 } from '../src/server/crypto.ts';
import { uuid } from '../src/server/db/db.ts';
import { startWorker } from '../src/server/worker.ts';
import { saveDraft, publishVersion, getForm, publishedVersion } from '../src/server/services/forms.ts';
import { getSystem } from '../src/server/services/systems.ts';
import { toAuthUser, upsertEntraUser } from '../src/server/services/users.ts';
import { submitRequest } from '../src/server/services/requests.ts';
import { decide } from '../src/server/services/approvals.ts';
import { DEFAULT_BRANDING, type Branding } from '../src/shared/branding.ts';
import type { FormDefinition } from '../src/shared/form.ts';
import { startMockZammad } from './mock-zammad.ts';
import { startMockEntra } from './mock-entra.ts';
import { createServer as createTcpServer } from 'node:net';

/** Simulierter ClamAV (clamd-Protokoll) – erkennt die EICAR-Testsignatur. Nur für Demo/Pentest. */
export function startFakeClamd(port: number): Promise<void> {
  const server = createTcpServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.subarray(0, 6).toString() === 'zPING\0') { sock.end('PONG\0'); return; }
      if (buf.length >= 4 && buf.subarray(-4).equals(Buffer.alloc(4))) {
        sock.end(buf.includes(Buffer.from('EICAR-STANDARD-ANTIVIRUS-TEST-FILE')) ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0');
      }
    });
  });
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r()));
}

export const DEMO_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
export const DEMO_ADMIN_PASSWORD = 'Demo-Admin-Passwort-2026!';
const TENANT_A = '1d3f0b2a-7c41-4e2a-9a10-5f0c2b1e0001';
const TENANT_B = '1d3f0b2a-7c41-4e2a-9a10-5f0c2b1e0002';

function wordmark(text: string, color: string, bg?: string): Buffer {
  const w = 40 + text.length * 19;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} 60" width="${w}" height="60">${bg ? `<rect width="${w}" height="60" rx="10" fill="${bg}"/>` : ''}<circle cx="26" cy="30" r="12" fill="none" stroke="${color}" stroke-width="5"/><text x="48" y="41" font-family="Segoe UI, Arial, sans-serif" font-size="30" font-weight="700" fill="${color}">${text}</text></svg>`);
}

function addAsset(app: App, data: Buffer, kind: 'logo' | 'favicon' = 'logo'): string {
  const id = uuid();
  app.db.run('INSERT INTO assets (id, kind, mime, size, sha256, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, kind, 'image/svg+xml', data.length, sha256(data), data, Date.now());
  return id;
}

function addSystem(app: App, o: { slug: string; name: string; url: string; branding: Partial<Branding>; released: unknown; sort: number; groups: string[] }): string {
  const id = uuid();
  const t = Date.now();
  app.db.run(
    `INSERT INTO ticket_systems (id, slug, name, base_url, api_token, default_group, released_attributes, allowed_groups, sort, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'IT-Support', ?, ?, ?, ?, ?)`,
    id, o.slug, o.name, o.url, app.box.encrypt('system-token', 'test-token'), JSON.stringify(o.released), JSON.stringify(o.groups), o.sort, t, t,
  );
  app.db.run("INSERT INTO branding_versions (id, system_id, version, data, status, created_at, published_at) VALUES (?, ?, 1, ?, 'published', ?, ?)",
    uuid(), id, JSON.stringify({ ...DEFAULT_BRANDING, ...o.branding }), t, t);
  for (const [i, ov] of [['Offene Tickets', 'open'], ['Erledigt', 'closed'], ['Alle', 'all']].entries()) {
    app.db.run("INSERT INTO overviews (id, system_id, name, state_filter, columns, sort_by, sort_dir, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'updated_at', 'desc', ?, ?, ?)",
      uuid(), id, ov[0], ov[1], JSON.stringify(ov[1] === 'all' ? ['number', 'title', 'state', 'group', 'created_at', 'updated_at'] : ['number', 'title', 'state', 'updated_at']), i, t, t);
  }
  const tpls: [string, string, string][] = [
    ['title', 'Formular und Name', '{{formular.name}}: {{benutzer.name}}'],
    ['body', 'Standard mit allen Feldern', '<p>Neue Anfrage über das Service-Portal von {{benutzer.name}} ({{benutzer.abteilung}}).</p>\n{{alle_felder}}'],
    ['success', 'Standard-Bestätigung', 'Danke! Sie bekommen gleich eine Eingangsbestätigung mit Ticketnummer per E-Mail.'],
  ];
  for (const [kind, name, content] of tpls) app.db.run('INSERT INTO templates (id, system_id, kind, name, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', uuid(), id, kind, name, content, t, t);
  return id;
}

function addForm(app: App, systemId: string, slug: string, name: string, category: string, description: string, def: FormDefinition, sort: number, publish = true): string {
  const id = uuid();
  app.db.run('INSERT INTO forms (id, system_id, slug, name, description, category, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', id, systemId, slug, name, description, category, sort, Date.now(), Date.now());
  const v = saveDraft(app, id, def, 'seed', 'Beispiel');
  if (publish) publishVersion(app, v, null);
  return id;
}

const settings = (title: string, group = 'IT-Support', tags: string[] = []) => ({
  titleTemplate: title,
  bodyTemplate: '<p>Neue Anfrage über das Service-Portal von {{benutzer.name}} ({{benutzer.abteilung}}).</p>\n{{alle_felder}}',
  group, tags, successText: 'Danke! Sie bekommen gleich eine Eingangsbestätigung mit Ticketnummer per E-Mail.',
});

export async function seedDemo(app: App, urls: { zentral: string; nord: string }): Promise<{ systems: Record<string, string>; forms: Record<string, string> }> {
  const released = [
    { name: 'standort', allowedValues: null },
    { name: 'sec_status', allowedValues: ['Hardware', 'Hardware::Laptop', 'Hardware::Monitor', 'Hardware::Drucker'] },
    { name: 'dringend', allowedValues: null },
    { name: 'kostenstelle', allowedValues: null },
  ];
  const groups = ['IT-Support', 'IT-Support::Hardware', 'IT-Support::Netzwerk'];
  const zentral = addSystem(app, {
    slug: 'zentrale-it', name: 'Zentrale IT', url: urls.zentral, sort: 1, released, groups,
    branding: { theme: 'glas', displayName: 'Zentrale IT', headerColor: '#0e3a5d', headerTextColor: '#ffffff', primaryColor: '#1662a8', accentColor: '#0f8a6a', ...((w) => ({ logoDarkId: w, logoNavDarkId: w }))(addAsset(app, wordmark('Zentrale IT', '#ffffff'))), logoLightId: addAsset(app, wordmark('Zentrale IT', '#0e3a5d')), welcomeText: 'Wie können wir helfen?', footerText: 'Zentrale IT – Service-Desk für alle Standorte. Telefon 1234' },
  });
  const nord = addSystem(app, {
    slug: 'it-nord', name: 'IT Nord', url: urls.nord, sort: 2, groups: ['IT-Support'], released: [{ name: 'standort', allowedValues: ['nord', 'homeoffice'] }],
    branding: { theme: 'fluent', displayName: 'IT Nord', headerColor: '#7a1f2b', headerTextColor: '#ffffff', primaryColor: '#9b2335', accentColor: '#b5651d', ...((w) => ({ logoDarkId: w, logoNavDarkId: w }))(addAsset(app, wordmark('Nord', '#ffffff'))), logoLightId: addAsset(app, wordmark('Nord', '#7a1f2b')), welcomeText: 'IT-Service Standort Nord' },
  });

  const forms: Record<string, string> = {};
  forms.stoerung = addForm(app, zentral, 'stoerung', 'Störung melden', 'Störungen', 'Etwas funktioniert nicht: Rechner, Drucker, Netzwerk, Programme', {
    fields: [
      { id: 'was', type: 'select', label: 'Was ist betroffen?', required: true, options: [{ value: 'rechner', label: 'Rechner / Laptop' }, { value: 'drucker', label: 'Drucker' }, { value: 'netzwerk', label: 'Netzwerk / WLAN / VPN' }, { value: 'programm', label: 'Programm' }, { value: 'sonstiges', label: 'Sonstiges' }], mapping: { target: 'group', valueMap: { netzwerk: 'IT-Support::Netzwerk', rechner: 'IT-Support::Hardware', drucker: 'IT-Support::Hardware', programm: 'IT-Support', sonstiges: 'IT-Support' } } },
      { id: 'programm', type: 'text', label: 'Welches Programm?', required: true, visibleIf: { field: 'was', op: 'eq', value: 'programm' } },
      { id: 'was_sonstiges', type: 'text', label: 'Was genau ist betroffen?', required: true, maxLength: 200, visibleIf: { field: 'was', op: 'eq', value: 'sonstiges' } },
      { id: 'betreff', type: 'text', label: 'Kurz zusammengefasst', required: true, placeholder: 'z. B. Outlook startet nicht', maxLength: 120 },
      { id: 'beschreibung', type: 'textarea', label: 'Was genau passiert?', required: true, help: 'Fehlermeldung, seit wann, was Sie schon versucht haben.' },
      { id: 'standort', type: 'zammad', label: 'Standort', attribute: 'standort', required: true },
      { id: 'dringend', type: 'zammad', label: 'Kann ich gerade nicht arbeiten', attribute: 'dringend' },
      { id: 'screenshot', type: 'file', label: 'Screenshot oder Fehlermeldung', maxFiles: 3, maxSizeMb: 10, accept: ['image', 'pdf', 'text'] },
    ],
    settings: settings('Störung: {{betreff}}', 'IT-Support', ['stoerung']),
  }, 1);
  forms.hardware = addForm(app, zentral, 'hardware', 'Hardware anfordern', 'Hardware', 'Laptop, Monitor, Drucker oder Zubehör bestellen', {
    fields: [
      { id: 'art', type: 'zammad', label: 'Was wird benötigt?', attribute: 'sec_status', required: true, allowedValues: ['Hardware::Laptop', 'Hardware::Monitor', 'Hardware::Drucker'] },
      { id: 'fuer', type: 'text', label: 'Für wen?', required: true, defaultFrom: 'user.name' },
      { id: 'abteilung', type: 'text', label: 'Abteilung', defaultFrom: 'user.department' },
      { id: 'kostenstelle', type: 'text', label: 'Kostenstelle', required: true, pattern: '\\d{4}', patternMessage: 'Vier Ziffern, z. B. 4711', mapping: { target: 'zammad_field', name: 'kostenstelle' } },
      { id: 'bis_wann', type: 'date', label: 'Benötigt bis' },
      { id: 'standort', type: 'zammad', label: 'Standort', attribute: 'standort', required: true },
      { id: 'begruendung', type: 'textarea', label: 'Begründung', required: true },
      { id: 'vorgesetzt', type: 'approver', label: 'Wer gibt die Anschaffung frei?', help: 'E-Mail-Adresse Ihrer bzw. Ihres Vorgesetzten. Die Bestellung geht erst nach der Freigabe an die IT.', placeholder: 'vorname.nachname@…', mapping: { target: 'article' } },
    ],
    settings: settings('Hardware: {{art}} für {{fuer}}', 'IT-Support::Hardware', ['hardware', 'bestellung']),
  }, 2);
  forms.vpn = addForm(app, zentral, 'vpn', 'VPN-Zugang beantragen', 'Zugänge und Rechte', 'Zugriff auf das Firmennetz von unterwegs oder aus dem Homeoffice', {
    fields: [
      { id: 'info', type: 'info', label: 'Vorab', help: 'Der VPN-Zugang wird nach Freigabe durch Ihre Führungskraft eingerichtet. Sie erhalten die Zugangsdaten persönlich.' },
      { id: 'ab', type: 'date', label: 'Ab wann?', required: true },
      { id: 'dauer', type: 'select', label: 'Wie lange?', required: true, options: [{ value: 'dauerhaft', label: 'Dauerhaft' }, { value: 'befristet', label: 'Befristet' }] },
      { id: 'bis', type: 'date', label: 'Bis wann?', required: true, visibleIf: { field: 'dauer', op: 'eq', value: 'befristet' } },
      { id: 'geraet', type: 'select', label: 'Gerät', required: true, options: [{ value: 'firmenlaptop', label: 'Firmenlaptop' }, { value: 'privat', label: 'Privates Gerät' }] },
      { id: 'hinweis_privat', type: 'info', label: 'Private Geräte', help: 'Private Geräte brauchen einen aktuellen Virenschutz und Updates. Die IT meldet sich dazu bei Ihnen.', visibleIf: { field: 'geraet', op: 'eq', value: 'privat' } },
      { id: 'fuehrungskraft', type: 'email', label: 'E-Mail Ihrer Führungskraft', required: true },
    ],
    settings: settings('VPN-Zugang für {{benutzer.name}}', 'IT-Support::Netzwerk', ['vpn', 'zugang']),
  }, 3);
  forms.software = addForm(app, zentral, 'software', 'Software installieren', 'Software', 'Programm installieren oder Lizenz anfordern', {
    fields: [
      { id: 'programm', type: 'text', label: 'Welches Programm?', required: true },
      { id: 'version', type: 'text', label: 'Version (falls wichtig)' },
      { id: 'geraet', type: 'text', label: 'Rechnername', help: 'Steht auf dem Aufkleber am Gerät, z. B. NB-0042', pattern: '[A-Za-z]{2}-\\d{4}', patternMessage: 'Format: zwei Buchstaben, Bindestrich, vier Ziffern' },
      { id: 'grund', type: 'textarea', label: 'Wofür wird es gebraucht?', required: true },
      { id: 'lizenz', type: 'select', label: 'Kostet das Programm Geld?', required: true, options: [{ value: 'kostenlos', label: 'Nein, kostenlos' }, { value: 'kostenpflichtig', label: 'Ja, Lizenz nötig' }, { value: 'unklar', label: 'Weiß ich nicht' }] },
      { id: 'vorgesetzt', type: 'approver', label: 'Wer gibt die Lizenz frei?', help: 'Kostenpflichtige Programme braucht eine Freigabe. Die Anfrage geht erst danach an die IT.', placeholder: 'vorname.nachname@…', visibleIf: { field: 'lizenz', op: 'eq', value: 'kostenpflichtig' }, mapping: { target: 'article' } },
    ],
    settings: settings('Software: {{programm}} für {{benutzer.name}}', 'IT-Support', ['software']),
  }, 4);
  forms.berechtigung = addForm(app, zentral, 'berechtigung', 'Berechtigung anfordern', 'Zugänge und Rechte', 'Zugriff auf Laufwerke, Postfächer oder Programme', {
    fields: [
      { id: 'was', type: 'multiselect', label: 'Worauf?', required: true, options: [{ value: 'laufwerk', label: 'Netzlaufwerk' }, { value: 'postfach', label: 'Gemeinsames Postfach' }, { value: 'erp', label: 'Warenwirtschaft' }, { value: 'crm', label: 'CRM' }] },
      { id: 'details', type: 'textarea', label: 'Genaue Bezeichnung', required: true, help: 'z. B. \\\\server\\vertrieb oder vertrieb@firma.de' },
      { id: 'lesen_schreiben', type: 'select', label: 'Rechte', required: true, options: [{ value: 'lesen', label: 'Nur lesen' }, { value: 'schreiben', label: 'Lesen und schreiben' }] },
    ],
    settings: settings('Berechtigung: {{was}} für {{benutzer.name}}', 'IT-Support', ['berechtigung']),
  }, 5);
  forms.nord = addForm(app, nord, 'stoerung', 'Störung melden', 'Störungen', 'Etwas funktioniert nicht', {
    fields: [
      { id: 'betreff', type: 'text', label: 'Kurz zusammengefasst', required: true },
      { id: 'beschreibung', type: 'textarea', label: 'Was genau passiert?', required: true },
      { id: 'standort', type: 'zammad', label: 'Standort', attribute: 'standort', required: true },
    ],
    settings: settings('Störung: {{betreff}}', 'IT-Support', ['stoerung']),
  }, 1);
  // Weiterleitung: die Auswahl bestimmt das Ticketsystem (hier: Standort Nord → IT Nord)
  forms.anfrage = addForm(app, zentral, 'anfrage', 'Allgemeine Anfrage', 'Sonstiges', 'Frage oder Wunsch an die IT – geht automatisch an das zuständige Team', {
    fields: [
      { id: 'team', type: 'select', label: 'Wo arbeiten Sie?', required: true, help: 'Die Anfrage geht direkt an das IT-Team Ihres Standorts.', options: [{ value: 'zentrale', label: 'Zentrale' }, { value: 'nord', label: 'Standort Nord' }],
        mapping: { target: 'system', routes: { nord: { system: nord } } } },
      { id: 'betreff', type: 'text', label: 'Worum geht es?', required: true, maxLength: 120 },
      { id: 'beschreibung', type: 'textarea', label: 'Ihre Frage oder Ihr Wunsch', required: true },
    ],
    settings: settings('Anfrage: {{betreff}}', 'IT-Support', ['anfrage']),
  }, 7);
  // Entwurf, der auf Freigabe wartet (für Screenshots der Admin-Übersicht)
  addForm(app, zentral, 'neuer-mitarbeiter', 'Neue Mitarbeiterin / neuer Mitarbeiter', 'Zugänge und Rechte', 'Arbeitsplatz und Zugänge für neue Kolleginnen und Kollegen', {
    fields: [
      { id: 'name', type: 'text', label: 'Name', required: true },
      { id: 'start', type: 'date', label: 'Erster Arbeitstag', required: true },
      { id: 'standort', type: 'zammad', label: 'Standort', attribute: 'standort', required: true },
    ],
    settings: settings('Neue/r Mitarbeiter/in: {{name}}', 'IT-Support', ['onboarding']),
  }, 6, false);

  // Lokaler Admin mit bekanntem TOTP (nur Demo!) und Rollen für Entra-Gruppen
  const adminId = uuid();
  app.db.run("INSERT INTO users (id, kind, username, email, display_name, department, password_hash, totp_secret, totp_enabled, created_at) VALUES (?, 'local', 'admin', 'it-admin@example.org', 'Portal-Admin', 'IT', ?, ?, 1, ?)",
    adminId, await hashPassword(DEMO_ADMIN_PASSWORD), app.box.encrypt('totp', DEMO_TOTP_SECRET), Date.now());
  const role = (n: string) => app.db.get<{ id: string }>('SELECT id FROM roles WHERE name = ?', n)!.id;
  app.db.run("INSERT INTO role_assignments (id, role_id, subject_type, subject_value, system_id, created_at) VALUES (?, ?, 'user', ?, NULL, ?)", uuid(), role('Super-Admin'), adminId, Date.now());
  app.db.run("INSERT INTO role_assignments (id, role_id, subject_type, subject_value, system_id, created_at) VALUES (?, ?, 'group', 'it-admins', ?, ?)", uuid(), role('Ziel-Admin'), zentral, Date.now());
  app.db.run("INSERT INTO role_assignments (id, role_id, subject_type, subject_value, system_id, created_at) VALUES (?, ?, 'group', 'it-nord', ?, ?)", uuid(), role('Ziel-Admin'), nord, Date.now());
  app.db.run('UPDATE ticket_systems SET visible_groups = ? WHERE id = ?', JSON.stringify(['grp-nord', 'it-admins']), nord);
  return { systems: { zentral, nord }, forms };
}

/** Beispiele für Freigaben durch Vorgesetzte: Anna bittet Alex (den Demo-Admin) um Freigabe und umgekehrt. */
async function seedApprovals(app: App, softwareFormId: string): Promise<void> {
  const anna = toAuthUser(app.db, upsertEntraUser(app.db, { oid: '7e5c1d40-0000-4000-8000-000000000002', tid: TENANT_A, name: 'Anna Becker', email: 'anna.becker@example.org', groups: ['grp-mitarbeiter'] }, { department: 'Vertrieb' }));
  const alex = toAuthUser(app.db, upsertEntraUser(app.db, { oid: '7e5c1d40-0000-4000-8000-000000000001', tid: TENANT_B, name: 'Alex Berger', email: 'alex.berger@example.org', groups: ['grp-mitarbeiter', 'grp-nord', 'it-admins'] }, { department: 'IT' }));
  const form = getForm(app, softwareFormId)!;
  const sys = getSystem(app, form.system_id)!;
  const version = publishedVersion(app, form.id)!;
  const def = JSON.parse(version.definition) as FormDefinition;
  const ask = (who: typeof anna, programm: string, grund: string, approver: string) =>
    submitRequest(app, who, sys, form, version, def, { values: { programm, grund, lizenz: 'kostenpflichtig', vorgesetzt: approver, geraet: 'NB-0042' }, files: {} });
  const actor = (u: typeof anna) => ({ id: u.id, name: u.displayName, ip: '127.0.0.1' });
  const ok = await ask(anna, 'Grafikprogramm', 'Flyer und Plakate für die Messe gestalten.', alex.email!);
  const no = await ask(anna, 'Projektplanung Pro', 'Zeitpläne für zwei Kundenprojekte.', alex.email!);
  await ask(anna, 'PDF-Editor', 'Verträge bearbeiten und unterschreiben, ohne sie auszudrucken.', alex.email!);
  await ask(alex, 'Diagramm-Werkzeug', 'Netzwerkpläne zeichnen.', anna.email!);
  const idOf = (requestId: string) => app.db.get<{ id: string }>('SELECT id FROM approvals WHERE request_id = ?', requestId)!.id;
  decide(app, alex, actor(alex), idOf(ok.id), 'approve', 'Kostenstelle 4711');
  decide(app, alex, actor(alex), idOf(no.id), 'reject', 'Bitte erst mit dem Projektbüro klären – dort gibt es schon Lizenzen.');
}

export async function startDemo(opts: { port?: number; publicUrl?: string; host?: string; dataDir?: string; quiet?: boolean } = {}) {
  const port = opts.port ?? 3000;
  const publicUrl = opts.publicUrl ?? `http://localhost:${port}`;
  // DEMO_HOST=0.0.0.0 macht die Demo im Netz erreichbar (z. B. auf einem Server). Nur zum Testen!
  const listenHost = opts.host ?? '127.0.0.1';
  const dataDir = opts.dataDir ?? join(new URL('..', import.meta.url).pathname, '.data/demo');
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
  setLogLevel(opts.quiet ? 'warn' : 'info');
  const customers = [
    { email: 'alex.berger@example.org', firstname: 'Alex', lastname: 'Berger' },
    { email: 'anna.becker@example.org', firstname: 'Anna', lastname: 'Becker' },
  ];
  const z1 = await startMockZammad({ port: 3101, name: 'Zentrale IT', customers, quiet: opts.quiet });
  const z2 = await startMockZammad({ port: 3102, name: 'IT Nord', customers, quiet: opts.quiet });
  const entra = await startMockEntra([
    { oid: '7e5c1d40-0000-4000-8000-000000000001', tid: TENANT_B, name: 'Alex Berger', email: 'alex.berger@example.org', groups: ['grp-mitarbeiter', 'grp-nord', 'it-admins'] },
    { oid: '7e5c1d40-0000-4000-8000-000000000002', tid: TENANT_A, name: 'Anna Becker', email: 'anna.becker@example.org', groups: ['grp-mitarbeiter'] },
  ], { port: 3103, host: listenHost, publicHost: new URL(publicUrl).hostname });
  const env = process.env.DEMO_ENV === 'production' ? 'production' : 'development';
  process.env.NODE_ENV = env;
  await startFakeClamd(3104);
  const cfg = loadConfig({
    env, port, host: '127.0.0.1', publicUrl, dataDir, secretKey: randomBytes(32),
    trustProxy: ['127.0.0.1/32', '::1/128'], adminAllowedCidrs: [], localLogin: true, localAdminRequireTotp: true,
    entra: { enabled: true, tenantId: TENANT_B, clientId: entra.clientId, clientSecret: entra.clientSecret, allowedTenants: [TENANT_B, TENANT_A], authority: entra.url, graphUrl: entra.url },
    clamav: { host: '127.0.0.1', port: 3104, required: true },
    allowLoopbackTicketUrls: true, // die simulierten Zammad-Instanzen laufen auf 127.0.0.1
  });
  const app = createApp(cfg);
  const seeded = await seedDemo(app, { zentral: z1.url, nord: z2.url });
  await seedApprovals(app, seeded.forms.software);
  app.db.run("UPDATE update_state SET current_version = ?, latest_version = '1.1.0', available = '[\"1.0.0\",\"1.1.0\"]', changelog = ?, checked_at = ?, updater_seen_at = ? WHERE id = 1",
    cfg.version, '1.1.0\n- Beispiel-Eintrag aus dem Changelog\n- Verbesserte Übersichten', Date.now() - 3600_000, Date.now());
  const { server } = createServer(app, { entra: new EntraClient(cfg) });
  const stopWorker = startWorker(app, 1000);
  await new Promise<void>((r) => server.listen(port, listenHost, () => r()));
  writeFileSync(join(dataDir, 'demo.json'), JSON.stringify({ publicUrl, ...seeded }, null, 2));
  if (!opts.quiet) {
    console.log(`\nDemo läuft: ${publicUrl}  (Beenden mit Strg+C)`);
    console.log('„Mit Microsoft anmelden“ meldet ohne Passwort als Alex Berger (Admin) an – alles nur simuliert.');
    console.log(`Lokaler Admin: admin / ${DEMO_ADMIN_PASSWORD} (TOTP-Schlüssel ${DEMO_TOTP_SECRET})`);
    console.log('Microsoft-Anmeldung über den Entra-Simulator: als Alex Berger (Admin-Gruppe) bzw. ?as=… für Anna Becker\n');
  }
  return {
    app, cfg, seeded, z1, z2, entra,
    close: async () => { stopWorker(); await new Promise<void>((r) => server.close(() => r())); await z1.close(); await z2.close(); await entra.close(); app.db.close(); },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await startDemo({ port: Number(process.env.PORT ?? 3000), publicUrl: process.env.PUBLIC_URL, host: process.env.DEMO_HOST });
}
