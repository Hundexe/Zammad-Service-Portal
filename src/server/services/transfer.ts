// Export und Import der Ticketsysteme mit allem, was dazugehört: Verbindung, freigegebene Zammad-Objekte,
// Formulare mit allen Versionen, Vorlagen, Übersichten, Stil/Farben/Logos.
//
// Nicht enthalten: Benutzer, Rollen, Anfragen, Audit-Log, Sitzungen.
// Die Zammad-API-Tokens kommen nur mit, wenn beim Export ein Passwort gesetzt wird. Sie werden dann mit einem
// daraus abgeleiteten Schlüssel (scrypt, AES-256-GCM) verschlüsselt. Ohne Passwort enthält die Datei keine Geheimnisse.
//
// Import = „alles ersetzen“: Das Zielsystem hat danach genau die Ticketsysteme der Datei. Ticketsysteme mit gleichem
// Kürzel behalten ihre interne ID (Rollen-Zuordnungen und alte Anfragen bleiben gültig), ihr Inhalt wird ersetzt.
// Ticketsysteme, die nicht in der Datei stehen, werden gelöscht. Alles läuft in einer Transaktion: entweder ganz oder gar nicht.
import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import type { App } from '../app.ts';
import { parseJson, uuid } from '../db/db.ts';
import { hashSemaphore, sha256 } from '../crypto.ts';
import { HttpError } from '../http/core.ts';
import { validateDefinition, isProtectedZammadField, type FormDefinition } from '../../shared/form.ts';
import { DEFAULT_BRANDING, validateBranding } from '../../shared/branding.ts';
import { templateHtmlProblems } from '../../shared/template.ts';
import { checkLogo, decodeBase64Strict, removeRequestFiles } from './files.ts';
import { listSystems, validateSystemUrl, type SystemRow } from './systems.ts';
import { audit, type Actor } from './audit.ts';

export const EXPORT_FORMAT = 'zammad-service-portal-export';
export const EXPORT_FORMAT_VERSION = 1;
export const EXPORT_PASSWORD_MIN = 12;
const OVERVIEW_COLUMNS = ['number', 'title', 'state', 'priority', 'group', 'created_at', 'updated_at'];
const SLUG = /^[a-z0-9][a-z0-9-]{0,47}$/;
const KDF = { N: 2 ** 17, r: 8, p: 1 };
const LOGO_FIELDS = { logoLightId: 'logo', logoDarkId: 'logo', logoNavDarkId: 'logo', faviconId: 'favicon' } as const;

interface Sealed { iv: string; tag: string; data: string }
type Json = any;

/** Asynchron und über dieselbe Begrenzung wie die Anmelde-Hashes (blockiert den Server nicht, begrenzt den Speicher). */
function kdfKey(password: string, salt: Buffer, p: typeof KDF): Promise<Buffer> {
  return hashSemaphore.run(() => new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, 32, { N: p.N, r: p.r, p: p.p, maxmem: 256 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key)));
  }));
}
function seal(key: Buffer, aad: string, plain: string): Sealed {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad));
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
}
function unseal(key: Buffer, aad: string, s: Sealed): string {
  const tag = Buffer.from(String(s.tag), 'base64');
  if (tag.length !== 16) throw new Error('Ungültiges Chiffrat');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(String(s.iv), 'base64'), { authTagLength: 16 });
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(Buffer.from(String(s.data), 'base64')), d.final()]).toString('utf8');
}

// ---------------------------------------------------------------- Export

export async function buildExport(app: App, password?: string): Promise<Json> {
  if (password !== undefined && password.length < EXPORT_PASSWORD_MIN) {
    throw new HttpError(422, `Das Export-Passwort braucht mindestens ${EXPORT_PASSWORD_MIN} Zeichen`, 'validation', { password: 'zu kurz' });
  }
  let key: Buffer | null = null;
  let tokens: Json = null;
  if (password) {
    const salt = randomBytes(16);
    key = await kdfKey(password, salt, KDF);
    tokens = { kdf: 'scrypt', ...KDF, salt: salt.toString('base64'), check: seal(key, 'check', EXPORT_FORMAT) };
  }
  const assets: Json[] = [];
  const assetRef = new Map<string, string>();
  const ref = (id: unknown, kind: 'logo' | 'favicon'): string | null => {
    if (typeof id !== 'string' || !id) return null;
    if (assetRef.has(id)) return assetRef.get(id)!;
    const a = app.db.get<{ mime: string; data: Uint8Array }>('SELECT mime, data FROM assets WHERE id = ?', id);
    if (!a) return null;
    const r = `asset-${assets.length + 1}`;
    assets.push({ ref: r, kind, mime: a.mime, data: Buffer.from(a.data).toString('base64') });
    assetRef.set(id, r);
    return r;
  };

  const systems = listSystems(app).map((s) => {
    const branding = app.db.all<{ version: number; data: string; status: string; created_at: number; published_at: number | null }>(
      'SELECT version, data, status, created_at, published_at FROM branding_versions WHERE system_id = ? ORDER BY version', s.id,
    ).map((b) => {
      const data = parseJson<Record<string, unknown>>(b.data, {});
      for (const [f, kind] of Object.entries(LOGO_FIELDS)) if (f in data) data[f] = ref(data[f], kind);
      return { version: b.version, status: b.status, data, createdAt: b.created_at, publishedAt: b.published_at };
    });
    const forms = app.db.all<{ id: string; slug: string; name: string; description: string; category: string; visible_groups: string; sort: number; active: number }>(
      'SELECT * FROM forms WHERE system_id = ? ORDER BY sort, name', s.id,
    ).map((f) => ({
      slug: f.slug, name: f.name, description: f.description, category: f.category, visibleGroups: parseJson<string[]>(f.visible_groups, []), sort: f.sort, active: f.active === 1,
      versions: app.db.all<{ version: number; definition: string; status: string; note: string; created_at: number; published_at: number | null }>(
        'SELECT version, definition, status, note, created_at, published_at FROM form_versions WHERE form_id = ? ORDER BY version', f.id,
      ).map((v) => ({ version: v.version, status: v.status, note: v.note, definition: portableRoutes(app, parseJson(v.definition, null)), createdAt: v.created_at, publishedAt: v.published_at })),
    }));
    const token = key && s.api_token ? seal(key, `token:${s.slug}`, app.box.decrypt('system-token', s.api_token)) : null;
    return {
      slug: s.slug, name: s.name, baseUrl: s.base_url, apiToken: token, defaultGroup: s.default_group, creationMode: s.creation_mode, status: s.status,
      visibleGroups: parseJson<string[]>(s.visible_groups, []), requireApproval: s.require_approval === 1, showOrgTickets: s.show_org_tickets === 1,
      allowReplies: s.allow_replies === 1, closedStates: parseJson<string[]>(s.closed_states, []), portalTag: s.portal_tag, sort: s.sort,
      allowedGroups: parseJson<string[]>(s.allowed_groups, []), hideAgentNames: s.hide_agent_names === 1,
      releasedAttributes: parseJson<unknown[]>(s.released_attributes, []),
      branding, forms,
      templates: app.db.all<{ kind: string; name: string; content: string }>('SELECT kind, name, content FROM templates WHERE system_id = ? ORDER BY kind, name', s.id),
      overviews: app.db.all<{ name: string; state_filter: string; columns: string; sort_by: string; sort_dir: string; sort: number }>(
        'SELECT name, state_filter, columns, sort_by, sort_dir, sort FROM overviews WHERE system_id = ? ORDER BY sort, name', s.id,
      ).map((o) => ({ name: o.name, stateFilter: o.state_filter, columns: parseJson<string[]>(o.columns, []), sortBy: o.sort_by, sortDir: o.sort_dir, sort: o.sort })),
      // Services (Status-Seite); Formulare verweisen in der Datei über den Namen darauf
      services: app.db.all<{ name: string; description: string; sort: number }>('SELECT name, description, sort FROM services WHERE system_id = ? ORDER BY sort, name', s.id),
    };
  });
  return {
    format: EXPORT_FORMAT, formatVersion: EXPORT_FORMAT_VERSION, portalVersion: app.cfg.version, createdAt: new Date().toISOString(),
    tokens, assets, systems,
  };
}

/** Gleicher Ursprung (Schema, Host, Port)? undefined, wenn eine Adresse ungültig ist. */
export function sameOrigin(a: string, b: string): boolean | undefined {
  try { return new URL(a).origin === new URL(b).origin; } catch { return undefined; }
}

// ---------------------------------------------------------------- Import: prüfen

interface Asset { ref: string; kind: 'logo' | 'favicon'; mime: string; data: Buffer; sha: string }
interface PlannedSystem {
  slug: string; name: string; existingId: string | null;
  row: Record<string, string | number | null>; token: string | null; tokenFromFile: boolean;
  /** Adresse geändert und kein Token in der Datei: vorhandenes Token verwerfen (nie an eine neue Adresse senden) */
  dropToken: boolean; previousUrl: string | null;
  released: string; branding: { version: number; status: string; data: Record<string, unknown>; createdAt: number; publishedAt: number | null }[];
  forms: { slug: string; name: string; description: string; category: string; visibleGroups: string; sort: number; active: number; versions: { version: number; status: string; note: string; definition: string; createdAt: number; publishedAt: number | null }[] }[];
  templates: { kind: string; name: string; content: string }[];
  overviews: { name: string; stateFilter: string; columns: string; sortBy: string; sortDir: string; sort: number }[];
  services: { name: string; description: string; sort: number }[];
}
export interface ImportPlan {
  systems: PlannedSystem[];
  remove: { id: string; slug: string; name: string; requests: number }[];
  assets: Asset[];
  warnings: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isTime = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : Date.now();

export async function planImport(app: App, file: unknown, password?: string): Promise<ImportPlan> {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isObj(file) || file.format !== EXPORT_FORMAT) throw new HttpError(422, 'Das ist keine Export-Datei des Self-Service-Portals', 'validation');
  if (file.formatVersion !== EXPORT_FORMAT_VERSION) throw new HttpError(422, `Export-Format ${String(file.formatVersion)} wird nicht unterstützt (erwartet ${EXPORT_FORMAT_VERSION})`, 'validation');
  if (!Array.isArray(file.systems) || file.systems.length > 100) throw new HttpError(422, 'Liste der Ticketsysteme fehlt oder ist zu lang', 'validation');

  // Schlüssel für die Tokens
  let key: Buffer | null = null;
  const t = file.tokens;
  if (t !== null && t !== undefined) {
    if (!isObj(t) || t.kdf !== 'scrypt' || t.N !== KDF.N || t.r !== KDF.r || t.p !== KDF.p || typeof t.salt !== 'string' || !isObj(t.check)) {
      throw new HttpError(422, 'Verschlüsselung der Datei wird nicht unterstützt', 'validation');
    }
    if (!password) throw new HttpError(422, 'Diese Datei enthält verschlüsselte Zammad-Tokens – bitte das Export-Passwort eingeben', 'validation', { password: 'Pflichtfeld' });
    key = await kdfKey(password, Buffer.from(t.salt, 'base64'), KDF);
    try {
      if (unseal(key, 'check', t.check as unknown as Sealed) !== EXPORT_FORMAT) throw new Error('x');
    } catch {
      throw new HttpError(422, 'Das Export-Passwort ist falsch', 'validation', { password: 'falsch' });
    }
  }

  // Logos und Favicons: Inhalt wie beim Hochladen prüfen
  const assets: Asset[] = [];
  if (!Array.isArray(file.assets ?? []) || (file.assets as unknown[] ?? []).length > 300) throw new HttpError(422, 'Logos ungültig', 'validation');
  for (const a of (file.assets as unknown[] ?? [])) {
    if (!isObj(a) || typeof a.ref !== 'string' || !/^asset-\d{1,4}$/.test(a.ref) || (a.kind !== 'logo' && a.kind !== 'favicon')) { errors.push('Logo: Eintrag ungültig'); continue; }
    try {
      const { mime, data } = checkLogo(decodeBase64Strict(a.data), a.kind);
      assets.push({ ref: a.ref, kind: a.kind, mime, data, sha: sha256(data) });
    } catch (err) {
      errors.push(`Logo ${a.ref}: ${(err as Error).message}`);
    }
  }
  const assetRefs = new Map(assets.map((a) => [a.ref, a]));

  const slugs = new Set<string>();
  const systems: PlannedSystem[] = [];
  for (const [i, raw] of (file.systems as unknown[]).entries()) {
    const where = `Ticketsystem ${i + 1}`;
    if (!isObj(raw)) { errors.push(`${where}: ungültig`); continue; }
    const s = raw;
    const sl = typeof s.slug === 'string' ? s.slug.toLowerCase() : '';
    if (!SLUG.test(sl)) { errors.push(`${where}: Kürzel ungültig`); continue; }
    if (slugs.has(sl)) { errors.push(`${where}: Kürzel „${sl}“ doppelt`); continue; }
    slugs.add(sl);
    const w = `Ticketsystem „${sl}“`;
    const str = (k: string, max: number, def = ''): string => {
      const v = s[k];
      if (v === undefined || v === null || v === '') return def;
      if (typeof v !== 'string' || v.length > max) { errors.push(`${w}: ${k} ungültig`); return def; }
      return v.trim();
    };
    const list = (v: unknown, k: string, maxItems = 200, maxLen = 200): string[] => {
      if (v === undefined || v === null) return [];
      if (!Array.isArray(v) || v.length > maxItems || v.some((x) => typeof x !== 'string' || x.length > maxLen)) { errors.push(`${w}: ${k} ungültig`); return []; }
      return [...new Set((v as string[]).map((x) => x.trim()).filter(Boolean))];
    };
    const flag = (k: string, def: boolean): number => (s[k] === undefined ? def : s[k] === true) ? 1 : 0;
    const name = str('name', 80);
    if (!name) errors.push(`${w}: Name fehlt`);
    const baseUrl = str('baseUrl', 500).replace(/\/+$/, '');
    const urlProblem = await validateSystemUrl(app, baseUrl);
    if (urlProblem) errors.push(`${w}: Zammad-Adresse – ${urlProblem}`);
    const mode = str('creationMode', 20, 'on_behalf_of');
    if (!['on_behalf_of', 'customer_field'].includes(mode)) errors.push(`${w}: Anlage-Modus ungültig`);
    let status = str('status', 20, 'active');
    if (!['active', 'maintenance', 'inactive'].includes(status)) errors.push(`${w}: Status ungültig`);
    const portalTag = str('portalTag', 60, 'service-portal');
    if (!/^[\p{L}\p{N}_.\- ]{1,60}$/u.test(portalTag)) errors.push(`${w}: Tag ungültig`);
    const allowed = list(s.allowedGroups, 'allowedGroups', 200, 160);
    const defaultGroup = str('defaultGroup', 160) || null;
    if (defaultGroup && allowed.length && !allowed.includes(defaultGroup)) errors.push(`${w}: Standardgruppe steht nicht in den erlaubten Gruppen`);
    const closed = list(s.closedStates, 'closedStates', 50, 80);
    const sort = typeof s.sort === 'number' && Number.isInteger(s.sort) && Math.abs(s.sort) <= 100000 ? s.sort : 0;

    // Freigegebene Zammad-Objekte: Aufbau prüfen (ob es sie im Ziel-Zammad gibt, zeigt die Verwaltung danach)
    const released: { name: string; allowedValues: string[] | null }[] = [];
    if (!Array.isArray(s.releasedAttributes) || s.releasedAttributes.length > 200) errors.push(`${w}: Zammad-Objekte ungültig`);
    else for (const r of s.releasedAttributes) {
      const n = isObj(r) && typeof r.name === 'string' ? r.name : '';
      if (!/^[a-z][a-z0-9_]{0,60}$/.test(n) || isProtectedZammadField(n)) { errors.push(`${w}: Zammad-Objekt „${n}“ nicht erlaubt`); continue; }
      const av = (r as Json).allowedValues;
      if (av !== null && av !== undefined && (!Array.isArray(av) || av.length > 500 || av.some((x: unknown) => typeof x !== 'string' || x.length > 300))) { errors.push(`${w}: Werte von „${n}“ ungültig`); continue; }
      released.push({ name: n, allowedValues: Array.isArray(av) ? av : null });
    }

    // Token
    let token: string | null = null;
    if (s.apiToken !== null && s.apiToken !== undefined) {
      if (!key) errors.push(`${w}: Token ohne Verschlüsselungsangaben`);
      else if (!isObj(s.apiToken)) errors.push(`${w}: Token ungültig`);
      else {
        try {
          token = unseal(key, `token:${sl}`, s.apiToken as unknown as Sealed);
          if (!token || token.length > 500) throw new Error('x');
        } catch { errors.push(`${w}: Token lässt sich nicht entschlüsseln`); token = null; }
      }
    }
    const existing = app.db.get<SystemRow>('SELECT * FROM ticket_systems WHERE slug = ?', sl);
    let dropToken = false;
    if (!token && !existing?.api_token) {
      warnings.push(`${w}: kein Zammad-Token in der Datei – das System wird deaktiviert angelegt, bitte Token unter „Verbindung“ eintragen`);
      status = 'inactive';
    } else if (!token && existing && sameOrigin(existing.base_url, baseUrl) === false) {
      // Nie das vorhandene Token an eine andere Adresse schicken (sonst gelangt es an deren Betreiber)
      warnings.push(`${w}: Adresse ändert sich (${existing.base_url} → ${baseUrl}) und die Datei enthält kein Token – das System wird ohne Token und deaktiviert übernommen, bitte Token neu eintragen`);
      status = 'inactive';
      dropToken = true;
    } else if (!token) {
      warnings.push(`${w}: kein Token in der Datei – das vorhandene Token des Zielsystems bleibt`);
    }

    // Stil und Logos
    const branding: PlannedSystem['branding'] = [];
    const bVersions = new Set<number>();
    if (!Array.isArray(s.branding) || s.branding.length > 500) errors.push(`${w}: Stil/Farben ungültig`);
    else for (const b of s.branding) {
      if (!isObj(b) || !Number.isInteger(b.version) || (b.version as number) < 1 || bVersions.has(b.version as number) || !['draft', 'pending', 'published', 'archived'].includes(String(b.status)) || !isObj(b.data)) {
        errors.push(`${w}: Stil-Version ungültig`); continue;
      }
      bVersions.add(b.version as number);
      const data = { ...b.data };
      for (const f of Object.keys(LOGO_FIELDS)) {
        if (data[f] === null || data[f] === undefined) { data[f] = null; continue; }
        const a = assetRefs.get(String(data[f]));
        if (!a || a.kind !== LOGO_FIELDS[f as keyof typeof LOGO_FIELDS]) { errors.push(`${w}: Stil-Version ${b.version}: Logo „${String(data[f])}“ fehlt`); data[f] = null; continue; }
        // Platzhalter-ID für die Prüfung; beim Import wird die echte ID eingesetzt
        data[f] = '00000000-0000-4000-8000-000000000000';
      }
      const v = validateBranding(data);
      if (!v.branding) { errors.push(`${w}: Stil-Version ${b.version}: ${v.errors.join(', ')}`); continue; }
      const out: Record<string, unknown> = { ...v.branding };
      for (const f of Object.keys(LOGO_FIELDS)) out[f] = b.data[f] ?? null; // Verweis auf asset-N, wird beim Import aufgelöst
      branding.push({ version: b.version as number, status: String(b.status), data: out, createdAt: isTime(b.createdAt), publishedAt: typeof b.publishedAt === 'number' ? b.publishedAt : null });
    }
    if (!branding.some((b) => b.status === 'published')) {
      // Ohne veröffentlichten Stil zeigt das Portal das System nicht richtig an: Standard dazunehmen
      branding.push({ version: Math.max(0, ...branding.map((b) => b.version)) + 1, status: 'published', data: { ...DEFAULT_BRANDING, displayName: name || sl }, createdAt: Date.now(), publishedAt: Date.now() });
    }
    if (branding.filter((b) => b.status === 'published').length > 1) errors.push(`${w}: mehr als eine veröffentlichte Stil-Version`);

    // Formulare
    const forms: PlannedSystem['forms'] = [];
    const fSlugs = new Set<string>();
    if (!Array.isArray(s.forms) || s.forms.length > 500) errors.push(`${w}: Formulare ungültig`);
    else for (const f of s.forms) {
      const fs = isObj(f) && typeof f.slug === 'string' ? f.slug.toLowerCase() : '';
      if (!SLUG.test(fs) || fSlugs.has(fs)) { errors.push(`${w}: Formular-Kürzel „${fs}“ ungültig oder doppelt`); continue; }
      fSlugs.add(fs);
      const fw = `${w}, Formular „${fs}“`;
      const ff = f as Record<string, unknown>;
      const fname = typeof ff.name === 'string' ? ff.name.trim() : '';
      if (!fname || fname.length > 120) errors.push(`${fw}: Name fehlt oder zu lang`);
      const desc = typeof ff.description === 'string' ? ff.description : '';
      const cat = typeof ff.category === 'string' ? ff.category : '';
      if (desc.length > 1000 || cat.length > 80) errors.push(`${fw}: Beschreibung oder Kategorie zu lang`);
      const vg = Array.isArray(ff.visibleGroups) && ff.visibleGroups.length <= 100 && ff.visibleGroups.every((x) => typeof x === 'string' && x.length <= 200) ? ff.visibleGroups as string[] : (errors.push(`${fw}: Gruppen ungültig`), []);
      const versions: PlannedSystem['forms'][number]['versions'] = [];
      const vn = new Set<number>();
      if (!Array.isArray(ff.versions) || ff.versions.length === 0 || ff.versions.length > 1000) errors.push(`${fw}: Versionen fehlen`);
      else for (const v of ff.versions) {
        if (!isObj(v) || !Number.isInteger(v.version) || (v.version as number) < 1 || vn.has(v.version as number) || !['draft', 'pending', 'published', 'archived'].includes(String(v.status))) {
          errors.push(`${fw}: Version ungültig`); continue;
        }
        vn.add(v.version as number);
        const problems = validateDefinition(v.definition);
        if (problems.length) { errors.push(`${fw}, Version ${v.version}: ${problems.slice(0, 3).join('; ')}`); continue; }
        const note = typeof v.note === 'string' ? v.note.slice(0, 500) : '';
        versions.push({ version: v.version as number, status: String(v.status), note, definition: JSON.stringify(v.definition as FormDefinition), createdAt: isTime(v.createdAt), publishedAt: typeof v.publishedAt === 'number' ? v.publishedAt : null });
      }
      if (versions.filter((v) => v.status === 'published').length > 1) errors.push(`${fw}: mehr als eine veröffentlichte Version`);
      if (versions.filter((v) => v.status === 'draft' || v.status === 'pending').length > 1) errors.push(`${fw}: mehr als ein Entwurf`);
      forms.push({
        slug: fs, name: fname, description: desc, category: cat, visibleGroups: JSON.stringify(vg),
        sort: typeof ff.sort === 'number' && Number.isInteger(ff.sort) ? ff.sort : 0, active: ff.active === false ? 0 : 1, versions,
      });
    }

    // Vorlagen und Übersichten
    const templates: PlannedSystem['templates'] = [];
    if (!Array.isArray(s.templates) || s.templates.length > 500) errors.push(`${w}: Vorlagen ungültig`);
    else for (const tp of s.templates) {
      if (!isObj(tp) || !['title', 'body', 'success'].includes(String(tp.kind)) || typeof tp.name !== 'string' || !tp.name.trim() || tp.name.length > 120
        || typeof tp.content !== 'string' || tp.content.length > (tp.kind === 'body' ? 20000 : 1000)) { errors.push(`${w}: Vorlage ungültig`); continue; }
      if (tp.kind === 'body') { const pr = templateHtmlProblems(tp.content); if (pr.length) { errors.push(`${w}: Vorlage „${tp.name.trim()}“: ${pr.join('; ')}`); continue; } }
      templates.push({ kind: String(tp.kind), name: tp.name.trim(), content: tp.content });
    }
    const overviews: PlannedSystem['overviews'] = [];
    if (!Array.isArray(s.overviews) || s.overviews.length > 50) errors.push(`${w}: Übersichten ungültig`);
    else for (const o of s.overviews) {
      const cols = isObj(o) && Array.isArray(o.columns) ? o.columns : [];
      if (!isObj(o) || typeof o.name !== 'string' || !o.name.trim() || o.name.length > 80 || !['open', 'closed', 'all'].includes(String(o.stateFilter))
        || !cols.length || cols.length > 10 || cols.some((c) => !OVERVIEW_COLUMNS.includes(String(c))) || !OVERVIEW_COLUMNS.includes(String(o.sortBy ?? 'updated_at'))
        || !['asc', 'desc'].includes(String(o.sortDir ?? 'desc'))) { errors.push(`${w}: Übersicht ungültig`); continue; }
      overviews.push({ name: o.name.trim(), stateFilter: String(o.stateFilter), columns: JSON.stringify(cols), sortBy: String(o.sortBy ?? 'updated_at'), sortDir: String(o.sortDir ?? 'desc'), sort: typeof o.sort === 'number' && Number.isInteger(o.sort) ? o.sort : 0 });
    }

    const services: PlannedSystem['services'] = [];
    if (s.services !== undefined) {
      if (!Array.isArray(s.services) || s.services.length > 200) errors.push(`${w}: Services ungültig`);
      else for (const x of s.services) {
        if (!isObj(x) || typeof x.name !== 'string' || !x.name.trim() || x.name.length > 120 || (x.description !== undefined && (typeof x.description !== 'string' || x.description.length > 1000))) { errors.push(`${w}: Service ungültig`); continue; }
        const name = (x.name as string).trim();
        if (services.some((y) => y.name.toLowerCase() === name.toLowerCase())) continue;
        services.push({ name, description: typeof x.description === 'string' ? x.description : '', sort: typeof x.sort === 'number' && Number.isInteger(x.sort) ? x.sort : 0 });
      }
    }
    systems.push({
      slug: sl, name, existingId: existing?.id ?? null, token, tokenFromFile: Boolean(token), dropToken, previousUrl: existing?.base_url ?? null, services,
      row: {
        name, base_url: baseUrl, default_group: defaultGroup, creation_mode: mode, status, visible_groups: JSON.stringify(list(s.visibleGroups, 'visibleGroups')),
        require_approval: flag('requireApproval', false), show_org_tickets: flag('showOrgTickets', false), allow_replies: flag('allowReplies', true),
        closed_states: JSON.stringify(closed.length ? closed : ['closed', 'merged', 'removed']), portal_tag: portalTag, sort,
        allowed_groups: JSON.stringify(allowed), hide_agent_names: flag('hideAgentNames', false),
      },
      released: JSON.stringify(released), branding, forms, templates, overviews,
    });
  }
  if (systems.length === 0 && !errors.length) errors.push('Die Datei enthält kein Ticketsystem');

  // Was im Zielsystem wegfällt
  const remove = listSystems(app).filter((s) => !slugs.has(s.slug)).map((s) => {
    const open = app.db.get<{ n: number }>("SELECT COUNT(*) n FROM requests WHERE system_id = ? AND status IN ('queued', 'sending', 'awaiting_approval')", s.id)!.n;
    if (open) errors.push(`Ticketsystem „${s.slug}“ würde gelöscht, hat aber noch ${open} offene Anfrage(n) (Zustellung oder Freigabe) – erst abwarten oder abbrechen`);
    return { id: s.id, slug: s.slug, name: s.name, requests: app.db.get<{ n: number }>('SELECT COUNT(*) n FROM requests WHERE system_id = ?', s.id)!.n };
  });
  if (errors.length) throw new HttpError(422, 'Die Datei kann nicht importiert werden', 'validation', errors.slice(0, 50));
  return { systems, remove, assets, warnings };
}

/** Zusammenfassung für die Vorschau (ohne Inhalte und Geheimnisse). */
export function summarizePlan(plan: ImportPlan) {
  return {
    systems: plan.systems.map((s) => ({
      slug: s.slug, name: s.name, action: s.existingId ? 'replace' : 'create', token: s.tokenFromFile,
      baseUrl: s.row.base_url, previousUrl: s.previousUrl, urlChanged: s.previousUrl !== null && s.previousUrl !== s.row.base_url, tokenDropped: s.dropToken,
      forms: s.forms.length, templates: s.templates.length, overviews: s.overviews.length, services: s.services.length, brandingVersions: s.branding.length, releasedAttributes: JSON.parse(s.released).length,
    })),
    remove: plan.remove.map((r) => ({ slug: r.slug, name: r.name, requests: r.requests })),
    assets: plan.assets.length,
    warnings: plan.warnings,
  };
}

// ---------------------------------------------------------------- Import: ausführen

export function applyImport(app: App, plan: ImportPlan, actor: Actor): ReturnType<typeof summarizePlan> {
  const t = Date.now();
  const removedRequests: string[] = [];
  app.db.tx(() => {
    // Logos: gleicher Inhalt wird wiederverwendet
    const assetIds = new Map<string, string>();
    for (const a of plan.assets) {
      const same = app.db.get<{ id: string }>('SELECT id FROM assets WHERE sha256 = ? AND kind = ?', a.sha, a.kind);
      const id = same?.id ?? uuid();
      if (!same) app.db.run('INSERT INTO assets (id, kind, mime, size, sha256, data, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, a.kind, a.mime, a.data.length, a.sha, a.data, actor.id ?? null, t);
      assetIds.set(a.ref, id);
    }

    for (const r of plan.remove) {
      for (const q of app.db.all<{ id: string }>('SELECT id FROM requests WHERE system_id = ?', r.id)) removedRequests.push(q.id);
      app.db.run('DELETE FROM requests WHERE system_id = ?', r.id);
      app.db.run('DELETE FROM ticket_systems WHERE id = ?', r.id);
    }

    for (const s of plan.systems) {
      const v = s.row;
      let id = s.existingId;
      if (id) {
        const before = app.db.get<SystemRow>('SELECT * FROM ticket_systems WHERE id = ?', id)!;
        const token = s.token ? app.box.encrypt('system-token', s.token) : s.dropToken ? null : before.api_token;
        app.db.run(
          `UPDATE ticket_systems SET name = ?, base_url = ?, api_token = ?, default_group = ?, creation_mode = ?, status = ?, visible_groups = ?, require_approval = ?,
            show_org_tickets = ?, allow_replies = ?, closed_states = ?, portal_tag = ?, sort = ?, allowed_groups = ?, hide_agent_names = ?, released_attributes = ?, updated_at = ? WHERE id = ?`,
          v.name, v.base_url, token, v.default_group, v.creation_mode, v.status, v.visible_groups, v.require_approval, v.show_org_tickets, v.allow_replies,
          v.closed_states, v.portal_tag, v.sort, v.allowed_groups, v.hide_agent_names, s.released, t, id,
        );
        if (before.base_url !== v.base_url || s.token) {
          app.db.run('DELETE FROM zammad_customers WHERE system_id = ?', id);
        }
        app.db.run('DELETE FROM system_metadata WHERE system_id = ?', id);
        app.db.run('DELETE FROM branding_versions WHERE system_id = ?', id);
        app.db.run('DELETE FROM templates WHERE system_id = ?', id);
        app.db.run('DELETE FROM overviews WHERE system_id = ?', id);
      } else {
        id = uuid();
        app.db.run(
          `INSERT INTO ticket_systems (id, slug, name, type, base_url, api_token, default_group, creation_mode, status, visible_groups, require_approval, show_org_tickets,
             allow_replies, closed_states, portal_tag, sort, allowed_groups, hide_agent_names, released_attributes, created_at, updated_at)
           VALUES (?, ?, ?, 'zammad', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id, s.slug, v.name, v.base_url, s.token ? app.box.encrypt('system-token', s.token) : null, v.default_group, v.creation_mode, v.status, v.visible_groups,
          v.require_approval, v.show_org_tickets, v.allow_replies, v.closed_states, v.portal_tag, v.sort, v.allowed_groups, v.hide_agent_names, s.released, t, t,
        );
      }
      for (const b of s.branding) {
        const data = { ...b.data };
        for (const f of Object.keys(LOGO_FIELDS)) data[f] = data[f] ? assetIds.get(String(data[f])) ?? null : null;
        app.db.run('INSERT INTO branding_versions (id, system_id, version, data, status, created_by, created_at, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          uuid(), id, b.version, JSON.stringify(data), b.status, actor.id ?? null, b.createdAt, b.publishedAt);
      }
      // Services: gleicher Name bleibt (Störungen behalten ihre Zuordnung), neue kommen dazu, fehlende werden gelöscht
      const svcIds = new Map<string, string>();
      for (const ex of app.db.all<{ id: string; name: string }>('SELECT id, name FROM services WHERE system_id = ?', id)) {
        const f = s.services.find((x) => x.name.toLowerCase() === ex.name.toLowerCase());
        if (!f) { app.db.run('DELETE FROM services WHERE id = ?', ex.id); continue; }
        app.db.run('UPDATE services SET description = ?, sort = ?, updated_at = ? WHERE id = ?', f.description, f.sort, t, ex.id);
        svcIds.set(f.name.toLowerCase(), ex.id);
      }
      for (const f of s.services) {
        if (svcIds.has(f.name.toLowerCase())) continue;
        const sid = uuid();
        app.db.run('INSERT INTO services (id, system_id, name, description, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', sid, id, f.name, f.description, f.sort, t, t);
        svcIds.set(f.name.toLowerCase(), sid);
      }
      const withServices = (json: string) => {
        const d = JSON.parse(json) as FormDefinition;
        if (!Array.isArray(d.settings?.services)) return json;
        const ids = d.settings.services.map((x) => svcIds.get(String(x).toLowerCase())).filter((x): x is string => Boolean(x));
        d.settings.services = ids.length ? [...new Set(ids)] : undefined;
        return JSON.stringify(d);
      };
      // Formulare: gleiches Kürzel behält seine ID, Versionen werden ersetzt; Formulare, die fehlen, werden gelöscht
      const keep = new Set(s.forms.map((f) => f.slug));
      for (const old of app.db.all<{ id: string; slug: string }>('SELECT id, slug FROM forms WHERE system_id = ?', id)) {
        if (!keep.has(old.slug)) app.db.run('DELETE FROM forms WHERE id = ?', old.id);
      }
      for (const f of s.forms) {
        const ex = app.db.get<{ id: string }>('SELECT id FROM forms WHERE system_id = ? AND slug = ?', id, f.slug);
        const fid = ex?.id ?? uuid();
        if (ex) {
          app.db.run('UPDATE forms SET name = ?, description = ?, category = ?, visible_groups = ?, sort = ?, active = ?, updated_at = ? WHERE id = ?',
            f.name, f.description, f.category, f.visibleGroups, f.sort, f.active, t, fid);
          app.db.run('DELETE FROM form_versions WHERE form_id = ?', fid);
        } else {
          app.db.run('INSERT INTO forms (id, system_id, slug, name, description, category, visible_groups, sort, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            fid, id, f.slug, f.name, f.description, f.category, f.visibleGroups, f.sort, f.active, t, t);
        }
        for (const v2 of f.versions) {
          app.db.run('INSERT INTO form_versions (id, form_id, version, definition, status, note, created_by, created_at, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            uuid(), fid, v2.version, withServices(v2.definition), v2.status, v2.note, actor.id ?? null, v2.createdAt, v2.publishedAt);
        }
      }
      for (const tp of s.templates) {
        app.db.run('INSERT INTO templates (id, system_id, kind, name, content, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', uuid(), id, tp.kind, tp.name, tp.content, t, t, actor.id ?? null);
      }
      for (const o of s.overviews) {
        app.db.run('INSERT INTO overviews (id, system_id, name, state_filter, columns, sort_by, sort_dir, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          uuid(), id, o.name, o.stateFilter, o.columns, o.sortBy, o.sortDir, o.sort, t, t);
      }
    }
    audit(app.db, actor, { action: 'transfer.imported', targetType: 'portal', details: summarizePlan(plan) });
  });
  for (const id of removedRequests) removeRequestFiles(app, id);
  return summarizePlan(plan);
}

/** Weiterleitungen tragen in der Datei das Kürzel des Ziels statt der ID – IDs sind je Installation verschieden. */
export function portableRoutes(app: App, def: FormDefinition | null): FormDefinition | null {
  if (!def || !Array.isArray(def.fields)) return def;
  if (Array.isArray(def.settings?.services)) {
    def.settings.services = def.settings.services.map((id) => app.db.get<{ name: string }>('SELECT name FROM services WHERE id = ?', id)?.name ?? id);
  }
  for (const f of def.fields) {
    const routes = f?.mapping?.target === 'system' ? f.mapping.routes : undefined;
    if (!routes) continue;
    for (const r of Object.values(routes)) {
      const slug = app.db.get<{ slug: string }>('SELECT slug FROM ticket_systems WHERE id = ?', r.system)?.slug;
      if (slug) r.system = slug;
    }
  }
  return def;
}
