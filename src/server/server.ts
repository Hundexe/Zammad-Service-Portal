// HTTP-Server: alle Sicherheitsprüfungen laufen zentral hier, bevor ein Handler
// aufgerufen wird (Anmeldung, Sitzungszustand, CSRF, Herkunft, Rechte, Step-up).
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { App } from './app.ts';
import {
  ByteBudget, HttpError, ProxyTrust, RateLimiter, Router, limiterKey, parseCookies, readJson, sendJson, type Ctx, type RouteOptions,
} from './http/core.ts';
import { setSecurityHeaders } from './http/security.ts';
import { StaticFiles } from './http/static.ts';
import { loadSession, destroySession, setSessionState, type Session } from './auth/sessions.ts';
import { getUser, toAuthUser } from './services/users.ts';
import { can, type AuthUser } from './services/rbac.ts';
import { log } from './log.ts';
import type { EntraClient } from './auth/oidc.ts';
import { registerAuthRoutes, totpRequired } from './routes/auth.ts';
import { registerPortalRoutes } from './routes/portal.ts';
import { registerAdminRoutes } from './routes/admin.ts';
import { safeEqual } from './crypto.ts';

export interface ServerDeps { entra: EntraClient | null }

export type AppCtx = Ctx<Session, AuthUser>;

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function buildRouter(app: App, deps: ServerDeps): Router {
  const router = new Router();
  router.get('/healthz', { auth: 'public' }, () => ({ status: 'ok' }));
  router.get('/readyz', { auth: 'public' }, () => {
    app.db.get('SELECT 1');
    return { status: 'ok', version: app.cfg.version };
  });
  registerAuthRoutes(router, app, deps);
  registerPortalRoutes(router, app);
  registerAdminRoutes(router, app);
  return router;
}

export function createServer(app: App, deps: ServerDeps): { server: Server; router: Router } {
  const router = buildRouter(app, deps);
  const proxy = new ProxyTrust(app.cfg.trustProxy);
  const adminNets = new ProxyTrust(app.cfg.adminAllowedCidrs);
  const statics = new StaticFiles(app.cfg.webDir, app.cfg.env === 'development');
  const https = app.cfg.publicUrl.startsWith('https://');
  const publicOrigin = new URL(app.cfg.publicUrl).origin;
  const publicHost = new URL(app.cfg.publicUrl).host;
  const apiLimiter = new RateLimiter(...app.cfg.rateLimits.api); // Standard: 240 Burst, 4/s Nachschub je IP
  const writeLimiter = new RateLimiter(...app.cfg.rateLimits.write);
  // Große Bodys (Uploads, Import): gemeinsames Speicherbudget, je Benutzer nur einer gleichzeitig
  const LARGE_BODY = 1024 * 1024;
  const bodyBudget = new ByteBudget(app.cfg.upload.inflightMb * 1024 * 1024);
  const largeByUser = new Set<string>();

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = Date.now();
    const requestId = randomUUID();
    let ctx: AppCtx | undefined;
    try {
      setSecurityHeaders(res, https);
      res.setHeader('X-Request-Id', requestId);
      const method = (req.method ?? 'GET').toUpperCase();
      const rawUrl = req.url ?? '/';
      if (rawUrl.length > 4096) throw new HttpError(414, 'URL zu lang');
      const url = new URL(rawUrl, 'http://intern');
      ctx = {
        req, res, method, url, path: url.pathname, params: {}, query: url.searchParams,
        ip: proxy.clientIp(req), cookies: parseCookies(req.headers.cookie), body: undefined, requestId, responded: false,
      };

      // Schutz vor DNS-Rebinding: nur der konfigurierte Hostname wird beantwortet.
      const host = String(req.headers.host ?? '');
      const isHealth = ctx.path === '/healthz' || ctx.path === '/readyz';
      if (app.cfg.env === 'production' && !isHealth && host !== publicHost) throw new HttpError(421, 'Falscher Hostname');

      if (ctx.path.startsWith('/api/') || isHealth) {
        await handleApi(ctx);
      } else if (method === 'GET' || method === 'HEAD') {
        if (!statics.serve(ctx)) throw new HttpError(404, 'Nicht gefunden');
      } else {
        throw new HttpError(405, 'Methode nicht erlaubt');
      }
    } catch (err) {
      handleError(ctx, res, err, requestId);
    } finally {
      const status = res.statusCode;
      if (!(ctx?.path === '/healthz' && status === 200)) {
        log.info('request', { id: requestId, method: req.method, path: ctx?.path ?? '?', status, ms: Date.now() - started, ip: ctx?.ip, user: ctx?.user?.id });
      }
    }
  }

  async function handleApi(ctx: AppCtx): Promise<void> {
    const m = router.match(ctx.method, ctx.path);
    if (!m) throw new HttpError(404, 'Nicht gefunden', 'not_found');
    if ('allowed' in m) {
      ctx.res.setHeader('Allow', [...new Set(m.allowed)].join(', '));
      throw new HttpError(405, 'Methode nicht erlaubt', 'method_not_allowed');
    }
    const { route, params } = m;
    ctx.params = params;
    const o: RouteOptions = route.opts;

    const rlKey = limiterKey(ctx.ip);
    if (!apiLimiter.take(rlKey)) throw new HttpError(429, 'Zu viele Anfragen – bitte kurz warten', 'rate_limited');
    if (MUTATING.has(ctx.method) && !writeLimiter.take(rlKey)) throw new HttpError(429, 'Zu viele Anfragen – bitte kurz warten', 'rate_limited');

    // Herkunft prüfen: ändernde Anfragen nur von der eigenen Seite
    if (MUTATING.has(ctx.method)) {
      const origin = ctx.req.headers.origin;
      const site = ctx.req.headers['sec-fetch-site'];
      if (origin !== undefined && origin !== publicOrigin) throw new HttpError(403, 'Herkunft nicht erlaubt', 'bad_origin');
      if (site !== undefined && site !== 'same-origin' && site !== 'none') throw new HttpError(403, 'Herkunft nicht erlaubt', 'bad_origin');
    }

    // Sitzung
    const session = loadSession(app, ctx);
    if (session) {
      const row = getUser(app.db, session.userId);
      if (!row || row.disabled) {
        destroySession(app, ctx);
      } else if (row.kind === 'local' && !app.cfg.localLogin) {
        // Lokale Anmeldung abgeschaltet: auch bereits bestehende lokale Sitzungen enden sofort.
        destroySession(app, ctx);
      } else if (row.kind === 'local' && row.totp_enabled === 1 && !session.mfa && session.state !== 'mfa_pending') {
        // Darf nie vorkommen (2FA aktiv, aber Sitzung ohne zweiten Faktor) – Sitzung verwerfen statt vertrauen.
        destroySession(app, ctx);
      } else {
        ctx.session = session;
        ctx.user = toAuthUser(app.db, row);
        // 2FA-Pflicht für lokale Admins gilt bei JEDER Anfrage, nicht nur beim Login: Wird einem
        // angemeldeten lokalen Konto nachträglich ein Admin-Recht gegeben, muss es erst 2FA einrichten.
        if (row.kind === 'local' && session.state === 'active' && row.totp_enabled !== 1 && totpRequired(app, row)) {
          setSessionState(app, session, 'totp_setup');
        }
      }
    }
    if (o.auth !== 'public') {
      if (!ctx.session || !ctx.user) throw new HttpError(401, 'Bitte anmelden', 'unauthenticated');
      if (o.auth === 'user' && ctx.session.state !== 'active') throw new HttpError(403, 'Anmeldung noch nicht abgeschlossen', ctx.session.state);
    }

    // CSRF: Synchronizer-Token aus der Sitzung im Header X-CSRF-Token
    if (MUTATING.has(ctx.method) && o.csrf !== false && ctx.session) {
      const token = String(ctx.req.headers['x-csrf-token'] ?? '');
      if (!token || !safeEqual(token, ctx.session.csrf)) throw new HttpError(403, 'Sicherheitstoken fehlt oder ist ungültig – Seite neu laden', 'csrf');
    }

    if (o.adminNet && app.cfg.adminAllowedCidrs.length && !adminNets.contains(ctx.ip)) {
      throw new HttpError(403, 'Der Admin-Bereich ist aus diesem Netz nicht erreichbar', 'admin_network');
    }

    if (o.permission) {
      const perms = Array.isArray(o.permission) ? o.permission : [o.permission];
      const systemId = ctx.params.systemId ?? null;
      if (!perms.some((p) => can(ctx.user, p, systemId))) throw new HttpError(403, 'Keine Berechtigung', 'forbidden');
    }

    if (o.stepup && ctx.session && Date.now() - ctx.session.authTime > app.cfg.stepupMinutes * 60_000) {
      throw new HttpError(403, 'Bitte für diese Aktion erneut anmelden', 'stepup_required');
    }

    if (MUTATING.has(ctx.method)) {
      const limit = o.bodyLimit ?? 256 * 1024;
      const declared = Number(ctx.req.headers['content-length'] ?? Number.NaN);
      const expected = Number.isFinite(declared) ? Math.min(declared, limit) : limit;
      if (expected > LARGE_BODY) {
        const who = ctx.user?.id ?? rlKey;
        if (largeByUser.has(who)) throw new HttpError(429, 'Es läuft bereits ein Upload – bitte warten, bis er fertig ist', 'busy');
        largeByUser.add(who);
        try {
          await bodyBudget.acquire(expected, 30_000);
          try { ctx.body = await readJson(ctx.req, limit); } finally { bodyBudget.release(expected); }
        } finally {
          largeByUser.delete(who);
        }
      } else {
        ctx.body = await readJson(ctx.req, limit);
      }
    }

    const result = await route.handler(ctx);
    if (!ctx.responded) sendJson(ctx, ctx.method === 'POST' && result && (result as any).created ? 201 : 200, result ?? { ok: true });
  }

  function handleError(ctx: AppCtx | undefined, res: ServerResponse, err: unknown, requestId: string): void {
    if (ctx?.responded || res.headersSent) {
      res.destroy();
      return;
    }
    let status = 500;
    let body: Record<string, unknown> = { error: 'Interner Fehler', code: 'internal', requestId };
    if (err instanceof HttpError) {
      status = err.status;
      body = { error: err.message, code: err.code, ...(err.details !== undefined ? { details: err.details } : {}) };
    } else {
      log.error('Unerwarteter Fehler', { id: requestId, error: (err as Error)?.message, stack: app.cfg.env !== 'production' ? (err as Error)?.stack : undefined });
    }
    if (ctx) sendJson(ctx, status, body);
    else {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(body));
    }
  }

  const server = createHttpServer({ requestTimeout: 120_000, headersTimeout: 30_000, maxHeaderSize: 16 * 1024 }, (req, res) => { void handle(req, res); });
  server.keepAliveTimeout = 65_000;
  return { server, router };
}

/** Holt das Ticketsystem aus den Parametern und prüft ein Recht dafür. */
export function requireSystemPermission(ctx: AppCtx, perm: string, systemId: string): void {
  if (!can(ctx.user, perm, systemId)) throw new HttpError(403, 'Keine Berechtigung', 'forbidden');
}
