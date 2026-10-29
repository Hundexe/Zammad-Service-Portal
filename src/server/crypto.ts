// Kryptografie-Bausteine: Verschlüsselung von Geheimnissen, Passwort-Hashes,
// Zufallswerte. Alles mit node:crypto, ohne Fremdbibliotheken.
import {
  createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb, timingSafeEqual,
  createHash, randomInt, hkdfSync,
} from 'node:crypto';
import { promisify } from 'node:util';

/** Begrenzt gleichzeitige scrypt-Aufrufe (je 128 MB) – gemeinsam für Anmeldung und Export-Passwort. */
export class Semaphore {
  private queue: (() => void)[] = [];
  private active = 0;
  private max: number;
  constructor(max: number) { this.max = max; }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try { return await fn(); } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}
export const hashSemaphore = new Semaphore(2);


const scrypt = promisify(scryptCb) as (pw: string | Buffer, salt: Buffer, len: number, opts: object) => Promise<Buffer>;

/** Verschlüsselt Daten mit AES-256-GCM. Ein eigener Schlüssel je Zweck wird per HKDF abgeleitet. */
export class SecretBox {
  private keys = new Map<string, Buffer>();
  private master: Buffer;

  constructor(master: Buffer) {
    this.master = master;
    if (master.length !== 32) throw new Error('Master-Schlüssel muss 32 Byte haben');
  }

  private key(purpose: string): Buffer {
    let k = this.keys.get(purpose);
    if (!k) {
      k = Buffer.from(hkdfSync('sha256', this.master, Buffer.alloc(0), `zsp:${purpose}`, 32));
      this.keys.set(purpose, k);
    }
    return k;
  }

  encrypt(purpose: string, plain: Buffer | string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key(purpose), iv);
    cipher.setAAD(Buffer.from(purpose));
    const data = Buffer.concat([cipher.update(typeof plain === 'string' ? Buffer.from(plain, 'utf8') : plain), cipher.final()]);
    return `v1.${iv.toString('base64url')}.${data.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}`;
  }

  decryptBuffer(purpose: string, token: string): Buffer {
    const [v, iv, data, tag] = token.split('.');
    if (v !== 'v1' || !iv || !data || !tag) throw new Error('Ungültiges Chiffrat');
    const tagBuf = Buffer.from(tag, 'base64url');
    // Nur volle 16-Byte-Tags (kürzere würden das Fälschen erleichtern)
    if (tagBuf.length !== 16) throw new Error('Ungültiges Chiffrat');
    const decipher = createDecipheriv('aes-256-gcm', this.key(purpose), Buffer.from(iv, 'base64url'), { authTagLength: 16 });
    decipher.setAAD(Buffer.from(purpose));
    decipher.setAuthTag(tagBuf);
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]);
  }

  decrypt(purpose: string, token: string): string {
    return this.decryptBuffer(purpose, token).toString('utf8');
  }

  /** Binärdaten (z. B. Uploads) als Buffer verschlüsseln: [12 Byte IV][16 Byte Tag][Daten] */
  encryptBlob(purpose: string, plain: Buffer): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key(purpose), iv);
    cipher.setAAD(Buffer.from(purpose));
    const data = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]);
  }

  decryptBlob(purpose: string, blob: Buffer): Buffer {
    if (blob.length < 28) throw new Error('Ungültiges Chiffrat');
    const decipher = createDecipheriv('aes-256-gcm', this.key(purpose), blob.subarray(0, 12), { authTagLength: 16 });
    decipher.setAAD(Buffer.from(purpose));
    decipher.setAuthTag(blob.subarray(12, 28));
    return Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]);
  }

  /** HMAC-Schlüssel für einen Zweck (z. B. Cookie-Signatur). */
  derive(purpose: string): Buffer {
    return this.key(purpose);
  }
}

// scrypt mit N=2^17, r=8, p=1 entspricht der OWASP-Empfehlung (Password Storage Cheat Sheet).
const SCRYPT = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password.normalize('NFKC'), salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  // Ohne gespeicherten Hash trotzdem rechnen, damit die Antwortzeit nichts verrät.
  const parts = (stored ?? DUMMY_HASH).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, salt, expected] = parts;
  const exp = Buffer.from(expected, 'base64url');
  const got = await scrypt(password.normalize('NFKC'), Buffer.from(salt, 'base64url'), exp.length, {
    N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem,
  });
  return stored !== null && stored !== undefined && got.length === exp.length && timingSafeEqual(got, exp);
}

const DUMMY_HASH = 'scrypt$131072$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

// Ohne leicht verwechselbare Zeichen (0/O, 1/l/I).
const PW_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const PW_SYMBOLS = '!#%+-=?@_';

/** Erzeugt ein zufälliges Passwort (Standard 20 Zeichen, ca. 115 Bit). */
export function generatePassword(length = 20): string {
  if (length < 12) throw new Error('Mindestens 12 Zeichen');
  const all = PW_ALPHABET + PW_SYMBOLS;
  const chars: string[] = [];
  for (let i = 0; i < length; i++) chars.push(all[randomInt(all.length)]);
  // Mindestens je ein Groß-, Kleinbuchstabe, Ziffer und Sonderzeichen
  const groups = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', PW_SYMBOLS];
  groups.forEach((g, i) => { chars[i] = g[randomInt(g.length)]; });
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

/** Mindestanforderung für selbst gewählte Passwörter. */
export function passwordProblems(pw: string, context: string[] = [], minLength = 12): string[] {
  const out: string[] = [];
  if (pw.length < Math.max(10, minLength)) out.push(`Mindestens ${Math.max(10, minLength)} Zeichen`);
  if (pw.length > 256) out.push('Höchstens 256 Zeichen');
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  if (pw.length < 16 && classes < 3) out.push('Unter 16 Zeichen: mindestens drei von Klein-, Großbuchstaben, Ziffern, Sonderzeichen');
  const lower = pw.toLowerCase();
  if (context.some((c) => c && c.length >= 3 && lower.includes(c.toLowerCase()))) out.push('Darf Benutzername oder Namen nicht enthalten');
  if (/^(.)\1+$/.test(pw) || /passwort|password|123456|qwertz|qwerty/i.test(pw)) out.push('Zu leicht zu erraten');
  return out;
}

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');
export const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
