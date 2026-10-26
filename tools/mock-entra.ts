// Simulator für Microsoft Entra ID (OpenID Connect) – nur für Tests und Demo.
// Stellt Discovery, JWKS, Authorize und Token-Endpunkt bereit und signiert ID-Tokens mit RS256.
import { createServer, type Server } from 'node:http';
import { createHash, generateKeyPairSync, createSign, randomBytes, type KeyObject } from 'node:crypto';

export interface MockEntraUser { oid: string; tid: string; name: string; email: string; groups?: string[]; roles?: string[] }

export interface MockEntra {
  url: string;
  server: Server;
  clientId: string;
  clientSecret: string;
  /** Welcher Benutzer sich beim nächsten /authorize anmeldet */
  loginAs: (oid: string) => void;
  /** Manipulationen für Sicherheitstests */
  tamper: Partial<{ wrongAud: boolean; wrongIss: boolean; expired: boolean; wrongNonce: boolean; badSignature: boolean; algNone: boolean; otherTenant: string }>;
  close: () => Promise<void>;
}

const b64 = (x: Buffer | string) => Buffer.from(x).toString('base64url');

export async function startMockEntra(users: MockEntraUser[], opts: { port?: number; clientId?: string; clientSecret?: string; host?: string; publicHost?: string } = {}): Promise<MockEntra> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = randomBytes(8).toString('hex');
  const clientId = opts.clientId ?? '11111111-2222-3333-4444-555555555555';
  const clientSecret = opts.clientSecret ?? 'mock-secret';
  const codes = new Map<string, { user: MockEntraUser; nonce: string; challenge: string; redirect: string }>();
  let current = users[0];
  const tamper: MockEntra['tamper'] = {};
  let base = '';

  const sign = (header: object, payload: object, key: KeyObject) => {
    const input = `${b64(JSON.stringify(header))}.${b64(JSON.stringify(payload))}`;
    return `${input}.${b64(createSign('RSA-SHA256').update(input).sign(key))}`;
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://mock');
    const p = url.pathname;
    const json = (status: number, data: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    let m = /^\/([^/]+)\/v2\.0\/\.well-known\/openid-configuration$/.exec(p);
    if (m) {
      return json(200, {
        issuer: `${base}/{tenantid}/v2.0`,
        authorization_endpoint: `${base}/${m[1]}/oauth2/v2.0/authorize`,
        token_endpoint: `${base}/${m[1]}/oauth2/v2.0/token`,
        jwks_uri: `${base}/discovery/v2.0/keys`,
        end_session_endpoint: `${base}/${m[1]}/oauth2/v2.0/logout`,
      });
    }
    if (p === '/discovery/v2.0/keys') {
      const jwk = publicKey.export({ format: 'jwk' }) as Record<string, string>;
      return json(200, { keys: [{ kty: 'RSA', use: 'sig', kid, n: jwk.n, e: jwk.e }] });
    }
    if (/\/oauth2\/v2\.0\/authorize$/.test(p)) {
      const redirect = url.searchParams.get('redirect_uri') ?? '';
      const code = randomBytes(16).toString('hex');
      const as = url.searchParams.get('as');
      const user = (as && users.find((u) => u.oid === as)) || current;
      codes.set(code, { user, nonce: url.searchParams.get('nonce') ?? '', challenge: url.searchParams.get('code_challenge') ?? '', redirect });
      const target = new URL(redirect);
      target.searchParams.set('code', code);
      target.searchParams.set('state', url.searchParams.get('state') ?? '');
      res.writeHead(302, { Location: target.toString() });
      return res.end();
    }
    if (/\/oauth2\/v2\.0\/token$/.test(p) && req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const form = new URLSearchParams(Buffer.concat(chunks).toString());
      const entry = codes.get(form.get('code') ?? '');
      codes.delete(form.get('code') ?? '');
      if (!entry) return json(400, { error: 'invalid_grant' });
      if (form.get('client_id') !== clientId || form.get('client_secret') !== clientSecret) return json(401, { error: 'invalid_client' });
      if (form.get('redirect_uri') !== entry.redirect) return json(400, { error: 'invalid_grant', error_description: 'redirect_uri' });
      const verifier = form.get('code_verifier') ?? '';
      if (b64(createHash('sha256').update(verifier).digest()) !== entry.challenge) return json(400, { error: 'invalid_grant', error_description: 'PKCE' });
      const t = Math.floor(Date.now() / 1000);
      const tid = tamper.otherTenant ?? entry.user.tid;
      const claims = {
        iss: tamper.wrongIss ? `https://evil.example/${tid}/v2.0` : `${base}/${tid}/v2.0`,
        aud: tamper.wrongAud ? 'andere-app' : clientId,
        tid, oid: entry.user.oid, sub: entry.user.oid, name: entry.user.name, preferred_username: entry.user.email, email: entry.user.email,
        groups: entry.user.groups ?? [], roles: entry.user.roles,
        nonce: tamper.wrongNonce ? 'falsch' : entry.nonce,
        iat: t, nbf: t, exp: tamper.expired ? t - 3600 : t + 3600, auth_time: t,
      };
      let idToken = sign({ alg: 'RS256', typ: 'JWT', kid }, claims, privateKey);
      if (tamper.badSignature) {
        const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
        idToken = sign({ alg: 'RS256', typ: 'JWT', kid }, claims, other);
      }
      if (tamper.algNone) idToken = `${b64(JSON.stringify({ alg: 'none', kid }))}.${b64(JSON.stringify(claims))}.`;
      return json(200, { id_token: idToken, access_token: 'mock-access-token', token_type: 'Bearer' });
    }
    if (p === '/v1.0/me') {
      if (req.headers.authorization !== 'Bearer mock-access-token') return json(401, { error: 'unauthorized' });
      return json(200, { department: current.groups?.includes('it-admins') ? 'IT' : 'Vertrieb', mail: current.email });
    }
    if (/\/oauth2\/v2\.0\/logout$/.test(p)) {
      res.writeHead(302, { Location: url.searchParams.get('post_logout_redirect_uri') ?? '/' });
      return res.end();
    }
    json(404, { error: 'not_found' });
  });
  await new Promise<void>((r) => server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', () => r()));
  const addr = server.address();
  base = `http://${opts.publicHost ?? '127.0.0.1'}:${typeof addr === 'object' && addr ? addr.port : opts.port}`;
  return {
    url: base, server, clientId, clientSecret, tamper,
    loginAs: (oid) => { current = users.find((u) => u.oid === oid) ?? current; },
    close: () => new Promise((r) => server.close(() => r())),
  };
}
