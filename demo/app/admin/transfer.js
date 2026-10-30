// Verwaltung: Ticketsysteme exportieren und in ein anderes Portal importieren.
import { h, icon, mount,            } from '../lib/dom.js?v=142b079f7fc6';
import { ApiError, post } from '../lib/api.js?v=142b079f7fc6';
import { button, checkbox, confirmDialog, errorText, fieldWrap, notice, pageHead, table, toast } from '../lib/ui.js?v=142b079f7fc6';
import { can } from '../lib/app.js?v=142b079f7fc6';
import { loadAdminSystems } from './common.js?v=142b079f7fc6';

                                                                                                                                                                                                                                                                                                         
                                                                                                                                        

const MIN_PW = 12;

function errorBox(err         )              {
  if (err instanceof ApiError && Array.isArray(err.details) && err.details.length) {
    return notice('error', h('p', null, err.message), h('ul', null, ...(err.details            ).map((d) => h('li', null, String(d)))));
  }
  return notice('error', errorText(err));
}

function passwordInput(placeholder        )                   {
  return h('input', { attrs: { type: 'password', autocomplete: 'new-password', maxlength: 200, placeholder } });
}

function download(name        , text        )       {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = h('a', { attrs: { href: url, download: name } });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export async function transferPage() {
  if (!can('system.manage')) return notice('error', 'Export und Import darf nur ein globaler Admin.');

  // ---------------------------------------------------------------- Export
  let withTokens = true;
  const pw1 = passwordInput(`mindestens ${MIN_PW} Zeichen`);
  const pw2 = passwordInput('wiederholen');
  const pwBox = h('div', { class: 'grid-2' }, fieldWrap(pw1, { label: 'Export-Passwort' }), fieldWrap(pw2, { label: 'Passwort wiederholen' }));
  const exportMsg = h('div', { attrs: { 'aria-live': 'polite' } });
  const exportBtn = button('Export herunterladen', async () => {
    mount(exportMsg);
    if (withTokens && pw1.value.length < MIN_PW) { mount(exportMsg, notice('error', `Das Passwort braucht mindestens ${MIN_PW} Zeichen.`)); pw1.focus(); return; }
    if (withTokens && pw1.value !== pw2.value) { mount(exportMsg, notice('error', 'Die Passwörter stimmen nicht überein.')); pw2.focus(); return; }
    exportBtn.disabled = true;
    try {
      const r = await post                                                     ('/api/admin/transfer/export', withTokens ? { includeTokens: true, password: pw1.value } : { includeTokens: false });
      const d = new Date();
      const two = (n        ) => String(n).padStart(2, '0');
      const stamp = `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}`;
      download(`service-portal-export-${stamp}.json`, JSON.stringify(r.file, null, 2));
      pw1.value = ''; pw2.value = '';
      mount(exportMsg, notice('ok', `${r.file.systems.length} Ticketsystem(e) exportiert.`, withTokens ? ' Die Zammad-Tokens sind mit dem Passwort verschlüsselt – Passwort getrennt von der Datei weitergeben.' : ' Die Datei enthält keine Zammad-Tokens.'));
    } catch (err) {
      mount(exportMsg, errorBox(err));
    } finally {
      exportBtn.disabled = false;
    }
  }, { kind: 'primary', icon: 'down' });
  const tokensToggle = checkbox(true, 'Zammad-API-Tokens mitnehmen (verschlüsselt)', (v) => { withTokens = v; pwBox.hidden = !v; },
    'Ohne Tokens enthält die Datei keine Geheimnisse; im Zielsystem werden die Tokens dann unter „Verbindung“ eingetragen.');

  // ---------------------------------------------------------------- Import
  let file          = null;
  let fileName = '';
  const fileInput = h('input', { attrs: { type: 'file', accept: '.json,application/json', class: 'visually-hidden', id: 'import-file' } });
  const fileLabel = h('span', { class: 'muted' }, 'Keine Datei gewählt');
  const importPw = h('input', { attrs: { type: 'password', autocomplete: 'off', maxlength: 200 } });
  const importMsg = h('div', { attrs: { 'aria-live': 'polite' } });
  const planHost = h('div');

  const body = () => ({ file, password: importPw.value || undefined });

  const showPlan = (plan      ) => {
    const created = plan.systems.filter((s) => s.action === 'create').length;
    const replaced = plan.systems.length - created;
    const rows          = [
      h('h3', null, 'Vorschau'),
      h('p', null, `${replaced} Ticketsystem(e) werden ersetzt, ${created} neu angelegt`, plan.remove.length ? `, ${plan.remove.length} gelöscht` : '', '. ', `${plan.assets} Logo(s).`),
      table(plan.systems, [
        { label: 'Ticketsystem', class: 'grow', render: (s) => h('span', null, s.name, h('br'), h('span', { class: 'muted small' }, s.slug),
          s.urlChanged ? h('span', null, h('br'), h('strong', { class: 'small' }, 'Neue Adresse: '), h('span', { class: 'small' }, `${s.previousUrl} → ${s.baseUrl}`)) : null) },
        { label: 'Aktion', render: (s) => s.action === 'create' ? 'neu' : 'ersetzen' },
        { label: 'Formulare', class: 'num', render: (s) => String(s.forms) },
        { label: 'Vorlagen', class: 'num', render: (s) => String(s.templates) },
        { label: 'Übersichten', class: 'num', render: (s) => String(s.overviews) },
        { label: 'Zammad-Objekte', class: 'num', render: (s) => String(s.releasedAttributes) },
        { label: 'Token', class: 'num', render: (s) => s.token ? 'aus der Datei' : s.tokenDropped ? 'neu eintragen' : s.action === 'replace' ? 'bleibt' : 'fehlt' },
      ]),
    ];
    if (plan.remove.length) {
      rows.push(notice('warn', h('strong', null, 'Wird gelöscht, weil nicht in der Datei: '),
        plan.remove.map((r) => `${r.name} (${r.slug}${r.requests ? `, ${r.requests} alte Anfrage(n)` : ''})`).join(', '),
        ' – mit Formularen, Vorlagen, Übersichten, Stil und Rollen-Zuordnungen dieses Systems.'));
    }
    if (plan.warnings.length) rows.push(notice('info', h('ul', null, ...plan.warnings.map((w) => h('li', null, w)))));
    rows.push(notice('warn', 'Ersetzen heißt: Formulare, Versionen, Vorlagen, Übersichten und Stil dieser Ticketsysteme sind danach genau wie in der Datei. Rollen, Benutzer und alte Anfragen bleiben.'));
    const go = button('Import ausführen', async () => {
      if (!await confirmDialog('Import ausführen?', `${fileName}: ${replaced} ersetzen, ${created} neu${plan.remove.length ? `, ${plan.remove.length} löschen` : ''}. Das lässt sich nur mit einer Sicherung rückgängig machen.`, 'Importieren', true)) return;
      go.disabled = true;
      try {
        await post('/api/admin/transfer/import', { ...body(), confirm: true });
        toast('Import abgeschlossen');
        await loadAdminSystems(true).catch(() => undefined);
        mount(planHost, notice('ok', 'Import abgeschlossen. Bitte unter „Verbindung“ je Ticketsystem „Verbindung testen“ und die Zammad-Objekte prüfen.'));
        file = null; fileName = ''; importPw.value = ''; fileLabel.textContent = 'Keine Datei gewählt';
      } catch (err) {
        mount(importMsg, errorBox(err));
        go.disabled = false;
      }
    }, { kind: 'danger' });
    rows.push(h('div', { class: 'form-actions' }, go));
    mount(planHost, ...rows);
  };

  const check = button('Datei prüfen', async () => {
    mount(importMsg); mount(planHost);
    if (!file) { mount(importMsg, notice('error', 'Bitte zuerst eine Export-Datei wählen.')); return; }
    check.disabled = true;
    try {
      const r = await post                ('/api/admin/transfer/preview', body());
      showPlan(r.plan);
    } catch (err) {
      mount(importMsg, errorBox(err));
    } finally {
      check.disabled = false;
    }
  }, { icon: 'search' });

  fileInput.addEventListener('change', async () => {
    mount(importMsg); mount(planHost);
    const f = fileInput.files?.[0];
    fileInput.value = '';
    if (!f) return;
    if (f.size > 40 * 1024 * 1024) { mount(importMsg, notice('error', 'Die Datei ist zu groß (höchstens 40 MB).')); return; }
    try {
      file = JSON.parse(await f.text());
      fileName = f.name;
      fileLabel.textContent = f.name;
    } catch {
      file = null;
      mount(importMsg, notice('error', 'Die Datei ist kein gültiges JSON.'));
    }
  });

  return h('div', null,
    pageHead('Export und Import', 'Ticketsysteme mit allen Einstellungen in ein anderes Portal übertragen'),
    h('section', { class: ['panel', 'stack'] },
      h('h2', null, 'Exportieren'),
      h('p', { class: 'muted' }, 'Enthält alle Ticketsysteme: Verbindung, freigegebene Zammad-Objekte, Formulare mit allen Versionen, Vorlagen, Übersichten, Stil, Farben und Logos. Nicht enthalten: Benutzer, Rollen, Anfragen und Audit-Log.'),
      tokensToggle, pwBox, exportMsg,
      h('div', { class: 'form-actions' }, exportBtn)),
    h('section', { class: ['panel', 'stack'] },
      h('h2', null, 'Importieren'),
      notice('warn', h('strong', null, 'Ersetzt alles: '), 'Danach gibt es hier genau die Ticketsysteme aus der Datei. Ticketsysteme mit gleichem Kürzel werden überschrieben, fehlende gelöscht. Vorher am besten eine Sicherung machen (', h('code', null, 'cli.ts backup'), ').'),
      h('div', { class: 'row' }, h('label', { class: ['btn', 'btn-secondary'], attrs: { for: 'import-file' } }, icon('file', 16), 'Export-Datei wählen'), fileInput, fileLabel),
      fieldWrap(importPw, { label: 'Export-Passwort', help: 'Nur nötig, wenn die Datei Zammad-Tokens enthält.' }),
      importMsg,
      h('div', { class: 'form-actions' }, check),
      planHost),
  );
}
