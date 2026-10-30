// Sicherheits-Header für alle Antworten. Caddy setzt dieselben Header noch einmal,
// damit sie auch bei Fehlern des Proxys selbst greifen.
import type { ServerResponse } from 'node:http';

export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  'upgrade-insecure-requests',
].join('; ');

export function setSecurityHeaders(res: ServerResponse, https: boolean): void {
  // upgrade-insecure-requests nur bei HTTPS – sonst bricht z. B. die Demo über http://<IP> (Produktion ist immer HTTPS)
  res.setHeader('Content-Security-Policy', https ? CSP : CSP.replace(/; upgrade-insecure-requests$/, ''));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('Origin-Agent-Cluster', '?1');
  if (https) res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
}

/** Strengere CSP für hochgeladene Logos (SVG): keine Skripte, kein Nachladen, Sandbox. */
export const ASSET_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox";
