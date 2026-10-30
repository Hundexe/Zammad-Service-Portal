// Portal als App: Manifest, App-Symbole und die Vorlage für die Verteilung per Intune.
import type { App } from '../app.ts';
import { HttpError, type Router } from '../http/core.ts';
import type { AppCtx } from '../server.ts';
import { getFeatures } from '../services/features.ts';
import { globalBranding } from '../services/systems.ts';
import { appIcon, forceInstallPolicy, manifest } from '../services/pwa.ts';

export function registerPwaRoutes(router: Router, app: App): void {
  const enabled = () => {
    if (!getFeatures(app).installApp) throw new HttpError(404, 'Nicht gefunden', 'not_found');
  };

  // Öffentlich: Browser (und Edge bei der Verteilung per Richtlinie) laden das Manifest ohne Anmeldung
  router.get('/api/app/manifest', { auth: 'public' }, (ctx: AppCtx) => {
    enabled();
    const res = ctx.res;
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.end(ctx.method === 'HEAD' ? undefined : JSON.stringify(manifest(app)));
    ctx.responded = true;
  });

  router.get('/api/app/icon/:file', { auth: 'public' }, (ctx: AppCtx) => {
    enabled();
    const png = appIcon(app, ctx.params.file!);
    if (!png) throw new HttpError(404, 'Nicht gefunden', 'not_found');
    const res = ctx.res;
    res.statusCode = 200;
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Length', png.length);
    // Adressen im Manifest tragen eine Versionskennung (?v=…); ohne sie nur kurz zwischenspeichern
    res.setHeader('Cache-Control', ctx.query.has('v') ? 'public, max-age=604800' : 'public, max-age=3600');
    res.end(ctx.method === 'HEAD' ? undefined : png);
    ctx.responded = true;
  });

  // Verwaltung: fertige Werte für die Richtlinie „WebAppInstallForceList“ (Intune, Gruppenrichtlinie)
  router.get('/api/admin/settings/app', { auth: 'user', adminNet: true, permission: 'settings.manage' }, () => {
    const name = globalBranding(app).displayName;
    return {
      enabled: getFeatures(app).installApp,
      url: new URL('/', app.cfg.publicUrl).href,
      name,
      policy: forceInstallPolicy(app.cfg.publicUrl, { name, desktopShortcut: false }),
      policyDesktop: forceInstallPolicy(app.cfg.publicUrl, { name, desktopShortcut: true }),
    };
  });
}
