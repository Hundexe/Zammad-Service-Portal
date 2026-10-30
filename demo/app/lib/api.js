// API-Zugriff mit CSRF-Token und einheitlicher Fehlerbehandlung.

export class ApiError extends Error {
  status        ;
  code        ;
  details         ;
  constructor(status        , message        , code        , details          ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

import { demoBackend } from './env.js?v=142b079f7fc6';

let csrf = '';
export function setCsrf(token        )       { csrf = token; }

                                            
let stepupHandler                       = null;
export function onStepupRequired(fn               )       { stepupHandler = fn; }

let unauthorizedHandler                      = null;
export function onUnauthorized(fn            )       { unauthorizedHandler = fn; }

export async function api         (method        , path        , body          , retried = false)             {
  const headers                         = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && csrf) headers['X-CSRF-Token'] = csrf;
  let status        ;
  let data      = null;
  const demo = demoBackend();
  if (demo) {
    // Statische Demo: der Simulator im Browser antwortet (Kopie, damit Seiten die Daten ändern dürfen)
    const r = await demo.request(method, path, body === undefined ? undefined : JSON.parse(JSON.stringify(body)));
    status = r.status;
    data = r.data === undefined ? null : JSON.parse(JSON.stringify(r.data));
  } else {
    let res          ;
    try {
      res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin', cache: 'no-store' });
    } catch {
      throw new ApiError(0, 'Keine Verbindung zum Server', 'network');
    }
    status = res.status;
    const text = await res.text();
    try { data = text ? JSON.parse(text) : null; } catch { /* kein JSON */ }
  }
  if (status >= 200 && status < 300) return data     ;
  const err = new ApiError(status, data?.error ?? `Fehler ${status}`, data?.code ?? 'error', data?.details);
  if (status === 401 && (err.code === 'unauthenticated' || err.code === 'locked')) unauthorizedHandler?.();
  // Sitzung braucht erst einen weiteren Schritt (z. B. 2FA einrichten, weil das Konto Admin-Rechte bekommen hat)
  if (status === 403 && ['mfa_pending', 'password_change', 'totp_setup'].includes(err.code)) unauthorizedHandler?.();
  if (status === 403 && err.code === 'stepup_required' && !retried && stepupHandler) {
    if (await stepupHandler()) return api   (method, path, body, true);
  }
  throw err;
}

export const get =          (p        ) => api   ('GET', p);
export const post =          (p        , b          = {}) => api   ('POST', p, b);
export const put =          (p        , b          = {}) => api   ('PUT', p, b);
export const del =          (p        ) => api   ('DELETE', p);

/** Liest eine Datei als Base64 (ohne "data:"-Präfix). */
export function fileToBase64(file      )                  {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result);
      resolve(s.slice(s.indexOf(',') + 1));
    };
    r.onerror = () => reject(new Error('Datei konnte nicht gelesen werden'));
    r.readAsDataURL(file);
  });
}
