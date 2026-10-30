// Wiederverwendbare Bausteine der Oberfläche.
import { h, icon, mount, svg, type Child } from './dom.ts';
import { ApiError } from './api.ts';

let uid = 0;
export const nextId = (p = 'f') => `${p}-${++uid}`;

export function button(label: Child, onClick: (ev: MouseEvent) => void | Promise<void>, opts: { kind?: 'primary' | 'secondary' | 'danger' | 'ghost'; icon?: string; type?: 'button' | 'submit'; disabled?: boolean; title?: string } = {}): HTMLButtonElement {
  const b = h('button', {
    class: ['btn', `btn-${opts.kind ?? 'secondary'}`],
    attrs: { type: opts.type ?? 'button', disabled: opts.disabled, title: opts.title },
  }, opts.icon ? icon(opts.icon, 16) : null, label);
  b.addEventListener('click', async (ev) => {
    if (b.disabled) return;
    const r = onClick(ev as MouseEvent);
    if (r instanceof Promise) {
      b.disabled = true;
      b.classList.add('busy');
      try { await r; } finally { b.disabled = false; b.classList.remove('busy'); }
    }
  });
  return b;
}

// ---------------------------------------------------------------- Meldungen
let toastHost: HTMLElement | null = null;
export function toast(message: string, kind: 'ok' | 'error' | 'info' = 'ok'): void {
  if (!toastHost) {
    toastHost = h('div', { class: 'toasts', attrs: { 'aria-live': 'polite', role: 'status' } });
    document.body.appendChild(toastHost);
  }
  const t = h('div', { class: ['toast', `toast-${kind}`] }, icon(kind === 'error' ? 'x' : 'check', 16), h('span', null, message));
  toastHost.appendChild(t);
  setTimeout(() => t.classList.add('leaving'), kind === 'error' ? 7000 : 3500);
  setTimeout(() => t.remove(), kind === 'error' ? 7400 : 3900);
}

export function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (Array.isArray(err.details) && err.details.length) return `${err.message}: ${err.details.join(' · ')}`;
    return err.message;
  }
  return (err as Error)?.message ?? 'Unbekannter Fehler';
}

export function showError(err: unknown): void {
  toast(errorText(err), 'error');
}

export function notice(kind: 'info' | 'warn' | 'error' | 'ok', ...content: Child[]): HTMLElement {
  return h('div', { class: ['notice', `notice-${kind}`], attrs: { role: kind === 'error' ? 'alert' : 'note' } }, ...content);
}

// ---------------------------------------------------------------- Dialoge
export function dialog(title: string, body: Child, actions: (close: (v?: unknown) => void) => Child[], opts: { wide?: boolean } = {}): Promise<unknown> {
  return new Promise((resolve) => {
    const d = h('dialog', { class: ['dialog', opts.wide && 'dialog-wide'], attrs: { 'aria-labelledby': 'dlg-title' } });
    const close = (v?: unknown) => { d.close(); d.remove(); resolve(v); };
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

export async function confirmDialog(title: string, text: string, confirmLabel = 'Bestätigen', danger = false): Promise<boolean> {
  const r = await dialog(title, h('p', null, text), (close) => [
    button('Abbrechen', () => close(false), { kind: 'ghost' }),
    button(confirmLabel, () => close(true), { kind: danger ? 'danger' : 'primary' }),
  ]);
  return r === true;
}

// ---------------------------------------------------------------- Formularfelder
export interface FieldOpts { label: string; help?: string; error?: string; required?: boolean; id?: string }

export function fieldWrap(control: HTMLElement, o: FieldOpts): HTMLElement {
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

export function input(value: string, onInput: (v: string) => void, attrs: Record<string, string | number | boolean | undefined> = {}): HTMLInputElement {
  const el = h('input', { attrs: { type: 'text', ...attrs } });
  el.value = value ?? '';
  el.addEventListener('input', () => onInput(el.value));
  return el;
}

export function textarea(value: string, onInput: (v: string) => void, attrs: Record<string, string | number | boolean | undefined> = {}): HTMLTextAreaElement {
  const el = h('textarea', { attrs: { rows: 5, ...attrs } });
  el.value = value ?? '';
  el.addEventListener('input', () => onInput(el.value));
  return el;
}

export function select(value: string, options: { value: string; label: string }[], onChange: (v: string) => void, opts: { empty?: string; id?: string; ariaLabel?: string } = {}): HTMLSelectElement {
  const el = h('select', { id: opts.id, attrs: { 'aria-label': opts.ariaLabel } },
    opts.empty !== undefined ? h('option', { attrs: { value: '' } }, opts.empty) : null,
    ...options.map((o) => h('option', { attrs: { value: o.value } }, o.label)),
  );
  el.value = value ?? '';
  el.addEventListener('change', () => onChange(el.value));
  return el;
}

export function checkbox(checked: boolean, label: string, onChange: (v: boolean) => void, help?: string): HTMLElement {
  const id = nextId('cb');
  const el = h('input', { id, attrs: { type: 'checkbox' } });
  el.checked = checked;
  el.addEventListener('change', () => onChange(el.checked));
  return h('div', { class: 'check' }, el, h('label', { attrs: { for: id } }, label), help ? h('p', { class: 'help' }, help) : null);
}

/** Eingabe einer Liste (z. B. Gruppen-IDs), eine pro Zeile. */
export function listInput(values: string[], onChange: (v: string[]) => void, placeholder = 'Eine pro Zeile'): HTMLTextAreaElement {
  return textarea(values.join('\n'), (v) => onChange(v.split(/\n|,/).map((s) => s.trim()).filter(Boolean)), { rows: 3, placeholder });
}

// ---------------------------------------------------------------- Darstellung
export function badge(text: string, tone: 'neutral' | 'ok' | 'warn' | 'error' | 'info' = 'neutral'): HTMLElement {
  return h('span', { class: ['badge', `badge-${tone}`] }, text);
}

export function emptyState(title: string, text?: string, action?: HTMLElement): HTMLElement {
  return h('div', { class: 'empty' }, h('p', { class: 'empty-title' }, title), text ? h('p', null, text) : null, action ?? null);
}

/** Ladekreis als SVG: ruhiger Ring mit abgerundetem Bogen (kein kantiges Rahmen-Segment). */
export function spinner(): SVGElement {
  return svg('svg', { class: 'spinner', viewBox: '0 0 24 24', width: 20, height: 20, 'aria-hidden': 'true' },
    svg('circle', { class: 'spinner-track', cx: 12, cy: 12, r: 9, fill: 'none', 'stroke-width': 2.5 }),
    svg('circle', { class: 'spinner-arc', cx: 12, cy: 12, r: 9, fill: 'none', 'stroke-width': 2.5, 'stroke-linecap': 'round', 'stroke-dasharray': '16 41' }));
}

export function loading(text = 'Wird geladen …'): HTMLElement {
  return h('div', { class: 'loading', attrs: { role: 'status' } }, spinner(), h('span', null, text));
}

export function table<T>(rows: T[], cols: { label: string; render: (r: T) => Child; class?: string }[], opts: { onRow?: (r: T) => void; empty?: string } = {}): HTMLElement {
  if (!rows.length) return emptyState(opts.empty ?? 'Keine Einträge');
  return h('div', { class: 'table-wrap' }, h('table', { class: ['table', opts.onRow && 'table-click'] },
    h('thead', null, h('tr', null, ...cols.map((c) => h('th', { class: c.class, attrs: { scope: 'col' } }, c.label)))),
    h('tbody', null, ...rows.map((r) => {
      const tr = h('tr', null, ...cols.map((c) => h('td', { class: c.class }, c.render(r))));
      if (opts.onRow) {
        tr.tabIndex = 0;
        tr.addEventListener('click', (e) => { if (!(e.target as HTMLElement).closest('a,button,input,select')) opts.onRow!(r); });
        tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') opts.onRow!(r); });
      }
      return tr;
    })),
  ));
}

export function tabs(items: { id: string; label: string }[], active: string, onSelect: (id: string) => void): HTMLElement {
  return h('div', { class: 'tabs', attrs: { role: 'tablist' } }, ...items.map((t) =>
    h('button', {
      class: ['tab', t.id === active && 'active'],
      attrs: { type: 'button', role: 'tab', 'aria-selected': t.id === active ? 'true' : 'false' },
      on: { click: () => onSelect(t.id) },
    }, t.label)));
}

export function copyButton(text: string, label = 'Kopieren'): HTMLButtonElement {
  return button(label, async () => {
    try { await navigator.clipboard.writeText(text); toast('In die Zwischenablage kopiert'); } catch { toast('Kopieren nicht möglich – bitte markieren und kopieren', 'error'); }
  }, { kind: 'ghost', icon: 'copy' });
}

export function pageHead(title: string, sub?: Child, actions?: Child[]): HTMLElement {
  return h('div', { class: 'page-head' },
    h('div', null, h('h1', null, title), sub ? h('p', { class: 'sub' }, sub) : null),
    actions?.length ? h('div', { class: 'page-actions' }, ...actions) : null,
  );
}

export function statusBadge(status: string): HTMLElement {
  const map: Record<string, [string, 'neutral' | 'ok' | 'warn' | 'error' | 'info']> = {
    awaiting_approval: ['Wartet auf Freigabe', 'warn'], rejected: ['Abgelehnt', 'error'], withdrawn: ['Zurückgezogen', 'neutral'], expired: ['Abgelaufen', 'neutral'], approved: ['Freigegeben', 'ok'], cancelled: ['Abgebrochen', 'neutral'],
    queued: ['Wird übermittelt', 'info'], sending: ['Wird übermittelt', 'info'], delivered: ['Übermittelt', 'ok'], failed: ['Fehlgeschlagen', 'error'],
    draft: ['Entwurf', 'neutral'], pending: ['Wartet auf Freigabe', 'warn'], published: ['Veröffentlicht', 'ok'], archived: ['Archiviert', 'neutral'],
    active: ['Aktiv', 'ok'], maintenance: ['Wartung', 'warn'], inactive: ['Deaktiviert', 'neutral'],
    requested: ['Angefordert', 'info'], running: ['Läuft', 'info'], succeeded: ['Erfolgreich', 'ok'], rolled_back: ['Zurückgerollt', 'warn'],
  };
  const [t, tone] = map[status] ?? [status, 'neutral'];
  return badge(t, tone);
}

const STATE_DE: Record<string, string> = {
  new: 'Neu', open: 'In Bearbeitung', 'pending reminder': 'Wartet', 'pending close': 'Wird geschlossen', closed: 'Erledigt', merged: 'Zusammengeführt', removed: 'Entfernt',
};
export function ticketState(state: string, closed: boolean): HTMLElement {
  return badge(STATE_DE[state] ?? state, closed ? 'neutral' : state === 'new' ? 'info' : state.startsWith('pending') ? 'warn' : 'ok');
}
