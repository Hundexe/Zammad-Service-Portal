// Portal als App: Service Worker anmelden, Installation anbieten (Edge, Chrome) und Hinweise für andere Browser.
import { DEMO } from './env.js?v=142b079f7fc6';

                                            
                          
                                                             
 

let deferred                            = null;
const listeners = new Set            ();
const notify = () => { for (const fn of listeners) fn(); };

// Früh anmelden: Der Browser meldet die Installierbarkeit nur einmal je Seitenaufruf.
if (typeof window !== 'undefined' && !DEMO) {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // keine Mini-Leiste auf dem Handy – die Installation steht im Benutzermenü
    deferred = e                      ;
    notify();
  });
  window.addEventListener('appinstalled', () => { deferred = null; notify(); });
}

/** Service Worker an- bzw. abmelden – je nach Schalter „Als App installierbar“. */
export function initPwa(enabled         )       {
  if (DEMO || !('serviceWorker' in navigator) || !window.isSecureContext) return;
  if (enabled) {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined);
  } else {
    void navigator.serviceWorker.getRegistrations().then((regs) => { for (const r of regs) void r.unregister(); }).catch(() => undefined);
  }
}

/** Läuft das Portal gerade als installierte App (eigenes Fenster)? */
export function isStandalone()          {
  return window.matchMedia('(display-mode: standalone)').matches || (navigator                                        ).standalone === true;
}

export function installAvailable()          { return !!deferred && !isStandalone(); }

export function onInstallChange(fn            )             {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Zeigt den Installationsdialog des Browsers. true = installiert. */
export async function installApp()                   {
  const e = deferred;
  if (!e) return false;
  deferred = null;
  notify();
  await e.prompt();
  const { outcome } = await e.userChoice;
  return outcome === 'accepted';
}

/** Kurze Anleitung für Browser ohne Installationsdialog */
export function installHint()         {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) {
    return 'In Safari unten auf „Teilen“ tippen und „Zum Home-Bildschirm“ wählen.';
  }
  if (/Edg\//.test(ua)) return 'In Edge oben rechts im Menü „Apps“ › „Diese Website als App installieren“ wählen.';
  if (/Chrome\//.test(ua)) return 'In Chrome in der Adressleiste auf das Symbol „Installieren“ klicken oder im Menü „Streamen, speichern und teilen“ › „Seite als App installieren“ wählen.';
  if (/Safari\//.test(ua) && /Macintosh/.test(ua)) return 'In Safari im Menü „Ablage“ › „Zum Dock hinzufügen“ wählen.';
  if (/Firefox\//.test(ua)) return 'Firefox installiert keine Web-Apps. Bitte Edge oder Chrome verwenden.';
  return 'Im Menü des Browsers „App installieren“ oder „Zum Startbildschirm hinzufügen“ wählen.';
}
