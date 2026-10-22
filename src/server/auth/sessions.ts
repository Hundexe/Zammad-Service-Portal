// Serverseitige Sitzungen. Im Browser liegt nur ein zufälliges Token im Cookie
// (HttpOnly, Secure, SameSite=Strict); in der Datenbank nur dessen SHA-256-Hash.
import type { App } from '../app.ts';
import { randomToken, sha256 } from '../crypto.ts';
import { appendCookie, serializeCookie, type Ctx } from '../http/core.ts';

export type SessionState = 'active' | 'mfa_pending' | 'password_change' | 'totp_setup';

export interface Session {
  idHash: string;
  userId: string;
  csrf: string;
  state: SessionState;
  createdAt: number;
  lastSeen: number;
  expiresAt: number;
  authTime: number;
  mfa: boolean;
}

interface SessionRow {
  id_hash: string; user_id: string; csrf: string; state: SessionState; created_at: number;
  last_seen: number; expires_at: number; auth_time: number; mfa: number;
}

export function secureCookies(app: App): boolean {
  return app.cfg.publicUrl.startsWith('https://');
}

export function sessionCookieName(app: App): string {
  // Das Präfix __Host- erzwingt im Browser Secure, Path=/ und keine Domain.
  return secureCookies(app) ? '__Host-zsp' : 'zsp';
}

export function createSession(app: App, ctx: Ctx, userId: string, opts: { state: SessionState; mfa: boolean; authTime?: number }): Session {
  // Schutz vor Session-Fixation: eine evtl. vorhandene Sitzung wird immer verworfen.
  destroySession(app, ctx, false);
  const token = randomToken(32);
  const t = Date.now();
  const s: Session = {
    idHash: sha256(token),
    userId,
    csrf: randomToken(24),
    state: opts.state,
    createdAt: t,
    lastSeen: t,
    expiresAt: t + app.cfg.sessionMaxHours * 3600_000,
    authTime: opts.authTime ?? t,
    mfa: opts.mfa,
  };
  app.db.run(
    `INSERT INTO sessions (id_hash, user_id, csrf, state, created_at, last_seen, expires_at, auth_time, mfa, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    s.idHash, userId, s.csrf, s.state, s.createdAt, s.lastSeen, s.expiresAt, s.authTime, s.mfa ? 1 : 0,
    ctx.ip, String(ctx.req.headers['user-agent'] ?? '').slice(0, 300),
  );
  appendCookie(ctx.res, serializeCookie(sessionCookieName(app), token, { secure: secureCookies(app), sameSite: 'Strict' }));
  ctx.session = s;
  return s;
}

export function loadSession(app: App, ctx: Ctx): Session | undefined {
  const token = ctx.cookies[sessionCookieName(app)];
  if (!token || token.length < 30 || token.length > 100) return undefined;
  const row = app.db.get<SessionRow>('SELECT * FROM sessions WHERE id_hash = ?', sha256(token));
  if (!row) return undefined;
  const t = Date.now();
  const idleLimit = (row.state === 'active' ? app.cfg.sessionIdleMinutes : 10) * 60_000;
  if (row.expires_at < t || row.last_seen + idleLimit < t) {
    app.db.run('DELETE FROM sessions WHERE id_hash = ?', row.id_hash);
    return undefined;
  }
  if (t - row.last_seen > 30_000) app.db.run('UPDATE sessions SET last_seen = ? WHERE id_hash = ?', t, row.id_hash);
  return {
    idHash: row.id_hash, userId: row.user_id, csrf: row.csrf, state: row.state, createdAt: row.created_at,
    lastSeen: t, expiresAt: row.expires_at, authTime: row.auth_time, mfa: row.mfa === 1,
  };
}

export function setSessionState(app: App, s: Session, state: SessionState, extra: { mfa?: boolean; authTime?: number } = {}): void {
  s.state = state;
  if (extra.mfa !== undefined) s.mfa = extra.mfa;
  if (extra.authTime !== undefined) s.authTime = extra.authTime;
  app.db.run('UPDATE sessions SET state = ?, mfa = ?, auth_time = ? WHERE id_hash = ?', state, s.mfa ? 1 : 0, s.authTime, s.idHash);
}

export function destroySession(app: App, ctx: Ctx, clearCookie = true): void {
  const token = ctx.cookies[sessionCookieName(app)];
  if (token) app.db.run('DELETE FROM sessions WHERE id_hash = ?', sha256(token));
  if (clearCookie) appendCookie(ctx.res, serializeCookie(sessionCookieName(app), '', { secure: secureCookies(app), maxAge: 0 }));
  ctx.session = undefined;
}

export function destroyUserSessions(app: App, userId: string, exceptHash?: string): void {
  if (exceptHash) app.db.run('DELETE FROM sessions WHERE user_id = ? AND id_hash <> ?', userId, exceptHash);
  else app.db.run('DELETE FROM sessions WHERE user_id = ?', userId);
}

export function purgeExpiredSessions(app: App): void {
  const t = Date.now();
  app.db.run('DELETE FROM sessions WHERE expires_at < ? OR last_seen < ?', t, t - app.cfg.sessionIdleMinutes * 60_000);
}
