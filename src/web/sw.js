// Service Worker des Portals (Portal als App).
// Bewusst schlank: Er speichert KEINE Seiten, Daten oder Anhänge zwischen – alles kommt wie bisher frisch vom
// Server. Er fängt nur Seitenaufrufe ab, um ohne Netz eine verständliche Hinweisseite statt der Browser-Fehlerseite
// zu zeigen. Die Build-Kennung unten sorgt dafür, dass Browser nach jedem Update die neue Fassung übernehmen.
const BUILD = '__BUILD__';

const OFFLINE = `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Keine Verbindung</title>
<style>
  :root { color-scheme: light dark; --bg: #f5f6f8; --card: #fff; --ink: #1b1b1f; --muted: #5b5f6a; --brand: #1f5fae; }
  @media (prefers-color-scheme: dark) { :root { --bg: #111318; --card: #1b1e25; --ink: #e8e9ed; --muted: #a3a7b3; --brand: #8ab4f8; } }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--ink);
    font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 26rem; margin: 24px; padding: 32px; background: var(--card); border-radius: 16px; box-shadow: 0 4px 24px rgba(0,0,0,.08); }
  h1 { font-size: 1.375rem; margin: 0 0 .5rem; }
  p { margin: 0 0 1.25rem; color: var(--muted); }
  a { display: inline-block; padding: .6rem 1.1rem; border-radius: 10px; background: var(--brand); color: #fff; text-decoration: none; font-weight: 600; }
  @media (prefers-color-scheme: dark) { a { color: #111318; } }
</style></head>
<body><main role="main">
  <h1>Keine Verbindung zum Portal</h1>
  <p>Das Gerät ist offline oder das Portal ist gerade nicht erreichbar. Bitte die Verbindung (z.&nbsp;B. VPN) prüfen und es dann erneut versuchen.</p>
  <a href="">Erneut versuchen</a>
</main></body></html>`;

self.addEventListener('install', () => { self.skipWaiting(); });

self.addEventListener('activate', (event) => {
  // Aufräumen: frühere Fassungen haben nie etwas gespeichert – sicherheitshalber trotzdem alles leeren
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.mode !== 'navigate' || req.method !== 'GET') return; // alles andere geht unverändert ans Netz
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return; // Anmeldung (Weiterleitungen) nicht anfassen
  event.respondWith(fetch(req).catch(() => new Response(OFFLINE, {
    status: 503,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'X-Portal-Build': BUILD,
    },
  })));
});
