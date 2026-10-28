// Konfiguration aus Umgebungsvariablen. Geheimnisse werden bevorzugt aus Dateien
// gelesen (VAR_FILE), wie es Docker Secrets vorsehen.
import { readFileSync } from 'node:fs';

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
    authority: string;
    graphUrl: string;
    /** Wie lange die Signaturschlüssel von Microsoft höchstens ohne erfolgreiche Erneuerung genutzt werden (Stunden) */
    jwksMaxStaleHours?: number;
  };
  clamav: { host?: string; port: number; required: boolean };
  /** Obergrenzen für Uploads (MB). Formulare können kleiner, aber nie größer einstellen. */
  upload: { maxFileMb: number; maxTotalMb: number };
  retentionDays: number;
  /** Freigaben durch Vorgesetzte: Frist bis zum Verfall und Erinnerung (Tage, 0 = keine Erinnerung) */
  approval: { expireDays: number; remindDays: number };
  /** Ratenbegrenzung: [Burst, Nachschub pro Sekunde] */
  rateLimits: { api: [number, number]; write: [number, number]; login: [number, number] };
  allowPrivateTicketUrls: boolean;
  /** Ticketsysteme auf 127.0.0.1/localhost erlauben – nur für Demo und Entwicklung */
  allowLoopbackTicketUrls: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  version: string;
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
      authority: (process.env.ENTRA_AUTHORITY ?? 'https://login.microsoftonline.com').replace(/\/$/, ''),
      graphUrl: (process.env.ENTRA_GRAPH_URL ?? 'https://graph.microsoft.com').replace(/\/$/, ''),
      jwksMaxStaleHours: range('ENTRA_JWKS_MAX_STALE_HOURS', 72, 25, 168, errors),
    },
    clamav: {
      host: process.env.CLAMAV_HOST || undefined,
      port: int('CLAMAV_PORT', 3310),
      required: bool('CLAMAV_REQUIRED', true),
    },
    upload: {
      maxFileMb: range('UPLOAD_MAX_FILE_MB', 10, 1, 20, errors),
      maxTotalMb: range('UPLOAD_MAX_TOTAL_MB', 25, 1, 25, errors),
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
    allowLoopbackTicketUrls: (overrides.env ?? env) === 'test' || bool('ALLOW_LOOPBACK_TICKET_URLS', false),
    logLevel: (process.env.LOG_LEVEL as Config['logLevel']) || 'info',
    version: process.env.APP_VERSION ?? readVersion(),
    ...overrides,
  };
  if (errors.length) throw new Error(`Konfiguration ungültig (deploy/.env):\n  - ${errors.join('\n  - ')}`);
  if (cfg.entra.enabled && !cfg.entra.clientSecret && !cfg.entra.certPrivateKey) {
    throw new Error('Für Entra ID wird ENTRA_CLIENT_SECRET_FILE oder ENTRA_CERT_PRIVATE_KEY_FILE benötigt');
  }
  return cfg;
}

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    return String(pkg.version);
  } catch {
    return '0.0.0';
  }
}
