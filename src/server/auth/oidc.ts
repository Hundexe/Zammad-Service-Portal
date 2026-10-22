// OpenID-Connect-Client für Microsoft Entra ID (Authorization Code Flow mit PKCE).
// Bewusst ohne Fremdbibliothek: Signaturprüfung mit node:crypto, alle Claims
// werden explizit geprüft (iss, aud, tid, exp, nbf, nonce, auth_time).
import { createHash, createPublicKey, createSign, createVerify, randomUUID, type KeyObject } from 'node:crypto';
import type { Config } from '../config.ts';
import { randomToken } from '../crypto.ts';
import { log } from '../log.ts';

interface Metadata { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string; end_session_endpoint?: string }

export interface OidcTransaction {
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
  stepup: boolean;
  /** Bei Step-up: Hash der Sitzung, die bestätigt werden soll (Strict-Cookies fehlen beim Rücksprung) */
  sessionHash?: string;
  exp: number;
}

export interface IdClaims {
  iss: string; aud: string; tid: string; oid: string; sub: string; exp: number; nbf?: number; iat: number;
  nonce?: string; name?: string; email?: string; preferred_username?: string; groups?: string[]; roles?: string[];
  auth_time?: number; _claim_names?: Record<string, string>;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export class EntraClient {
  private meta?: Metadata;
  private metaAt = 0;
  private keys = new Map<string, KeyObject>();
  private keysAt = 0;

  private cfg: Config;
  private fetchImpl: typeof fetch;

  constructor(cfg: Config, fetchImpl: typeof fetch = fetch) {
    this.cfg = cfg;
    this.fetchImpl = fetchImpl;
  }

  get redirectUri(): string {
    return `${this.cfg.publicUrl}/api/auth/entra/callback`;
  }

  private tenantPath(): string {
    // Mehrere erlaubte Tenants → "organizations"-Endpunkt, Tenant wird dann am Token geprüft.
    return this.cfg.entra.allowedTenants.length > 1 ? 'organizations' : this.cfg.entra.tenantId;
  }

  async metadata(): Promise<Metadata> {
    if (this.meta && Date.now() - this.metaAt < 24 * 3600_000) return this.meta;
    const url = `${this.cfg.entra.authority}/${this.tenantPath()}/v2.0/.well-known/openid-configuration`;
    const r = await this.fetchImpl(url, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(`OIDC-Metadaten nicht abrufbar (${r.status})`);
    const m = (await r.json()) as Metadata;
    for (const k of ['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
      if (typeof m[k] !== 'string' || !m[k].startsWith('https://') && !this.cfg.entra.authority.startsWith('http://')) {
        throw new Error(`OIDC-Metadaten unvollständig: ${k}`);
      }
    }
    this.meta = m;
    this.metaAt = Date.now();
    return m;
  }

  private async key(kid: string): Promise<KeyObject> {
    const cached = this.keys.get(kid);
    if (cached) return cached;
    // Unbekannte Schlüssel-ID: JWKS neu laden (höchstens alle 5 Minuten).
    if (Date.now() - this.keysAt < 5 * 60_000 && this.keys.size > 0) throw new Error('Unbekannter Signaturschlüssel');
    const meta = await this.metadata();
    const r = await this.fetchImpl(meta.jwks_uri, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(`JWKS nicht abrufbar (${r.status})`);
    const jwks = (await r.json()) as { keys: Array<Record<string, unknown>> };
    this.keys.clear();
    for (const k of jwks.keys ?? []) {
      if (k.kty !== 'RSA' || typeof k.kid !== 'string') continue;
      if (k.use !== undefined && k.use !== 'sig') continue;
      try { this.keys.set(k.kid, createPublicKey({ key: { kty: 'RSA', n: k.n, e: k.e } as any, format: 'jwk' })); } catch { /* ungültiger Schlüssel */ }
    }
    this.keysAt = Date.now();
    const key = this.keys.get(kid);
    if (!key) throw new Error('Unbekannter Signaturschlüssel');
    return key;
  }

  newTransaction(returnTo: string, stepup: boolean): OidcTransaction {
    return { state: randomToken(24), nonce: randomToken(24), verifier: randomToken(48), returnTo, stepup, exp: Date.now() + 10 * 60_000 };
  }

  async authorizeUrl(tx: OidcTransaction, loginHint?: string): Promise<string> {
    const meta = await this.metadata();
    const challenge = b64url(createHash('sha256').update(tx.verifier).digest());
    const p = new URLSearchParams({
      client_id: this.cfg.entra.clientId,
      response_type: 'code',
      redirect_uri: this.redirectUri,
      response_mode: 'query',
      scope: 'openid profile email User.Read',
      state: tx.state,
      nonce: tx.nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    if (tx.stepup) { p.set('prompt', 'login'); p.set('max_age', '0'); }
    if (loginHint) p.set('login_hint', loginHint);
    return `${meta.authorization_endpoint}?${p.toString()}`;
  }

  private clientAssertion(audience: string): string {
    const header = { alg: 'RS256', typ: 'JWT', 'x5t#S256': this.cfg.entra.certThumbprint };
    const t = Math.floor(Date.now() / 1000);
    const payload = { aud: audience, iss: this.cfg.entra.clientId, sub: this.cfg.entra.clientId, jti: randomUUID(), nbf: t, exp: t + 300, iat: t };
    const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
    const sig = createSign('RSA-SHA256').update(input).sign(this.cfg.entra.certPrivateKey!);
    return `${input}.${b64url(sig)}`;
  }

  async exchange(code: string, tx: OidcTransaction): Promise<{ claims: IdClaims; accessToken?: string }> {
    const meta = await this.metadata();
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri,
      client_id: this.cfg.entra.clientId,
      code_verifier: tx.verifier,
      scope: 'openid profile email User.Read',
    });
    if (this.cfg.entra.certPrivateKey) {
      body.set('client_assertion_type', 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
      body.set('client_assertion', this.clientAssertion(meta.token_endpoint));
    } else {
      body.set('client_secret', this.cfg.entra.clientSecret!);
    }
    const r = await this.fetchImpl(meta.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(15000),
    });
    const json = (await r.json().catch(() => ({}))) as { id_token?: string; access_token?: string; error?: string; error_description?: string };
    if (!r.ok || !json.id_token) {
      log.warn('Token-Abruf bei Entra fehlgeschlagen', { status: r.status, error: json.error });
      throw new Error('Anmeldung bei Microsoft fehlgeschlagen');
    }
    const claims = await this.verifyIdToken(json.id_token, tx);
    return { claims, accessToken: json.access_token };
  }

  async verifyIdToken(token: string, tx: Pick<OidcTransaction, 'nonce' | 'stepup'>): Promise<IdClaims> {
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('ID-Token ungültig');
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString()) as { alg?: string; kid?: string };
    if (header.alg !== 'RS256' || !header.kid) throw new Error('ID-Token: Algorithmus nicht erlaubt');
    const key = await this.key(header.kid);
    const ok = createVerify('RSA-SHA256').update(`${parts[0]}.${parts[1]}`).verify(key, Buffer.from(parts[2], 'base64url'));
    if (!ok) throw new Error('ID-Token: Signatur ungültig');
    const c = JSON.parse(Buffer.from(parts[1], 'base64url').toString()) as IdClaims;
    const t = Math.floor(Date.now() / 1000);
    const skew = 120;
    if (!c.tid || !this.cfg.entra.allowedTenants.includes(c.tid)) throw new Error('ID-Token: Tenant nicht erlaubt');
    const expectedIss = `${this.cfg.entra.authority}/${c.tid}/v2.0`;
    if (c.iss !== expectedIss) throw new Error('ID-Token: Aussteller ungültig');
    if (c.aud !== this.cfg.entra.clientId) throw new Error('ID-Token: Zielgruppe ungültig');
    if (typeof c.exp !== 'number' || c.exp + skew < t) throw new Error('ID-Token abgelaufen');
    if (c.nbf !== undefined && c.nbf - skew > t) throw new Error('ID-Token noch nicht gültig');
    if (typeof c.iat !== 'number' || c.iat - skew > t) throw new Error('ID-Token: Ausstellungszeit ungültig');
    if (!c.nonce || c.nonce !== tx.nonce) throw new Error('ID-Token: Nonce stimmt nicht');
    if (!c.oid || !/^[0-9a-f-]{36}$/i.test(c.oid)) throw new Error('ID-Token: Objekt-ID fehlt');
    if (tx.stepup) {
      const authTime = c.auth_time ?? c.iat;
      if (t - authTime > 600) throw new Error('Erneute Anmeldung nicht erfolgt');
    }
    if (c._claim_names?.groups) {
      log.warn('Entra liefert zu viele Gruppen im Token (Group Overage) – Gruppen werden ignoriert. App-Rollen oder "Gruppen, die der Anwendung zugewiesen sind" verwenden.', { oid: c.oid });
      c.groups = [];
    }
    if (c.groups !== undefined && !Array.isArray(c.groups)) c.groups = [];
    if (c.roles !== undefined && !Array.isArray(c.roles)) c.roles = [];
    return c;
  }

  /** Abteilung und Mail aus Microsoft Graph (/me), falls verfügbar. Fehler sind nicht kritisch. */
  async profile(accessToken: string | undefined): Promise<{ department?: string | null; mail?: string | null }> {
    if (!accessToken) return {};
    try {
      const r = await this.fetchImpl(`${this.cfg.entra.graphUrl}/v1.0/me?$select=department,mail`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) return {};
      const j = (await r.json()) as { department?: string | null; mail?: string | null };
      return { department: typeof j.department === 'string' ? j.department.slice(0, 200) : null, mail: typeof j.mail === 'string' ? j.mail : null };
    } catch {
      return {};
    }
  }

  logoutUrl(): string | undefined {
    return this.meta?.end_session_endpoint
      ? `${this.meta.end_session_endpoint}?post_logout_redirect_uri=${encodeURIComponent(this.cfg.publicUrl + '/')}`
      : undefined;
  }
}
