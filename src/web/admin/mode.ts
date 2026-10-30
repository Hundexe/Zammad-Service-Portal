// Ansicht der Verwaltung: „Einfach“ zeigt nur das, was man für den Alltag braucht, „Erweitert“ alles.
// Reine Darstellung – der Server prüft in beiden Ansichten dasselbe. Gespeichert je Browser.
// Einstellungen, die schon einen Wert haben, bleiben auch in der einfachen Ansicht sichtbar.
import { h } from '../lib/dom.ts';

export type AdminMode = 'simple' | 'advanced';
const KEY = 'zsp.admin.mode';

let current: AdminMode = (() => {
  try { return localStorage.getItem(KEY) === 'advanced' ? 'advanced' : 'simple'; } catch { return 'simple'; }
})();

/** Seiten, die bei einem Wechsel selbst neu zeichnen (z. B. der Formular-Editor mit ungespeicherten Änderungen). */
const handlers = new Set<() => boolean>();

export function adminMode(): AdminMode { return current; }
export function isAdvanced(): boolean { return current === 'advanced'; }
/** Zeigen, wenn erweiterte Ansicht – oder wenn schon ein Wert gesetzt ist. */
export function showAdvanced(hasValue = false): boolean { return current === 'advanced' || hasValue; }

/** Handler gibt false zurück, wenn seine Seite nicht mehr angezeigt wird (wird dann entfernt). */
export function onModeChange(fn: () => boolean): void { handlers.add(fn); }

export function setAdminMode(m: AdminMode, fallback: () => void): void {
  current = m;
  try { localStorage.setItem(KEY, m); } catch { /* privater Modus */ }
  document.documentElement.dataset.adminMode = m;
  let handled = false;
  for (const fn of [...handlers]) {
    if (fn()) handled = true; else handlers.delete(fn);
  }
  if (!handled) fallback();
}

export function modeToggle(fallback: () => void): HTMLElement {
  const btn = (m: AdminMode, label: string, title: string) => h('button', {
    class: ['seg-btn', current === m && 'active'],
    attrs: { type: 'button', 'aria-pressed': String(current === m), title },
    on: {
      click: (e) => {
        if (current === m) return;
        const box = (e.currentTarget as HTMLElement).parentElement!;
        box.querySelectorAll('.seg-btn').forEach((b) => { const on = b === e.currentTarget; b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on)); });
        setAdminMode(m, fallback);
      },
    },
  }, label);
  return h('div', { class: 'mode-toggle' },
    h('span', { class: 'nav-title' }, 'Ansicht'),
    h('div', { class: 'seg', attrs: { role: 'group', 'aria-label': 'Ansicht der Verwaltung' } },
      btn('simple', 'Einfach', 'Das Wichtigste – reicht für fast alles'),
      btn('advanced', 'Erweitert', 'Alle Einstellungen, z. B. Prüfmuster, Zammad-Felder, Weiterleitung an andere Ticketsysteme')));
}
