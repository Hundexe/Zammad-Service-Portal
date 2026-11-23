// Verwaltung: ITSM-Grundausstattung für Zammad – Teile wählen, Zeiten einstellen, Vorschau, anlegen.
import { h, mount } from '../lib/dom.js?v=1060478b0baa';
import { get, post } from '../lib/api.js?v=1060478b0baa';
import { badge, button, checkbox, confirmDialog, errorText, fieldWrap, input, notice, pageHead, table, toast } from '../lib/ui.js?v=1060478b0baa';
import { adminSystem, loadAdminSystems } from './common.js?v=1060478b0baa';
import { BASELINE_PARTS, PRIORITY_NAMES, WEEKDAYS,                                                       } from '../../shared/zammad-baseline.js?v=1060478b0baa';

                                                                                                                              
const DAY                          = { mon: 'Mo', tue: 'Di', wed: 'Mi', thu: 'Do', fri: 'Fr', sat: 'Sa', sun: 'So' };
const KIND                         = { attribute: 'Feld', state: 'Status', priority: 'Priorität', calendar: 'Kalender', sla: 'SLA', trigger: 'Trigger', job: 'Automatisierung', overview: 'Übersicht' };
const hm = (min        ) => (min % 60 ? `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')} h` : `${min / 60} h`);

export async function baselinePage(p                        ) {
  await loadAdminSystems();
  const s = adminSystem(p.systemId);
  const d = await get                                                                                                    (`/api/admin/systems/${s.id}/zammad/baseline`);
  const o                  = structuredClone(d.defaults);
  const host = h('div');
  const previewHost = h('div', { attrs: { 'aria-live': 'polite' } });
  const msg = h('div');

  const preview = async () => {
    mount(previewHost, h('p', { class: 'muted' }, 'Prüfe Zammad …'));
    try {
      const r = await post                   (`/api/admin/systems/${s.id}/zammad/baseline/preview`, { options: o });
      const neu = r.items.filter((i) => i.status === 'neu').length;
      mount(previewHost,
        h('p', null, neu ? `${neu} Elemente werden angelegt.` : 'Alles Gewählte ist schon vorhanden.'),
        table(r.items, [
          { label: 'Teil', render: (i) => d.parts[i.part].label },
          { label: 'Art', render: (i) => KIND[i.kind] ?? i.kind },
          { label: 'Name', render: (i) => h('span', null, i.name, i.note ? h('span', { class: 'muted small block' }, i.note) : null) },
          { label: 'Stand', render: (i) => (i.status === 'neu' ? badge('wird angelegt', 'info') : i.status === 'vorhanden' ? badge('vorhanden', 'ok') : badge('übersprungen', 'warn')) },
        ]));
    } catch (err) { mount(previewHost, notice('error', errorText(err))); }
  };

  const num = (v        , set                     , attrs                                  = {}) => input(String(v), (x) => set(Number(x)), { type: 'number', min: 1, ...attrs });
  mount(host,
    pageHead('ITSM-Grundausstattung', `Startkonfiguration für ${s.name}: Felder, Status, SLAs, automatische Nachrichten, Eskalation`),
    notice('info', 'Für einen schnellen Start nach bewährter ITSM-Praxis. Das Portal legt nur an, was es noch nicht gibt – Vorhandenes wird nicht verändert oder gelöscht, ähnlich benannte Felder werden übersprungen. Alles lässt sich danach in Zammad anpassen. Die Dokumentation beschreibt jedes Element.'),
    msg,
    h('section', { class: 'panel' },
      h('h2', null, 'Was soll angelegt werden?'),
      ...BASELINE_PARTS.map((k) => checkbox(o.parts[k], d.parts[k].label, (x) => { o.parts[k] = x; }, d.parts[k].description))),
    h('section', { class: 'panel' },
      h('h2', null, 'Arbeitszeiten und SLAs'),
      h('div', { class: 'grid-2' },
        fieldWrap(input(o.calendar.name, (x) => { o.calendar.name = x; }), { label: 'Name des Kalenders' }),
        fieldWrap(input(o.calendar.timezone, (x) => { o.calendar.timezone = x; }), { label: 'Zeitzone' }),
        fieldWrap(input(o.calendar.from, (x) => { o.calendar.from = x; }, { type: 'time' }), { label: 'Arbeitszeit von' }),
        fieldWrap(input(o.calendar.to, (x) => { o.calendar.to = x; }, { type: 'time' }), { label: 'bis' })),
      fieldWrap(h('div', { class: 'value-grid' }, ...WEEKDAYS.map((w) => checkbox(o.calendar.days.includes(w), DAY[w], (x) => { o.calendar.days = x ? [...new Set([...o.calendar.days, w])] : o.calendar.days.filter((y) => y !== w); }))), { label: 'Arbeitstage', help: 'Feiertage pflegt ihr danach im Kalender in Zammad.' }),
      h('p', { class: 'label' }, 'Zeiten je Priorität (in Minuten Arbeitszeit)'),
      table(PRIORITY_NAMES.map((n, i) => ({ n, i })), [
        { label: 'Priorität', render: (r) => r.n },
        { label: 'Reaktion', render: (r) => num(o.sla.response[r.i] , (x) => { o.sla.response[r.i] = x; }, { 'aria-label': `Reaktionszeit ${r.n}` }) },
        { label: 'Lösung', render: (r) => num(o.sla.solution[r.i] , (x) => { o.sla.solution[r.i] = x; }, { 'aria-label': `Lösungszeit ${r.n}` }) },
        { label: 'Standard', render: (r) => h('span', { class: 'muted small' }, `${hm(d.defaults.sla.response[r.i] )} / ${hm(d.defaults.sla.solution[r.i] )}`) },
      ])),
    h('section', { class: 'panel' },
      h('h2', null, 'Automatisch schließen und eskalieren'),
      h('div', { class: 'grid-2' },
        fieldWrap(num(o.autoClose.resolvedDays, (x) => { o.autoClose.resolvedDays = x; }), { label: '„Gelöst“ schließen nach … Tagen' }),
        fieldWrap(num(o.autoClose.remindDays, (x) => { o.autoClose.remindDays = x; }), { label: 'Bei „Warten auf Rückmeldung“ erinnern nach … Tagen' }),
        fieldWrap(num(o.autoClose.closeDays, (x) => { o.autoClose.closeDays = x; }), { label: 'Ohne Rückmeldung schließen nach … Tagen' }),
        fieldWrap(num(o.escalation.stage2Hours, (x) => { o.escalation.stage2Hours = x; }), { label: 'Eskalation Stufe 2 nach … Stunden' }),
        fieldWrap(input(o.escalation.stage2Email, (x) => { o.escalation.stage2Email = x; }, { type: 'email', placeholder: 'teamleitung@example.org' }), { label: 'Stufe 2 geht an', help: 'Muss ein Benutzer in Zammad sein. Leer = keine Stufe 2.' }),
        fieldWrap(input(o.customerLink, (x) => { o.customerLink = x; }, { type: 'url' }), { label: 'Link für Kunden in den E-Mails', help: 'z. B. die Adresse dieses Portals. Leer = kein Link.' }))),
    h('section', { class: 'panel' }, h('h2', null, 'Vorschau'), previewHost),
    h('div', { class: 'form-actions sticky' },
      button('Vorschau aktualisieren', preview, { icon: 'refresh' }),
      button('In Zammad anlegen', async () => {
        if (!await confirmDialog('Grundausstattung anlegen?', `Das Portal legt in „${s.name}“ die Elemente aus der Vorschau an. Vorhandenes bleibt unverändert.`, 'Anlegen')) return;
        try {
          const r = await post                                         (`/api/admin/systems/${s.id}/zammad/baseline/apply`, { options: o });
          mount(msg, r.errors.length ? notice('warn', `${r.created.length} Elemente angelegt, ${r.errors.length} Fehler:`, h('ul', null, ...r.errors.map((e) => h('li', null, e)))) : notice('ok', `${r.created.length} Elemente in Zammad angelegt.`));
          toast('Grundausstattung angelegt');
          await preview();
        } catch (err) { mount(msg, notice('error', errorText(err))); window.scrollTo({ top: 0 }); }
      }, { kind: 'primary' })),
  );
  void preview();
  return host;
}
