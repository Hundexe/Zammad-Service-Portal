// Anmeldung: Microsoft Entra ID (SSO) und lokale Konten (mit TOTP für Admins).
import { createHash } from 'node:crypto';
import type { App } from '../app.ts';
import type { Config } from '../config.ts';
import { HttpError, RateLimiter, appendCookie, limiterKey, redirect, serializeCookie, type Router } from '../http/core.ts';
import type { AppCtx, ServerDeps } from '../server.ts';
import {
  createSession, destroySession, destroyUserSessions, secureCookies, setSessionState, type SessionState,
} from '../auth/sessions.ts';
import { getUser, toAuthUser, upsertEntraUser, vetEntraEmail, type UserRow } from '../services/users.ts';
import { hashPassword, hashSemaphore, passwordProblems, verifyPassword } from '../crypto.ts';
import { generateTotpSecret, otpauthUri, verifyTotp } from '../auth/totp.ts';
import { qrMatrix } from '../qr.ts';
import { audit } from '../services/audit.ts';
import { isAdmin, permissionsForClient } from '../services/rbac.ts';
import { globalBranding } from '../services/systems.ts';
import type { OidcTransaction } from '../auth/oidc.ts';
import { log } from '../log.ts';
import { getFeatures } from '../services/features.ts';

// Kontosperre (einstellbar in deploy/.env, Standard): nach 5 Fehlversuchen (Passwort, 2FA-Code oder
// Bestätigung zusammen gezählt) wird das Konto gesperrt. Jede weitere Sperre dauert doppelt so lang:
// 15 min, 30 min, 1 h … bis 24 h. Zurückgesetzt wird erst nach einer VOLLSTÄNDIG erfolgreichen
// Anmeldung (inkl. zweitem Faktor).
export function lockMinutes(lockout: Config['lockout'], lockCount: number): number {
  const factor = lockout.progressive ? 2 ** Math.min(lockCount, 12) : 1;
  return Math.min(lockout.minutes * factor, lockout.maxMinutes);
}


/** Muss dieses lokale Konto 2FA nutzen? (Einstellungen LOCAL_USER_REQUIRE_TOTP / LOCAL_ADMIN_REQUIRE_TOTP) */
export function totpRequired(app: App, row: UserRow): boolean {
  if (row.kind !== 'local') return false;
  if (app.cfg.localUserRequireTotp) return true;
  return app.cfg.localAdminRequireTotp && isAdmin(toAuthUser(app.db, row));
}

export function safeReturnTo(v: unknown): string {
  const s = typeof v === 'string' ? v : '/';
  if (!/^\/[A-Za-z0-9\-._~/?=&%]*$/.test(s) || s.startsWith('//') || s.includes('/..') || s.includes('\\')) return '/';
  if (s.startsWith('/api/')) return '/';
  return s.slice(0, 300);
}

export function registerAuthRoutes(router: Router, app: App, deps: ServerDeps): void {
  const loginLimiter = new RateLimiter(...app.cfg.rateLimits.login); // Standard: 10 Versuche, dann 1 je 6 s je IP
  // Microsoft-Anmeldung prüft hier kein Passwort – großzügiger, damit geteilte Adressen (RDS, NAT) morgens nicht blockieren
  const entraLimiter = new RateLimiter(Math.max(60, app.cfg.rateLimits.login[0] * 6), Math.max(1, app.cfg.rateLimits.login[1] * 6));
  const hashSem = hashSemaphore;
  const oidcCookie = secureCookies(app) ? '__Host-zsp_oidc' : 'zsp_oidc';
  const actor = (ctx: AppCtx, u?: { id: string; display_name?: string; displayName?: string }) => ({
    id: u?.id ?? null, name: u?.display_name ?? u?.displayName ?? null, ip: ctx.ip,
  });

  function requiresTotp(row: UserRow): boolean {
    return totpRequired(app, row);
  }

  const isLocked = (row: UserRow) => Boolean(row.locked_until && row.locked_until > Date.now());

  /** Zählt einen Fehlversuch atomar (keine Lücke bei parallelen Anfragen). Sperrt bei Erreichen der Grenze. */
  function recordFailure(ctx: AppCtx, row: UserRow, reason: string): boolean {
    const r = app.db.get<{ failed_logins: number; lock_count: number }>(
      'UPDATE users SET failed_logins = failed_logins + 1 WHERE id = ? RETURNING failed_logins, lock_count', row.id)!;
    if (r.failed_logins < app.cfg.lockout.maxAttempts) {
      audit(app.db, actor(ctx, row), { action: reason === 'totp' ? 'login.totp_failed' : reason === 'stepup' ? 'stepup.failed' : 'login.failed', targetType: 'user', targetId: row.id, details: { reason, fehlversuche: r.failed_logins } });
      return false;
    }
    const minutes = lockMinutes(app.cfg.lockout, r.lock_count);
    app.db.run('UPDATE users SET failed_logins = 0, lock_count = lock_count + 1, locked_until = ? WHERE id = ?', Date.now() + minutes * 60_000, row.id);
    audit(app.db, actor(ctx, row), { action: 'login.locked', targetType: 'user', targetId: row.id, details: { reason, minuten: minutes } });
    log.warn('Konto gesperrt', { user: row.id, reason, minutes, ip: ctx.ip });
    return true;
  }

  /** Erst nach vollständiger Anmeldung (bzw. Bestätigung) wird der Zähler zurückgesetzt. */
  function clearFailures(row: UserRow): void {
    app.db.run('UPDATE users SET failed_logins = 0, lock_count = 0, locked_until = NULL WHERE id = ?', row.id);
  }

  function nextState(row: UserRow, mfaDone: boolean): SessionState {
    if (row.totp_enabled === 1 && !mfaDone) return 'mfa_pending';
    if (row.must_change_password === 1) return 'password_change';
    if (requiresTotp(row) && row.totp_enabled !== 1) return 'totp_setup';
    return 'active';
  }

  router.get('/api/public/config', { auth: 'public' }, () => ({
    localLogin: app.cfg.localLogin,
    entra: app.cfg.entra.enabled,
    passwordMinLength: app.cfg.passwordMinLength,
    branding: globalBranding(app),
    // Portal als App: Service Worker auch schon auf der Anmeldeseite registrieren
    installApp: getFeatures(app).installApp,
  }));

  router.get('/api/me', { auth: 'any' }, (ctx: AppCtx) => {
    const u = ctx.user!;
    const s = ctx.session!;
    // Zwischenzustände (z. B. nur das Passwort ist bekannt): keine Rechte, keine Admin-Auskunft
    if (s.state !== 'active') {
      return {
        user: { id: u.id, kind: u.kind, username: u.username, displayName: u.displayName, email: null, department: null, totpEnabled: u.totpEnabled },
        state: s.state, csrf: s.csrf, isAdmin: false, permissions: { global: [], bySystem: {} },
        stepupValidUntil: 0, sessionExpiresAt: s.expiresAt,
      };
    }
    return {
      user: { id: u.id, kind: u.kind, username: u.username, displayName: u.displayName, email: u.email, department: u.department, totpEnabled: u.totpEnabled },
      state: s.state,
      csrf: s.csrf,
      isAdmin: isAdmin(u),
      permissions: permissionsForClient(u),
      stepupValidUntil: s.authTime + app.cfg.stepupMinutes * 60_000,
      sessionExpiresAt: s.expiresAt,
      // Welche Funktionen eingeschaltet sind (Menüs und Seiten richten sich danach; der Server prüft selbst)
      features: (({ locations: _l, ...f }) => f)(getFeatures(app)),
    };
  });

  // ------------------------------------------------------------- lokal
  /**
   * Jede erfolgreiche lokale Anmeldung ist ein Ereignis zum Alarmieren: Im Normalbetrieb melden sich alle
   * über Microsoft an, lokale Konten sind Notfallzugänge. Log-Feld "alert": true → Regel im Log-System.
   */
  function alertLocalLogin(ctx: AppCtx, row: UserRow, mfa: boolean): void {
    log.warn('Lokale Anmeldung', { alert: true, event: 'local_login', user: row.id, username: row.username, ip: ctx.ip, mfa });
  }

  /**
   * Verbraucht einen TOTP-Zeitschritt atomar: nur wenn er neuer ist als der zuletzt benutzte.
   * So wird derselbe Code auch bei parallelen Anfragen nur einmal angenommen.
   */
  function consumeTotpStep(userId: string, step: number): boolean {
    return !!app.db.get('UPDATE users SET totp_last_step = ? WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?) RETURNING id', step, userId, step);
  }

  router.post('/api/auth/local/login', { auth: 'public', bodyLimit: 4096 }, async (ctx: AppCtx) => {
    if (!app.cfg.localLogin) throw new HttpError(404, 'Lokale Anmeldung ist deaktiviert', 'disabled');
    if (!loginLimiter.take(limiterKey(ctx.ip))) throw new HttpError(429, 'Zu viele Anmeldeversuche – bitte kurz warten', 'rate_limited');
    const b = ctx.body as { username?: unknown; password?: unknown };
    const username = typeof b.username === 'string' ? b.username.trim().slice(0, 64) : '';
    const password = typeof b.password === 'string' ? b.password.slice(0, 256) : '';
    const fail = () => new HttpError(401, `Anmeldung fehlgeschlagen. Nach ${app.cfg.lockout.maxAttempts} Fehlversuchen wird das Konto vorübergehend gesperrt.`, 'login_failed');
    const row = username ? app.db.get<UserRow>("SELECT * FROM users WHERE username = ? AND kind = 'local'", username) : undefined;
    const ok = await hashSem.run(() => verifyPassword(password, row?.password_hash));
    if (!row || row.disabled) {
      audit(app.db, { ip: ctx.ip, name: username || null }, { action: 'login.failed', details: { reason: 'unbekannt_oder_deaktiviert' } });
      throw fail();
    }
    // Sperrstand frisch lesen (parallele Anfragen)
    const fresh = getUser(app.db, row.id)!;
    if (isLocked(fresh)) {
      audit(app.db, actor(ctx, row), { action: 'login.failed', targetType: 'user', targetId: row.id, details: { reason: 'gesperrt' } });
      throw fail();
    }
    if (!ok) {
      recordFailure(ctx, row, 'passwort');
      throw fail();
    }
    const state = nextState(fresh, false);
    // Mit 2FA bleibt der Fehlerzähler stehen, bis auch der Code stimmt – sonst ließe sich
    // durch abwechselnde richtige Passwort-Eingaben beliebig oft ein Code raten.
    if (state !== 'mfa_pending') clearFailures(fresh);
    createSession(app, ctx, row.id, { state, mfa: false });
    if (state === 'active') {
      app.db.run('UPDATE users SET last_login_at = ? WHERE id = ?', Date.now(), row.id);
      alertLocalLogin(ctx, row, false);
    }
    audit(app.db, actor(ctx, row), { action: 'login.password_ok', targetType: 'user', targetId: row.id, details: { next: state } });
    return { state };
  });

  router.post('/api/auth/local/totp', { auth: 'any', bodyLimit: 1024 }, (ctx: AppCtx) => {
    const s = ctx.session!;
    if (s.state !== 'mfa_pending') throw new HttpError(409, 'Kein zweiter Faktor erwartet', 'bad_state');
    if (!loginLimiter.take(`totp:${s.userId}`)) throw new HttpError(429, 'Zu viele Versuche – bitte kurz warten', 'rate_limited');
    const row = getUser(app.db, s.userId)!;
    if (isLocked(row)) {
      destroySession(app, ctx);
      throw new HttpError(401, 'Konto vorübergehend gesperrt – bitte später erneut anmelden', 'locked');
    }
    const code = String((ctx.body as { code?: unknown }).code ?? '').replace(/\s/g, '');
    const step = row.totp_secret ? verifyTotp(app.box.decrypt('totp', row.totp_secret), code, row.totp_last_step) : null;
    if (step === null) {
      if (recordFailure(ctx, row, 'totp')) {
        destroySession(app, ctx);
        throw new HttpError(401, 'Zu viele falsche Codes – das Konto ist vorübergehend gesperrt', 'locked');
      }
      throw new HttpError(401, 'Code ungültig', 'totp_invalid');
    }
    if (!consumeTotpStep(row.id, step)) throw new HttpError(401, 'Code ungültig', 'totp_invalid');
    app.db.run('UPDATE users SET last_login_at = ? WHERE id = ?', Date.now(), row.id);
    clearFailures(row);
    const state = nextState(row, true);
    // Neue Sitzungs-ID nach dem zweiten Faktor (Rechteerhöhung = neues Token)
    createSession(app, ctx, row.id, { state, mfa: true, authTime: Date.now() });
    audit(app.db, actor(ctx, row), { action: 'login.success', targetType: 'user', targetId: row.id, details: { mfa: true } });
    alertLocalLogin(ctx, row, true);
    return { state };
  });

  router.post('/api/auth/password', { auth: 'any', bodyLimit: 4096 }, async (ctx: AppCtx) => {
    const s = ctx.session!;
    if (s.state !== 'password_change' && s.state !== 'active') throw new HttpError(409, 'Erst Anmeldung abschließen', 'bad_state');
    const row = getUser(app.db, s.userId)!;
    if (row.kind !== 'local') throw new HttpError(400, 'Das Passwort wird bei Microsoft verwaltet', 'not_local');
    const b = ctx.body as { currentPassword?: unknown; newPassword?: unknown };
    const current = typeof b.currentPassword === 'string' ? b.currentPassword : '';
    const next = typeof b.newPassword === 'string' ? b.newPassword : '';
    // Gesperrt: keine Passwortprüfung (sonst ließe sich die Sperre über diesen Weg umgehen)
    if (isLocked(row)) throw new HttpError(423, 'Konto vorübergehend gesperrt – bitte später erneut versuchen', 'locked');
    const okCurrent = await hashSem.run(() => verifyPassword(current, row.password_hash));
    // Nach dem (asynchronen) Hash frisch lesen: parallele Fehlversuche können inzwischen gesperrt haben
    if (isLocked(getUser(app.db, row.id)!)) throw new HttpError(423, 'Konto vorübergehend gesperrt – bitte später erneut versuchen', 'locked');
    if (!okCurrent) {
      if (recordFailure(ctx, row, 'passwort_aendern')) { destroySession(app, ctx); throw new HttpError(401, 'Zu viele Fehlversuche – das Konto ist vorübergehend gesperrt', 'locked'); }
      throw new HttpError(401, 'Aktuelles Passwort ist falsch', 'wrong_password');
    }
    const problems = passwordProblems(next, [row.username ?? '', row.display_name, row.email ?? ''], app.cfg.passwordMinLength);
    if (current === next) problems.push('Neues Passwort muss sich vom alten unterscheiden');
    if (problems.length) throw new HttpError(422, 'Passwort erfüllt die Anforderungen nicht', 'weak_password', problems);
    const hash = await hashSem.run(() => hashPassword(next));
    app.db.run('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?', hash, row.id);
    destroyUserSessions(app, row.id, s.idHash);
    const updated = getUser(app.db, row.id)!;
    const state = nextState(updated, s.mfa || updated.totp_enabled !== 1);
    setSessionState(app, s, state);
    if (state === 'active') app.db.run('UPDATE users SET last_login_at = ? WHERE id = ?', Date.now(), row.id);
    audit(app.db, actor(ctx, row), { action: 'user.password_changed', targetType: 'user', targetId: row.id });
    return { state };
  });

  router.get('/api/auth/totp/setup', { auth: 'any' }, (ctx: AppCtx) => {
    const s = ctx.session!;
    if (s.state !== 'totp_setup' && s.state !== 'active') throw new HttpError(409, 'Erst Anmeldung abschließen', 'bad_state');
    const row = getUser(app.db, s.userId)!;
    if (row.kind !== 'local') throw new HttpError(400, 'Für Microsoft-Konten gilt die MFA von Microsoft', 'not_local');
    if (row.totp_enabled) throw new HttpError(409, 'Zwei-Faktor-Anmeldung ist bereits eingerichtet', 'already_enabled');
    const secret = generateTotpSecret();
    app.db.run('UPDATE users SET totp_secret = ? WHERE id = ?', app.box.encrypt('totp', secret), row.id);
    const issuer = globalBranding(app).displayName || 'Self-Service-Portal';
    const uri = otpauthUri(secret, row.username ?? row.id, issuer);
    return { secret: secret.replace(/(.{4})/g, '$1 ').trim(), uri, qr: qrMatrix(uri).map((r) => r.map((b) => (b ? 1 : 0)).join('')) };
  });

  router.post('/api/auth/totp/enable', { auth: 'any', bodyLimit: 4096 }, async (ctx: AppCtx) => {
    const s = ctx.session!;
    if (s.state !== 'totp_setup' && s.state !== 'active') throw new HttpError(409, 'Erst Anmeldung abschließen', 'bad_state');
    if (!loginLimiter.take(`totp:${s.userId}`)) throw new HttpError(429, 'Zu viele Versuche – bitte kurz warten', 'rate_limited');
    const row = getUser(app.db, s.userId)!;
    if (row.totp_enabled || !row.totp_secret) throw new HttpError(409, 'Bitte die Einrichtung neu starten', 'bad_state');
    const b = ctx.body as { code?: unknown; password?: unknown };
    // Im normalen Betrieb ist das Einrichten eine Änderung der Anmeldefaktoren: aktuelles Passwort nötig
    // (sonst könnte eine übernommene Sitzung den Inhaber aussperren). Bei der Erstanmeldung wurde es eben eingegeben.
    if (s.state === 'active') {
      if (isLocked(row)) throw new HttpError(423, 'Konto vorübergehend gesperrt – bitte später erneut versuchen', 'locked');
      const okPw = await hashSem.run(() => verifyPassword(typeof b.password === 'string' ? b.password : '', row.password_hash));
      if (isLocked(getUser(app.db, row.id)!)) throw new HttpError(423, 'Konto vorübergehend gesperrt – bitte später erneut versuchen', 'locked');
      if (!okPw) {
        if (recordFailure(ctx, row, 'totp_einrichten')) { destroySession(app, ctx); throw new HttpError(401, 'Zu viele Fehlversuche – das Konto ist vorübergehend gesperrt', 'locked'); }
        throw new HttpError(401, 'Aktuelles Passwort ist falsch', 'wrong_password');
      }
    }
    const step = verifyTotp(app.box.decrypt('totp', row.totp_secret), String(b.code ?? '').replace(/\s/g, ''), null);
    if (step === null) throw new HttpError(401, 'Code ungültig – Uhrzeit des Handys prüfen', 'totp_invalid');
    app.db.run('UPDATE users SET totp_enabled = 1, totp_last_step = ? WHERE id = ?', step, row.id);
    log.warn('Zwei-Faktor-Anmeldung eingerichtet', { alert: true, event: 'totp_enabled', user: row.id, username: row.username, ip: ctx.ip });
    destroyUserSessions(app, row.id, s.idHash);
    setSessionState(app, s, 'active', { mfa: true, authTime: Date.now() });
    app.db.run('UPDATE users SET last_login_at = ? WHERE id = ?', Date.now(), row.id);
    audit(app.db, actor(ctx, row), { action: 'user.totp_enabled', targetType: 'user', targetId: row.id });
    return { state: 'active' };
  });

  router.post('/api/auth/stepup', { auth: 'user', bodyLimit: 4096 }, async (ctx: AppCtx) => {
    const s = ctx.session!;
    const row = getUser(app.db, s.userId)!;
    if (row.kind === 'entra') return { redirect: '/api/auth/entra/login?stepup=1&returnTo=' + encodeURIComponent(safeReturnTo((ctx.body as any)?.returnTo)) };
    if (!loginLimiter.take(`stepup:${row.id}`)) throw new HttpError(429, 'Zu viele Versuche – bitte kurz warten', 'rate_limited');
    // Gesperrt: keine Passwortprüfung (sonst ließe sich die Sperre über diesen Weg umgehen)
    if (isLocked(row)) throw new HttpError(423, 'Konto vorübergehend gesperrt – bitte später erneut versuchen', 'locked');
    const b = ctx.body as { password?: unknown; code?: unknown };
    const ok = await hashSem.run(() => verifyPassword(typeof b.password === 'string' ? b.password : '', row.password_hash));
    // Nach dem (asynchronen) Hash frisch lesen: Sperre und zuletzt benutzter Code können sich geändert haben
    const now = getUser(app.db, row.id)!;
    if (isLocked(now)) throw new HttpError(423, 'Konto vorübergehend gesperrt – bitte später erneut versuchen', 'locked');
    let step: number | null = null;
    if (ok && now.totp_enabled) {
      step = verifyTotp(app.box.decrypt('totp', now.totp_secret!), String(b.code ?? '').replace(/\s/g, ''), now.totp_last_step);
      if (step !== null && !consumeTotpStep(row.id, step)) step = null;
    }
    if (!ok || (now.totp_enabled && step === null)) {
      if (recordFailure(ctx, row, 'stepup')) {
        // Wer die Bestätigung 5× nicht schafft, verliert die Sitzung (schützt vor übernommenen Sitzungen)
        destroySession(app, ctx);
        throw new HttpError(401, 'Zu viele Fehlversuche – Sie wurden abgemeldet und das Konto ist vorübergehend gesperrt', 'locked');
      }
      throw new HttpError(401, 'Bestätigung fehlgeschlagen', 'stepup_failed');
    }
    clearFailures(row);
    setSessionState(app, s, s.state, { authTime: Date.now() });
    audit(app.db, actor(ctx, row), { action: 'stepup.success', targetType: 'user', targetId: row.id });
    return { ok: true, stepupValidUntil: Date.now() + app.cfg.stepupMinutes * 60_000 };
  });

  router.post('/api/auth/logout', { auth: 'any' }, (ctx: AppCtx) => {
    const u = ctx.user;
    destroySession(app, ctx);
    if (u) audit(app.db, actor(ctx, u), { action: 'logout', targetType: 'user', targetId: u.id });
    return { ok: true, redirect: u?.kind === 'entra' ? deps.entra?.logoutUrl() ?? null : null };
  });

  // ------------------------------------------------------------- Entra ID
  router.get('/api/auth/entra/login', { auth: 'public' }, async (ctx: AppCtx) => {
    if (!deps.entra) throw new HttpError(404, 'Microsoft-Anmeldung ist nicht konfiguriert', 'disabled');
    if (!entraLimiter.take(limiterKey(ctx.ip))) throw new HttpError(429, 'Zu viele Anmeldeversuche – bitte kurz warten', 'rate_limited');
    const stepup = ctx.query.get('stepup') === '1';
    if (stepup && (!ctx.session || ctx.user?.kind !== 'entra')) throw new HttpError(401, 'Bitte anmelden', 'unauthenticated');
    const tx = deps.entra.newTransaction(safeReturnTo(ctx.query.get('returnTo')), stepup);
    if (stepup) tx.sessionHash = ctx.session!.idHash;
    appendCookie(ctx.res, serializeCookie(oidcCookie, app.box.encrypt('oidc', JSON.stringify(tx)), { secure: secureCookies(app), sameSite: 'Lax', maxAge: 600 }));
    redirect(ctx, await deps.entra.authorizeUrl(tx, stepup ? ctx.user?.email ?? undefined : undefined));
  });

  router.get('/api/auth/entra/callback', { auth: 'public' }, async (ctx: AppCtx) => {
    const fail = (reason: string) => {
      log.warn('Microsoft-Anmeldung abgelehnt', { reason, ip: ctx.ip });
      audit(app.db, { ip: ctx.ip }, { action: 'login.failed', details: { method: 'entra', reason } });
      redirect(ctx, '/login?fehler=sso');
    };
    if (!deps.entra) throw new HttpError(404, 'Microsoft-Anmeldung ist nicht konfiguriert', 'disabled');
    const raw = ctx.cookies[oidcCookie];
    appendCookie(ctx.res, serializeCookie(oidcCookie, '', { secure: secureCookies(app), sameSite: 'Lax', maxAge: 0 }));
    if (ctx.query.get('error')) return fail(`entra:${String(ctx.query.get('error')).slice(0, 60)}`);
    let tx: OidcTransaction;
    try {
      tx = JSON.parse(app.box.decrypt('oidc', raw ?? '')) as OidcTransaction;
    } catch {
      return fail('transaktion_fehlt');
    }
    const state = ctx.query.get('state') ?? '';
    const code = ctx.query.get('code') ?? '';
    if (tx.exp < Date.now()) return fail('abgelaufen');
    if (!state || state !== tx.state) return fail('state');
    if (!code || code.length > 4000) return fail('code');
    // Einmalwert sperren: dieselbe Transaktion lässt sich nicht ein zweites Mal einlösen
    const stateHash = createHash('sha256').update(state).digest('base64url');
    app.db.run('DELETE FROM oidc_used_states WHERE expires_at < ?', Date.now());
    const fresh = app.db.get<{ n: number }>('INSERT OR IGNORE INTO oidc_used_states (state_hash, expires_at) VALUES (?, ?) RETURNING 1 AS n', stateHash, tx.exp + 60_000);
    if (!fresh) return fail('state_bereits_verwendet');
    try {
      const { claims, accessToken } = await deps.entra.exchange(code, tx);
      const profile = await deps.entra.profile(accessToken);
      // Mail-Adresse nur übernehmen, wenn ihre Domain zum Tenant gehört (sie entscheidet über Tickets und Freigaben)
      const allowedDomains = app.cfg.entra.tenantDomains?.[claims.tid.toLowerCase()] ?? await deps.entra.verifiedDomains(accessToken, claims.tid);
      const vet = (email: string | null) => {
        const r = vetEntraEmail(email, allowedDomains, app.cfg.entra.allowedTenants.length <= 1);
        if (r.reason) {
          log.warn('Mail-Adresse eines Microsoft-Kontos nicht übernommen', { alert: true, event: 'entra_email_rejected', reason: r.reason, oid: claims.oid, tenant: claims.tid, domain: email?.split('@')[1] ?? '' });
          audit(app.db, { ip: ctx.ip, name: claims.name ?? null }, { action: 'login.email_rejected', details: { reason: r.reason, tenant: claims.tid } });
        }
        return r.email;
      };
      if (tx.stepup) {
        // Das Sitzungscookie (SameSite=Strict) fehlt beim Rücksprung von Microsoft – die Sitzung steht in der Transaktion.
        const sess = app.db.get<{ user_id: string }>('SELECT user_id FROM sessions WHERE id_hash = ?', tx.sessionHash ?? '');
        if (!sess) return fail('stepup_ohne_sitzung');
        const row = getUser(app.db, sess.user_id)!;
        if (row.entra_oid !== claims.oid) return fail('stepup_anderer_benutzer');
        // Gruppen, Rollen und Profil bei jeder Bestätigung frisch aus Entra übernehmen – wer eine Admin-Gruppe
        // verloren hat, bekommt die Rechte nicht durch eine Bestätigung zurück.
        const fresh = upsertEntraUser(app.db, claims, profile, vet);
        if (fresh.disabled) {
          app.db.run('DELETE FROM sessions WHERE user_id = ?', fresh.id);
          return fail('deaktiviert');
        }
        app.db.run('UPDATE sessions SET auth_time = ?, mfa = 1 WHERE id_hash = ?', Date.now(), tx.sessionHash!);
        audit(app.db, actor(ctx, row), { action: 'stepup.success', targetType: 'user', targetId: row.id, details: { method: 'entra' } });
        return redirect(ctx, tx.returnTo);
      }
      const row = upsertEntraUser(app.db, claims, profile, vet);
      if (row.disabled) return fail('deaktiviert');
      createSession(app, ctx, row.id, { state: 'active', mfa: true, authTime: Date.now() });
      audit(app.db, actor(ctx, row), { action: 'login.success', targetType: 'user', targetId: row.id, details: { method: 'entra', tenant: claims.tid } });
      redirect(ctx, tx.returnTo);
    } catch (err) {
      return fail((err as Error).message.slice(0, 120));
    }
  });
}
