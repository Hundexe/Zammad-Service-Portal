// Wiederverwendbare Bausteine der Oberfläche.
import { h, icon, mount, svg,            } from './dom.js?v=142b079f7fc6';
import { ApiError } from './api.js?v=142b079f7fc6';

let uid = 0;
export const nextId = (p = 'f') => `${p}-${++uid}`;

export function button(label       , onClick                                          , opts                                                                                                                                         = {})                    {
  const b = h('button', {
    class: ['btn', `btn-${opts.kind ?? 'secondary'}`],
    attrs: { type: opts.type ?? 'button', disabled: opts.disabled, title: opts.title },
  }, opts.icon ? icon(opts.icon, 16) : null, label);
  b.addEventListener('click', async (ev) => {
    if (b.disabled) return;
    const r = onClick(ev              );
    if (r instanceof Promise) {
      b.disabled = true;
      b.classList.add('busy');
      try { await r; } finally { b.disabled = false; b.classList.remove('busy'); }
    }
  });
  return b;
}

// ---------------------------------------------------------------- Meldungen
let toastHost                     = null;
export function toast(message        , kind                          = 'ok')       {
  if (!toastHost) {
    toastHost = h('div', { class: 'toasts', attrs: { 'aria-live': 'polite', role: 'status' } });
    document.body.appendChild(toastHost);
  }
  const t = h('div', { class: ['toast', `toast-${kind}`] }, icon(kind === 'error' ? 'x' : 'check', 16), h('span', null, message));
  toastHost.appendChild(t);
  setTimeout(() => t.classList.add('leaving'), kind === 'error' ? 7000 : 3500);
  setTimeout(() => t.remove(), kind === 'error' ? 7400 : 3900);
}

export function errorText(err         )         {
  if (err instanceof ApiError) {
    if (Array.isArray(err.details) && err.details.length) return `${err.message}: ${err.details.join(' · ')}`;
    return err.message;
  }
  return (err         )?.message ?? 'Unbekannter Fehler';
}

export function showError(err         )       {
  toast(errorText(err), 'error');
}

export function notice(kind                                  , ...content         )              {
  return h('div', { class: ['notice', `notice-${kind}`], attrs: { role: kind === 'error' ? 'alert' : 'note' } }, ...content);
}

// ---------------------------------------------------------------- Dialoge
export function dialog(title        , body       , actions                                           , opts                     = {})                   {
  return new Promise((resolve) => {
    const d = h('dialog', { class: ['dialog', opts.wide && 'dialog-wide'], attrs: { 'aria-labelledby': 'dlg-title' } });
    const close = (v          ) => { d.close(); d.remove(); resolve(v); };
    d.addEventListener('cancel', (e) => { e.preventDefault(); close(undefined); });
    mount(d,
      h('header', { class: 'dialog-head' }, h('h2', { id: 'dlg-title' }, title), h('button', { class: 'icon-btn', attrs: { type: 'button', 'aria-label': 'Schließen' }, on: { click: () => close(undefined) } }, icon('x'))),
      h('div', { class: 'dialog-body' }, body),
      h('footer', { class: 'dialog-actions' }, ...actions(close)),
    );
    document.body.appendChild(d);
    d.showModal();
  });
}

export async function confirmDialog(title        , text        , confirmLabel = 'Bestätigen', danger = false)                   {
  const r = await dialog(title, h('p', null, text), (close) => [
    button('Abbrechen', () => close(false), { kind: 'ghost' }),
    button(confirmLabel, () => close(true), { kind: danger ? 'danger' : 'primary' }),
  ]);
  return r === true;
}

// ---------------------------------------------------------------- Formularfelder
                                                                                                            

export function fieldWrap(control             , o           )              {
  const id = o.id ?? control.id ?? nextId();
  control.id = id;
  const helpId = `${id}-help`, errId = `${id}-err`;
  const described = [o.help ? helpId : '', o.error ? errId : ''].filter(Boolean).join(' ');
  if (described) control.setAttribute('aria-describedby', described);
  if (o.error) control.setAttribute('aria-invalid', 'true');
  if (o.required) control.setAttribute('aria-required', 'true');
  return h('div', { class: ['field', o.error && 'has-error'] },
    h('label', { attrs: { for: id } }, o.label, o.required ? h('span', { class: 'req', attrs: { 'aria-hidden': 'true' } }, ' *') : null),
    control,
    o.help ? h('p', { class: 'help', id: helpId }, o.help) : null,
    o.error ? h('p', { class: 'error', id: errId }, o.error) : null,
  );
}

export function input(value        , onInput                     , attrs                                                        = {})                   {
  const el = h('input', { attrs: { type: 'text', ...attrs } });
  el.value = value ?? '';
  el.addEventListener('input', () => onInput(el.value));
  return el;
}

export function textarea(value        , onInput                     , attrs                                                        = {})                      {
  const el = h('textarea', { attrs: { rows: 5, ...attrs } });
  el.value = value ?? '';
  el.addEventListener('input', () => onInput(el.value));
  return el;
}

export function select(value        , options                                    , onChange                     , opts                                                      = {})                    {
  const el = h('select', { id: opts.id, attrs: { 'aria-label': opts.ariaLabel } },
    opts.empty !== undefined ? h('option', { attrs: { value: '' } }, opts.empty) : null,
    ...options.map((o) => h('option', { attrs: { value: o.value } }, o.label)),
  );
  el.value = value ?? '';
  el.addEventListener('change', () => onChange(el.value));
  return el;
}

export function checkbox(checked         , label        , onChange                      , help         )              {
  const id = nextId('cb');
  const el = h('input', { id, attrs: { type: 'checkbox' } });
  el.checked = checked;
  el.addEventListener('change', () => onChange(el.checked));
  return h('div', { class: 'check' }, el, h('label', { attrs: { for: id } }, label), help ? h('p', { class: 'help' }, help) : null);
}

/** Eingabe einer Liste (z. B. Gruppen-IDs), eine pro Zeile. */
export function listInput(values          , onChange                       , placeholder = 'Eine pro Zeile')                      {
  return textarea(values.join('\n'), (v) => onChange(v.split(/\n|,/).map((s) => s.trim()).filter(Boolean)), { rows: 3, placeholder });
}

// ---------------------------------------------------------------- Darstellung
export function badge(text        , tone                                               = 'neutral')              {
  return h('span', { class: ['badge', `badge-${tone}`] }, text);
}

export function emptyState(title        , text         , action              )              {
  return h('div', { class: 'empty' }, h('p', { class: 'empty-title' }, title), text ? h('p', null, text) : null, action ?? null);
}

/** Ladekreis als SVG: ruhiger Ring mit abgerundetem Bogen (kein kantiges Rahmen-Segment). */
export function spinner()             {
  return svg('svg', { class: 'spinner', viewBox: '0 0 24 24', width: 20, height: 20, 'aria-hidden': 'true' },
    svg('circle', { class: 'spinner-track', cx: 12, cy: 12, r: 9, fill: 'none', 'stroke-width': 2.5 }),
    svg('circle', { class: 'spinner-arc', cx: 12, cy: 12, r: 9, fill: 'none', 'stroke-width': 2.5, 'stroke-linecap': 'round', 'stroke-dasharray': '16 41' }));
}

export function loading(text = 'Wird geladen …')              {
  return h('div', { class: 'loading', attrs: { role: 'status' } }, spinner(), h('span', null, text));
}

export function table   (rows     , cols                                                              , opts                                             = {})              {
  if (!rows.length) return emptyState(opts.empty ?? 'Keine Einträge');
  return h('div', { class: 'table-wrap' }, h('table', { class: ['table', opts.onRow && 'table-click'] },
    h('thead', null, h('tr', null, ...cols.map((c) => h('th', { class: c.class, attrs: { scope: 'col' } }, c.label)))),
    h('tbody', null, ...rows.map((r) => {
      const tr = h('tr', null, ...cols.map((c) => h('td', { class: c.class }, c.render(r))));
      if (opts.onRow) {
        tr.tabIndex = 0;
        tr.addEventListener('click', (e) => { if (!(e.target               ).closest('a,button,input,select')) opts.onRow (r); });
        tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') opts.onRow (r); });
      }
      return tr;
    })),
  ));
}

export function tabs(items                                 , active        , onSelect                      )              {
  return h('div', { class: 'tabs', attrs: { role: 'tablist' } }, ...items.map((t) =>
    h('button', {
      class: ['tab', t.id === active && 'active'],
      attrs: { type: 'button', role: 'tab', 'aria-selected': t.id === active ? 'true' : 'false' },
      on: { click: () => onSelect(t.id) },
    }, t.label)));
}

export function copyButton(text        , label = 'Kopieren')                    {
  return button(label, async () => {
    try { await navigator.clipboard.writeText(text); toast('In die Zwischenablage kopiert'); } catch { toast('Kopieren nicht möglich – bitte markieren und kopieren', 'error'); }
  }, { kind: 'ghost', icon: 'copy' });
}

export function pageHead(title        , sub        , actions          )              {
  return h('div', { class: 'page-head' },
    h('div', null, h('h1', null, title), sub ? h('p', { class: 'sub' }, sub) : null),
    actions?.length ? h('div', { class: 'page-actions' }, ...actions) : null,
  );
}

export function statusBadge(status        )              {
  const map                                                                         = {
    awaiting_approval: ['Wartet auf Freigabe', 'warn'], rejected: ['Abgelehnt', 'error'], withdrawn: ['Zurückgezogen', 'neutral'], expired: ['Abgelaufen', 'neutral'], approved: ['Freigegeben', 'ok'], cancelled: ['Abgebrochen', 'neutral'],
    queued: ['Wird übermittelt', 'info'], sending: ['Wird übermittelt', 'info'], delivered: ['Übermittelt', 'ok'], failed: ['Fehlgeschlagen', 'error'],
    draft: ['Entwurf', 'neutral'], pending: ['Wartet auf Freigabe', 'warn'], published: ['Veröffentlicht', 'ok'], archived: ['Archiviert', 'neutral'],
    active: ['Aktiv', 'ok'], maintenance: ['Wartung', 'warn'], inactive: ['Deaktiviert', 'neutral'],
    requested: ['Angefordert', 'info'], running: ['Läuft', 'info'], succeeded: ['Erfolgreich', 'ok'], rolled_back: ['Zurückgerollt', 'warn'],
  };
  const [t, tone] = map[status] ?? [status, 'neutral'];
  return badge(t, tone);
}

const STATE_DE                         = {
  new: 'Neu', open: 'In Bearbeitung', 'pending reminder': 'Wartet', 'pending close': 'Wird geschlossen', closed: 'Erledigt', merged: 'Zusammengeführt', removed: 'Entfernt',
};
export function ticketState(state        , closed         )              {
  return badge(STATE_DE[state] ?? state, closed ? 'neutral' : state === 'new' ? 'info' : state.startsWith('pending') ? 'warn' : 'ok');
}
