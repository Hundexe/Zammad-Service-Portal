// Anmeldung und die Schritte danach (zweiter Faktor, Passwort ändern, Authenticator einrichten).
import { h, mount, svg } from '../lib/dom.js?v=142b079f7fc6';
import { LOGIN_TITLE_DEFAULT } from '../../shared/branding.js?v=142b079f7fc6';
import { ApiError, get, post } from '../lib/api.js?v=142b079f7fc6';
import { button, errorText, fieldWrap, input, notice, copyButton } from '../lib/ui.js?v=142b079f7fc6';
import { applyBranding, assetUrl, bandLogoId, loadMe, loadSystems, logo, logout, navigate, state, themeToggle } from '../lib/app.js?v=142b079f7fc6';
import { DEMO } from '../lib/env.js?v=142b079f7fc6';

function target(q                 )         {
  const z = q.get('ziel') ?? '/';
  return /^\/(?!\/)[^\\]*$/.test(z) && !z.startsWith('/login') ? z : '/';
}

function shell(...content                 )              {
  const b = state.config .branding;
  applyBranding(b);
  document.body.dataset.layout = 'login';
  const legal = [
    b.imprintUrl ? h('a', { attrs: { href: b.imprintUrl, target: '_blank', rel: 'noopener noreferrer' } }, 'Impressum') : null,
    b.privacyUrl ? h('a', { attrs: { href: b.privacyUrl, target: '_blank', rel: 'noopener noreferrer' } }, 'Datenschutz') : null,
  ].filter(Boolean)                 ;
  return h('div', { class: 'login' },
    h('div', { class: 'login-frame' },
      h('aside', { class: 'login-band' },
        h('div', { class: 'login-brand' }, bandLogoId(b)
          ? h('img', { class: 'brand-logo', attrs: { src: assetUrl(bandLogoId(b) ), alt: b.displayName } })
          : h('span', { class: 'login-brand-name' }, logo({ ...b, logoLightId: null, logoDarkId: null }), h('span', null, b.displayName))),
        h('div', { class: 'login-hello' },
          h('p', { class: 'login-claim' }, b.loginTitle || LOGIN_TITLE_DEFAULT),
          b.loginText ? h('p', { class: 'login-lead' }, b.loginText) : null),
        b.footerText || legal.length ? h('div', { class: 'login-foot' },
          b.footerText ? h('p', { class: 'login-note' }, b.footerText) : null,
          legal.length ? h('p', { class: 'login-legal' }, ...legal) : null) : null),
      h('main', { class: 'login-card', id: 'main' }, ...content)),
    h('div', { class: 'login-theme' }, themeToggle()),
  );
}

export async function loginPage(_p                        , q                 ) {
  const me = state.me ?? await loadMe();
  const goal = target(q);
  if (me?.state === 'active') { navigate(goal, true); return h('div'); }
  if (me?.state === 'mfa_pending') return totpStep(goal);
  if (me?.state === 'password_change') return passwordStep(goal);
  if (me?.state === 'totp_setup') return totpSetupStep(goal);

  const cfg = state.config ;
  const msg = h('div', { attrs: { 'aria-live': 'polite' } });
  if (q.get('fehler') === 'sso') mount(msg, notice('error', 'Die Anmeldung bei Microsoft hat nicht geklappt. Bitte erneut versuchen oder die IT kontaktieren.'));
  if (q.get('fehler') === 'gesperrt') mount(msg, notice('error', 'Zu viele Fehlversuche. Das Konto ist vorübergehend gesperrt. Bitte später erneut anmelden oder die IT kontaktieren.'));
  let username = '', password = '';
  const localForm = cfg.localLogin ? h('form', {
    class: 'stack',
    on: {
      submit: async (e) => {
        e.preventDefault();
        mount(msg);
        try {
          await post('/api/auth/local/login', { username, password });
          await loadMe();
          navigate(`/login?ziel=${encodeURIComponent(goal)}`, true);
        } catch (err) {
          mount(msg, notice('error', errorText(err)));
        }
      },
    },
  },
    fieldWrap(input('', (v) => { username = v; }, { autocomplete: 'username', autocapitalize: 'none', spellcheck: false, required: true }), { label: 'Benutzername' }),
    fieldWrap(input('', (v) => { password = v; }, { type: 'password', autocomplete: 'current-password', required: true }), { label: 'Passwort' }),
    h('button', { class: ['btn', cfg.entra ? 'btn-secondary' : 'btn-primary', 'btn-block'], attrs: { type: 'submit' } }, 'Anmelden'),
  ) : null;

  return shell(
    h('h1', null, 'Anmelden'),
    h('p', { class: 'sub' }, 'Melden Sie sich an, um eine Anfrage an die IT zu stellen oder Ihre Tickets zu sehen.'),
    msg,
    cfg.entra ? h('a', {
      class: ['btn', 'btn-primary', 'btn-block', 'btn-ms'],
      attrs: { href: DEMO ? '#' : `/api/auth/entra/login?returnTo=${encodeURIComponent(goal)}` },
      // Demo: simulierte Microsoft-Anmeldung direkt im Browser
      on: DEMO ? { click: async (e) => { e.preventDefault(); await post('/api/demo/login', {}); await loadMe(); await loadSystems(); navigate(goal, true); } } : {},
    },
      svg('svg', { viewBox: '0 0 21 21', width: 18, height: 18, 'aria-hidden': 'true' },
        svg('rect', { x: 1, y: 1, width: 9, height: 9, fill: '#f25022' }), svg('rect', { x: 11, y: 1, width: 9, height: 9, fill: '#7fba00' }),
        svg('rect', { x: 1, y: 11, width: 9, height: 9, fill: '#00a4ef' }), svg('rect', { x: 11, y: 11, width: 9, height: 9, fill: '#ffb900' })),
      'Mit Microsoft anmelden') : null,
    cfg.entra && localForm ? h('details', { class: 'local-login' }, h('summary', null, 'Mit lokalem Konto anmelden'), localForm) : localForm,
    !cfg.entra && !cfg.localLogin ? notice('warn', 'Es ist keine Anmeldemethode eingerichtet.') : null,
  );
}

function totpStep(goal        ) {
  let code = '';
  const msg = h('div', { attrs: { 'aria-live': 'polite' } });
  return shell(
    h('h1', null, 'Code eingeben'),
    h('p', { class: 'sub' }, 'Öffnen Sie Ihre Authenticator-App und geben Sie den sechsstelligen Code ein.'),
    msg,
    h('form', { class: 'stack', on: { submit: async (e) => {
      e.preventDefault();
      try {
        await post('/api/auth/local/totp', { code });
        await loadMe();
        navigate(`/login?ziel=${encodeURIComponent(goal)}`, true);
      } catch (err) {
        if (err instanceof ApiError && err.code === 'locked') { state.me = null; navigate('/login?fehler=gesperrt', true); return; }
        mount(msg, notice('error', errorText(err)));
      }
    } } },
      fieldWrap(input('', (v) => { code = v; }, { inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 7, required: true, class: 'code-input' }), { label: 'Code' }),
      h('button', { class: ['btn', 'btn-primary', 'btn-block'], attrs: { type: 'submit' } }, 'Bestätigen'),
    ),
  );
}

export function passwordForm(onDone            , forced         )              {
  let current = '', next = '', repeat = '';
  const min = state.config?.passwordMinLength ?? 12;
  const msg = h('div', { attrs: { 'aria-live': 'polite' } });
  return h('form', { class: 'stack', on: { submit: async (e) => {
    e.preventDefault();
    if (next !== repeat) { mount(msg, notice('error', 'Die beiden neuen Passwörter stimmen nicht überein.')); return; }
    try {
      await post('/api/auth/password', { currentPassword: current, newPassword: next });
      onDone();
    } catch (err) { mount(msg, notice('error', errorText(err))); }
  } } },
    msg,
    fieldWrap(input('', (v) => { current = v; }, { type: 'password', autocomplete: 'current-password', required: true }), { label: forced ? 'Erhaltenes Passwort' : 'Aktuelles Passwort' }),
    fieldWrap(input('', (v) => { next = v; }, { type: 'password', autocomplete: 'new-password', required: true, minlength: min }), { label: 'Neues Passwort', help: `Mindestens ${min} Zeichen. Unter 16 Zeichen drei Zeichenarten (Klein-, Großbuchstaben, Ziffern, Sonderzeichen). Eine Passphrase aus mehreren Wörtern ist ideal.` }),
    fieldWrap(input('', (v) => { repeat = v; }, { type: 'password', autocomplete: 'new-password', required: true }), { label: 'Neues Passwort wiederholen' }),
    h('button', { class: ['btn', 'btn-primary', 'btn-block'], attrs: { type: 'submit' } }, 'Passwort ändern'),
  );
}

function passwordStep(goal        ) {
  return shell(
    h('h1', null, 'Eigenes Passwort festlegen'),
    h('p', { class: 'sub' }, 'Sie haben ein erzeugtes Passwort erhalten. Bitte ersetzen Sie es jetzt durch ein eigenes.'),
    passwordForm(async () => { await loadMe(); navigate(`/login?ziel=${encodeURIComponent(goal)}`, true); }, true),
  );
}

export function qrSvg(rows          )             {
  const n = rows.length, q = 4;
  const cells         = [svg('rect', { x: 0, y: 0, width: n + 2 * q, height: n + 2 * q, fill: '#fff' })];
  let d = '';
  rows.forEach((row, y) => { for (let x = 0; x < row.length; x++) if (row[x] === '1') d += `M${x + q} ${y + q}h1v1h-1z`; });
  cells.push(svg('path', { d, fill: '#000' }));
  return svg('svg', { viewBox: `0 0 ${n + 2 * q} ${n + 2 * q}`, width: 200, height: 200, role: 'img', 'aria-label': 'QR-Code für die Authenticator-App', 'shape-rendering': 'crispEdges' }, ...cells);
}

/** needPassword: im normalen Betrieb muss das aktuelle Passwort bestätigt werden (Änderung der Anmeldefaktoren). */
export async function totpSetupBlock(onDone            , needPassword = false)                       {
  const s = await get                                               ('/api/auth/totp/setup');
  let code = '';
  let password = '';
  const msg = h('div', { attrs: { 'aria-live': 'polite' } });
  return h('div', { class: 'stack' },
    h('ol', { class: 'steps' },
      h('li', null, 'Microsoft Authenticator (oder eine andere Authenticator-App) auf dem Handy öffnen.'),
      h('li', null, 'Konto hinzufügen und diesen QR-Code scannen.'),
      h('li', null, 'Den angezeigten sechsstelligen Code unten eingeben.')),
    h('div', { class: 'qr' }, qrSvg(s.qr)),
    h('p', { class: 'small muted' }, 'Scannen nicht möglich? Diesen Schlüssel von Hand eingeben:'),
    h('p', { class: 'secret' }, h('code', null, s.secret), copyButton(s.secret.replace(/\s/g, ''))),
    msg,
    h('form', { class: 'stack', on: { submit: async (e) => {
      e.preventDefault();
      try { await post('/api/auth/totp/enable', needPassword ? { code, password } : { code }); onDone(); } catch (err) { mount(msg, notice('error', errorText(err))); }
    } } },
      fieldWrap(input('', (v) => { code = v; }, { inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 7, required: true, class: 'code-input' }), { label: 'Code aus der App' }),
      needPassword ? fieldWrap(input('', (v) => { password = v; }, { type: 'password', autocomplete: 'current-password', required: true }), { label: 'Aktuelles Passwort', help: 'Zur Bestätigung, dass Sie es selbst sind' }) : null,
      h('button', { class: ['btn', 'btn-primary', 'btn-block'], attrs: { type: 'submit' } }, 'Zwei-Faktor-Anmeldung aktivieren')),
  );
}

async function totpSetupStep(goal        ) {
  return shell(
    h('h1', null, 'Zwei-Faktor-Anmeldung einrichten'),
    h('p', { class: 'sub' }, 'Ihr Konto hat Verwaltungsrechte. Dafür ist ein zweiter Faktor Pflicht.'),
    await totpSetupBlock(async () => { await loadMe(); navigate(goal, true); }),
    button('Abmelden', () => logout(), { kind: 'ghost' }),
  );
}
