// Konfiguration aus Umgebungsvariablen. Geheimnisse werden bevorzugt aus Dateien
// gelesen (VAR_FILE), wie es Docker Secrets vorsehen.
import { existsSync, readFileSync } from 'node:fs';
import { isIP } from 'node:net';

function readSecret(name: string): string | undefined {
  const file = process.env[`${name}_FILE`];
  if (file) {
    try {
      return readFileSync(file, 'utf8').trim();
    } catch (err) {
      throw new Error(`Secret-Datei für ${name} nicht lesbar: ${file} (${(err as Error).message})`);
    }
  }
  const v = process.env[name];
  return v === undefined || v === '' ? undefined : v;
}

function bool(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'ja', 'on'].includes(v.toLowerCase());
}

function int(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`${name} muss eine Zahl sein`);
  return n;
}

/** Zahl mit erlaubtem Bereich. Liegt ein Wert außerhalb, startet das Portal nicht (sicherer als stilles Korrigieren). */
function range(name: string, def: number, min: number, max: number, errors: string[]): number {
  const n = int(name, def);
  if (n < min || n > max) errors.push(`${name}=${n} ist nicht erlaubt (erlaubt: ${min} bis ${max})`);
  return n;
}

function list(name: string): string[] {
  return (process.env[name] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

export interface Config {
  env: 'production' | 'development' | 'test';
  port: number;
  host: string;
  publicUrl: string;
  dataDir: string;
  webDir: string;
  secretKey: Buffer;
  trustProxy: string[];
  adminAllowedCidrs: string[];
  sessionIdleMinutes: number;
  sessionMaxHours: number;
  stepupMinutes: number;
  localLogin: boolean;
  /** 2FA-Pflicht für lokale Konten mit Verwaltungsrechten */
  localAdminRequireTotp: boolean;
  /** 2FA-Pflicht für ALLE lokalen Konten */
  localUserRequireTotp: boolean;
  /** Kontosperre nach Fehlversuchen (Passwort, 2FA-Code, Bestätigung zählen gemeinsam) */
  lockout: { maxAttempts: number; minutes: number; maxMinutes: number; progressive: boolean };
  passwordMinLength: number;
  entra: {
    enabled: boolean;
    tenantId: string;
    clientId: string;
    clientSecret?: string;
    certPrivateKey?: string;
    certThumbprint?: string;
    allowedTenants: string[];
    /** Erlaubte Mail-Domains je Tenant (ENTRA_TENANT_DOMAINS). Ohne Eintrag: verifizierte Domains aus Graph. */
    tenantDomains?: Record<string, string[]>;
    authority: string;
    graphUrl: string;
    /** Wie lange die Signaturschlüssel von Microsoft höchstens ohne erfolgreiche Erneuerung genutzt werden (Stunden) */
    jwksMaxStaleHours?: number;
    /**
     * Authentifizierungskontext für Bestätigungen (Step-up), z. B. „c1“ (ENTRA_STEPUP_AUTH_CONTEXT). Gesetzt: Das Portal
     * fordert ihn bei Microsoft an und prüft den Claim „acrs“ im ID-Token – so ist belegt, dass die Richtlinie des
     * bedingten Zugriffs (z. B. MFA) gegriffen hat. Leer = aus.
     */
    stepupAuthContext?: string;
    /** Alle N Minuten über Graph prüfen, ob die Konten mit offener Sitzung in Entra noch aktiv sind (0 = aus) */
    accountCheckMinutes?: number;
  };
  clamav: { host?: string; port: number; required: boolean };
  /** Obergrenzen für Uploads (MB). Formulare können kleiner, aber nie größer einstellen. */
  /** inflightMb: so viele MB großer Bodys dürfen gleichzeitig im Speicher sein, weitere warten */
  upload: { maxFileMb: number; maxTotalMb: number; inflightMb: number };
  retentionDays: number;
  /** Freigaben durch Vorgesetzte: Frist bis zum Verfall und Erinnerung (Tage, 0 = keine Erinnerung) */
  approval: { expireDays: number; remindDays: number };
  /** Ratenbegrenzung: [Burst, Nachschub pro Sekunde] */
  rateLimits: { api: [number, number]; write: [number, number]; login: [number, number] };
  allowPrivateTicketUrls: boolean;
  /** Zusätzlich gesperrte Netze und erlaubte Hostnamen für Zammad-Adressen */
  ticketUrlBlockedCidrs: string[];
  ticketUrlAllowedHosts: string[];
  /** Ticketsysteme auf 127.0.0.1/localhost erlauben – nur für Demo und Entwicklung */
  allowLoopbackTicketUrls: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** Alle N Sekunden in Zammad nach neuen Antworten schauen und die Kunden im Portal benachrichtigen (0 = aus) */
  ticketWatchSeconds: number;
  version: string;
  /** docker = Docker Compose, native = deploy/native/install.sh (systemd) */
  installMode: 'docker' | 'native';
  /**
   * Nur benachrichtigen: Ohne Update-Dienst prüft der Worker (ohne besondere Rechte) selbst, ob es eine neue Version gibt,
   * und zeigt sie in der Verwaltung an. Installiert wird manuell. (UPDATE_NOTIFY, Quelle UPDATE_NOTIFY_URL)
   */
  updateNotify?: { enabled: boolean; url: string };
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const env = (process.env.NODE_ENV as Config['env']) || 'production';
  const keyRaw = readSecret('SECRET_KEY');
  if (!keyRaw && !overrides.secretKey) {
    throw new Error('SECRET_KEY bzw. SECRET_KEY_FILE fehlt (32 Byte, Base64). Erzeugen mit: openssl rand -base64 32');
  }
  const secretKey = overrides.secretKey ?? Buffer.from(keyRaw!, 'base64');
  if (secretKey.length !== 32) throw new Error('SECRET_KEY muss genau 32 Byte (Base64) lang sein');

  const publicUrl = (process.env.PUBLIC_URL ?? 'https://localhost').replace(/\/$/, '');
  if (env === 'production' && !publicUrl.startsWith('https://')) {
    throw new Error('PUBLIC_URL muss in Produktion mit https:// beginnen');
  }

  const errors: string[] = [];
  const lockMinutesBase = range('LOGIN_LOCK_MINUTES', 15, 1, 1440, errors);
  const tenantId = process.env.ENTRA_TENANT_ID ?? '';
  const clientId = process.env.ENTRA_CLIENT_ID ?? '';
  const cfg: Config = {
    env,
    port: int('PORT', 3000),
    host: process.env.HOST ?? '0.0.0.0',
    publicUrl,
    dataDir: process.env.DATA_DIR ?? '/data',
    webDir: process.env.WEB_DIR ?? new URL('../../dist/web', import.meta.url).pathname,
    secretKey,
    trustProxy: list('TRUST_PROXY_CIDRS'),
    adminAllowedCidrs: list('ADMIN_ALLOWED_CIDRS'),
    sessionIdleMinutes: range('SESSION_IDLE_MINUTES', 30, 5, 480, errors),
    sessionMaxHours: range('SESSION_MAX_HOURS', 10, 1, 24, errors),
    stepupMinutes: range('STEPUP_MINUTES', 10, 1, 60, errors),
    localLogin: bool('LOCAL_LOGIN_ENABLED', true),
    localAdminRequireTotp: bool('LOCAL_ADMIN_REQUIRE_TOTP', true),
    localUserRequireTotp: bool('LOCAL_USER_REQUIRE_TOTP', false),
    lockout: {
      maxAttempts: range('LOGIN_MAX_ATTEMPTS', 5, 3, 20, errors),
      minutes: lockMinutesBase,
      maxMinutes: range('LOGIN_LOCK_MAX_MINUTES', 1440, lockMinutesBase, 10080, errors),
      progressive: bool('LOGIN_LOCK_PROGRESSIVE', true),
    },
    passwordMinLength: range('PASSWORD_MIN_LENGTH', 12, 10, 128, errors),
    entra: {
      enabled: Boolean(tenantId && clientId),
      tenantId,
      clientId,
      clientSecret: readSecret('ENTRA_CLIENT_SECRET'),
      certPrivateKey: readSecret('ENTRA_CERT_PRIVATE_KEY'),
      certThumbprint: process.env.ENTRA_CERT_THUMBPRINT,
      allowedTenants: list('ENTRA_ALLOWED_TENANTS').length ? list('ENTRA_ALLOWED_TENANTS') : tenantId ? [tenantId] : [],
      tenantDomains: parseTenantDomains(process.env.ENTRA_TENANT_DOMAINS ?? '', errors),
      authority: (process.env.ENTRA_AUTHORITY ?? 'https://login.microsoftonline.com').replace(/\/$/, ''),
      graphUrl: (process.env.ENTRA_GRAPH_URL ?? 'https://graph.microsoft.com').replace(/\/$/, ''),
      jwksMaxStaleHours: range('ENTRA_JWKS_MAX_STALE_HOURS', 72, 25, 168, errors),
      stepupAuthContext: authContext(errors),
      // 0 = aus (Standard), sonst 5 bis 1440 Minuten
      accountCheckMinutes: int('ENTRA_ACCOUNT_CHECK_MINUTES', 0) === 0 ? 0 : range('ENTRA_ACCOUNT_CHECK_MINUTES', 0, 5, 1440, errors),
    },
    clamav: {
      host: process.env.CLAMAV_HOST || undefined,
      port: int('CLAMAV_PORT', 3310),
      required: bool('CLAMAV_REQUIRED', true),
    },
    upload: {
      maxFileMb: range('UPLOAD_MAX_FILE_MB', 10, 1, 20, errors),
      maxTotalMb: range('UPLOAD_MAX_TOTAL_MB', 25, 1, 25, errors),
      inflightMb: range('UPLOAD_INFLIGHT_MB', 64, 16, 1024, errors),
    },
    retentionDays: range('RETENTION_DAYS', 30, 1, 3650, errors),
    approval: {
      expireDays: range('APPROVAL_EXPIRE_DAYS', 14, 1, 90, errors),
      remindDays: range('APPROVAL_REMIND_DAYS', 3, 0, 89, errors),
    },
    rateLimits: {
      api: [range('RATE_LIMIT_API_BURST', 240, 20, 100000, errors), 4],
      write: [range('RATE_LIMIT_WRITE_BURST', 60, 5, 100000, errors), 1],
      // Anmeldeversuche je IP: Burst, danach N pro Minute
      login: [range('RATE_LIMIT_LOGIN_BURST', 10, 3, 100000, errors), range('RATE_LIMIT_LOGIN_PER_MINUTE', 10, 1, 100000, errors) / 60],
    },
    allowPrivateTicketUrls: bool('ALLOW_PRIVATE_TICKET_URLS', true),
    ticketUrlBlockedCidrs: cidrList('TICKET_URL_BLOCKED_CIDRS', errors),
    ticketUrlAllowedHosts: list('TICKET_URL_ALLOWED_HOSTS').map((h) => h.toLowerCase()),
    allowLoopbackTicketUrls: (overrides.env ?? env) === 'test' || bool('ALLOW_LOOPBACK_TICKET_URLS', false),
    logLevel: (process.env.LOG_LEVEL as Config['logLevel']) || 'info',
    ticketWatchSeconds: process.env.TICKET_WATCH_SECONDS === '0' ? 0 : range('TICKET_WATCH_SECONDS', 60, 15, 3600, errors),
    version: process.env.APP_VERSION ?? readVersion(),
    installMode: process.env.INSTALL_MODE === 'native' || (!process.env.INSTALL_MODE && !existsSync('/.dockerenv') && !!process.env.PORTAL_DIR) ? 'native' : 'docker',
    updateNotify: {
      enabled: bool('UPDATE_NOTIFY', false),
      url: notifyUrl(errors),
    },
    ...overrides,
  };
  if (errors.length) throw new Error(`Konfiguration ungültig (deploy/.env):\n  - ${errors.join('\n  - ')}`);
  if (cfg.entra.enabled && !cfg.entra.clientSecret && !cfg.entra.certPrivateKey) {
    throw new Error('Für Entra ID wird ENTRA_CLIENT_SECRET_FILE oder ENTRA_CERT_PRIVATE_KEY_FILE benötigt');
  }
  return cfg;
}

/** Authentifizierungskontext von Entra: c1 bis c99 */
function authContext(errors: string[]): string | undefined {
  const v = (process.env.ENTRA_STEPUP_AUTH_CONTEXT ?? '').trim();
  if (!v) return undefined;
  if (!/^c([1-9]|[1-9][0-9])$/.test(v)) errors.push(`ENTRA_STEPUP_AUTH_CONTEXT=${v} ist nicht erlaubt (c1 bis c99)`);
  return v;
}

/** Quelle für „nur benachrichtigen“: nur https (die Antwort steuert nur eine Anzeige, nie eine Installation) */
function notifyUrl(errors: string[]): string {
  const v = process.env.UPDATE_NOTIFY_URL || 'https://api.github.com/repos/Hundexe/Zammad-Service-Portal/tags?per_page=100';
  if (!/^https:\/\/[^\s]+$/.test(v)) errors.push('UPDATE_NOTIFY_URL muss mit https:// beginnen');
  return v;
}

function cidrList(name: string, errors: string[]): string[] {
  const out: string[] = [];
  for (const c of (process.env[name] ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const [addr, bits] = c.split('/');
    const v = isIP(addr);
    const max = v === 6 ? 128 : 32;
    if (!v || (bits !== undefined && !(Number(bits) >= 0 && Number(bits) <= max))) { errors.push(`${name}: „${c}“ ist kein gültiges Netz`); continue; }
    out.push(c);
  }
  return out;
}

/** ENTRA_TENANT_DOMAINS=tenant-id=firma-a.de,firma-a.com;tenant-id-2=firma-b.de */
function parseTenantDomains(raw: string, errors: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const part of raw.split(';').map((s) => s.trim()).filter(Boolean)) {
    const [tid, list] = part.split('=');
    const domains = (list ?? '').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
    if (!/^[0-9a-f-]{36}$/i.test(tid?.trim() ?? '') || !domains.length || domains.some((d) => !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d))) {
      errors.push(`ENTRA_TENANT_DOMAINS: „${part}“ ist ungültig (Format: Tenant-ID=domain1,domain2;…)`);
      continue;
    }
    out[tid.trim().toLowerCase()] = domains;
  }
  return out;
}

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    return String(pkg.version);
  } catch {
    return '0.0.0';
  }
}
