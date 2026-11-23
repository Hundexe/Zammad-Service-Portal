// Verwaltung: Zammad-Zuordnung und Einrichtung.
// Wie bildet das Portal Freigaben, Störungen, Wartungen und Probleme in Zammad ab? Prüfen, Überschneidungen mit
// vorhandenen Attributen übernehmen, Felder je Art ausblenden – und auf Knopfdruck in Zammad einrichten.
import { h, mount, relTime,            } from '../lib/dom.js?v=1060478b0baa';
import { get, post, put } from '../lib/api.js?v=1060478b0baa';
import { badge, button, checkbox, confirmDialog, errorText, fieldWrap, input, listInput, notice, pageHead, select, toast } from '../lib/ui.js?v=1060478b0baa';
import { admin, adminSystem, loadAdminSystems } from './common.js?v=1060478b0baa';
import { isAdvanced } from './mode.js?v=1060478b0baa';
import { ITSM_KINDS, KIND_LABEL,                                                                } from '../../shared/zammad-model.js?v=1060478b0baa';

                  
                                                          
                                                                                                                                                       
                                          
                                                                                                                                                                                                                       
                                                                                                     
                                              
 
                                                                                                                                             

const FOR_LABEL                                  = {
  requests: 'Anfragen', approvals: 'Freigaben', itsm: 'Störungen, Wartungen, Probleme', incidents: 'Störungen', maintenance: 'Wartungen', problems: 'Probleme',
};

export async function zammadPage(p                        ) {
  await loadAdminSystems();
  const s = adminSystem(p.systemId);
  const host = h('div');
  let d = await get        (`/api/admin/systems/${s.id}/zammad`);
  if (!d.report) d = { ...d, report: (await post                    (`/api/admin/systems/${s.id}/zammad/check`)).report };
  let m                = structuredClone(d.mapping);
  const msg = h('div', { attrs: { 'aria-live': 'polite' } });

  const save = async (next = m, quiet = false) => {
    try {
      const r = await put                                            (`/api/admin/systems/${s.id}/zammad`, { mapping: next });
      m = structuredClone(r.mapping);
      d = { ...d, mapping: r.mapping, report: r.report };
      if (!quiet) toast('Zuordnung gespeichert');
      draw();
    } catch (err) { mount(msg, notice('error', errorText(err))); window.scrollTo({ top: 0 }); }
  };

  const reportPanel = (r               )        => {
    if (!r) return null;
    if (r.error) return notice('error', h('strong', null, 'Zammad lässt sich nicht prüfen. '), r.error, h('p', { class: 'small' }, 'Der API-Benutzer braucht in Zammad die Rolle „Admin“ (Gruppen, Status, Objekt-Manager und Core Workflows).'));
    const items          = [
      ...r.missing.groups.map((g) => h('li', null, `Gruppe „${g}“`)),
      ...r.missing.states.map((x) => h('li', null, `Status „${x}“ (Typ „offen“)`)),
      ...r.missing.attributes.map((a) => h('li', null, `Attribut „${a.display}“ `, h('code', null, a.name))),
      ...r.missing.options.map((o) => h('li', null, `Auswahlwerte ${o.values.join(', ')} in `, h('code', null, o.attribute))),
      ...r.workflows.map((w) => h('li', null, `Abhängigkeit „${w}“`)),
    ];
    return h('section', { class: 'panel' },
      h('h2', null, 'Stand in Zammad ', r.ready ? badge('passt', 'ok') : badge('unvollständig', 'warn'), h('span', { class: 'muted small' }, ` geprüft ${relTime(r.checkedAt)}`)),
      items.length ? h('div', null, h('p', null, 'Das Portal legt an:'), h('ul', null, ...items)) : h('p', { class: 'muted' }, 'Alles, was das Portal braucht, ist vorhanden.'),
      r.problems.length ? notice('warn', h('strong', null, 'Bitte selbst klären: '), h('ul', null, ...r.problems.map((x) => h('li', null, x)))) : null,
      r.suggestions.length ? h('div', null,
        h('h3', null, 'Vorhandene Felder nutzen?'),
        h('p', { class: 'small muted' }, 'In eurem Zammad gibt es schon Passendes. Übernehmen statt neu anlegen – das Portal ergänzt dort höchstens fehlende Auswahlwerte.'),
        h('ul', { class: 'suggestions' }, ...r.suggestions.map((x) => h('li', null,
          x.type === 'attr'
            ? h('span', null, `„${x.display}“ (`, h('code', null, x.attribute), `) statt neuem „${x.portalDisplay}“`)
            : h('span', null, `${KIND_LABEL[x.kind]}: zusätzlich „${x.display}“ = ${x.valueLabel}`, h('span', { class: 'muted small' }, ' (damit eure SLAs, Trigger und Übersichten greifen)')),
          ' ',
          button('Übernehmen', () => {
            const next = structuredClone(m);
            if (x.type === 'attr') next.attrs[x.key] = x.attribute;
            else next.kinds[x.kind].fields[x.attribute] = x.value;
            void save(next);
          }, { kind: 'ghost' }))))) : null,
      h('div', { class: 'row' },
        button('Erneut prüfen', async () => { d = { ...d, report: (await post                    (`/api/admin/systems/${s.id}/zammad/check`)).report }; draw(); }, { kind: 'ghost', icon: 'refresh' }),
        button('In Zammad einrichten', async () => {
          if (!await confirmDialog('In Zammad einrichten?', `Das Portal legt in „${s.name}“ an, was oben aufgeführt ist, und schreibt seine Abhängigkeiten („Portal: …“) neu. Vorhandenes wird nicht gelöscht.`, 'Einrichten')) return;
          try {
            const r = await post                                       (`/api/admin/systems/${s.id}/zammad/apply`);
            d = { ...d, report: r.report };
            toast(r.created.length ? `${r.created.length} Punkte in Zammad eingerichtet` : 'Nichts zu tun');
            draw();
          } catch (err) { mount(msg, notice('error', errorText(err))); }
        }, { kind: 'primary' })),
    );
  };

  const draw = () => {
    const r = d.report;
    const zAttrs = r ? [...Object.entries(r.attributes).map(([name, a]) => ({ name, display: a.display })), ...r.others] : [];
    const attrOptions = (spec          ) => [
      { value: spec.name, label: `${spec.display} (${spec.name}, legt das Portal an)` },
      ...zAttrs.filter((a) => a.name !== spec.name && !a.name.startsWith('portal_')).map((a) => ({ value: a.name, label: `${a.display} (${a.name})` })),
    ];
    const tags = (v          , set                       , ph = 'Tag, einer pro Zeile') => listInput(v, set, ph);

    const kindPanel = (k          ) => {
      const km = m.kinds[k];
      let fieldsText = Object.entries(km.fields).map(([n, v]) => `${n}=${v}`).join('\n');
      const hideHost = h('div', { class: 'value-grid' }, ...(r?.others ?? []).map((a) => checkbox(km.hide.includes(a.name), a.display, (x) => {
        km.hide = x ? [...new Set([...km.hide, a.name])] : km.hide.filter((n) => n !== a.name);
      })));
      return h('section', { class: 'panel' },
        h('h3', null, KIND_LABEL[k]),
        h('div', { class: 'grid-2' },
          fieldWrap(input(km.group, (x) => { km.group = x.trim(); }, { placeholder: s.defaultGroup ?? '' }), { label: 'Gruppe in Zammad', help: `Leer = Standardgruppe (${s.defaultGroup ?? '–'}). Fehlt sie, legt das Portal sie an.` }),
          fieldWrap(tags(km.tags, (x) => { km.tags = x; }), { label: 'Tags', help: 'z. B. für Ausnahmen in SLAs oder Übersichten.' }),
          fieldWrap(listInput(fieldsText ? fieldsText.split('\n') : [], (x) => {
            fieldsText = x.join('\n');
            km.fields = Object.fromEntries(x.map((l) => l.split('=')).filter((p) => p.length === 2 && p[0] .trim() && p[1] .trim()).map(([n, v]) => [n .trim(), v .trim()]));
          }, 'attribut=wert'), { label: 'Zusätzliche Werte beim Anlegen', help: 'Damit die Tickets in eure Struktur passen, z. B. ticketart=stoerung. Eine Zuordnung pro Zeile.' }),
        ),
        r?.others.length ? fieldWrap(hideHost, { label: `Bei ${KIND_LABEL[k] === 'Problem' ? 'Problemen' : KIND_LABEL[k] === 'Störung' ? 'Störungen' : 'Wartungen'} ausblenden`, help: 'Diese vorhandenen Felder blendet Zammad bei dieser Art aus (Abhängigkeit „Portal: …“). Status, Gruppe, Besitzer und Priorität bleiben immer.' }) : null,
      );
    };

    mount(host,
      pageHead('Zammad-Zuordnung', `Wie das Portal in ${s.name} Freigaben, Störungen, Wartungen und Probleme abbildet`),
      notice('info', 'Ab Version 2.0 liegt alles im Ticketsystem: Anfragen mit Freigabe sind sofort Tickets, Störungen, Wartungen und Probleme sind Tickets mit dem Attribut „Portal: Art“. Das Portal ist die Oberfläche dafür. Die Standardwerte funktionieren ohne Anpassung.'),
      msg,
      reportPanel(r),
      h('section', { class: 'panel' },
        h('h2', null, 'Freigaben'),
        h('div', { class: 'grid-2' },
          fieldWrap(input(m.approval.state, (x) => { m.approval.state = x; }), { label: 'Status, solange die Freigabe aussteht', help: 'Fehlt er, legt das Portal ihn vom Typ „offen“ an. Tipp: nicht in die SLA-Bedingungen aufnehmen.' }),
          fieldWrap(input(m.approval.approvedState, (x) => { m.approval.approvedState = x; }), { label: 'Status nach der Freigabe' }),
          fieldWrap(input(m.approval.closedState, (x) => { m.approval.closedState = x; }), { label: 'Status nach Ablehnung, Rückzug oder Ablauf' }),
          fieldWrap(input(m.approval.approvedTag, (x) => { m.approval.approvedTag = x.trim(); }), { label: 'Tag nach der Freigabe', help: 'Leer = kein Tag.' }),
          fieldWrap(tags(m.approval.pendingTags, (x) => { m.approval.pendingTags = x; }), { label: 'Tags, solange die Freigabe aussteht', help: 'z. B. ein Tag, den eure Eskalation ausnimmt. Nach der Entscheidung entfernt das Portal ihn.' }),
        ),
        checkbox(m.approval.emailApprover, 'Freigebende Person per E-Mail aus Zammad informieren (mit Link ins Portal)', (x) => { m.approval.emailApprover = x; }),
        checkbox(m.approval.emailRequester, 'Anfragende Person nach der Entscheidung per E-Mail aus Zammad informieren', (x) => { m.approval.emailRequester = x; }),
      ),
      h('section', { class: 'panel' },
        h('h2', null, 'Störungen, Wartungen, Probleme'),
        ...ITSM_KINDS.map(kindPanel),
        h('div', { class: 'grid-2' },
          fieldWrap(tags(m.affectedTags, (x) => { m.affectedTags = x; }), { label: 'Tags an Tickets der Betroffenen', help: '„Ich bin auch betroffen“ legt ein Ticket an, verknüpft als Kind der Störung.' }),
        ),
        checkbox(m.closeAffected, 'Tickets der Betroffenen schließen, wenn die Störung behoben ist (auch wenn sie in Zammad geschlossen wird)', (x) => { m.closeAffected = x; }),
        checkbox(m.workflows, 'Abhängigkeiten in Zammad pflegen: Portal-Felder nur zeigen, wo sie gebraucht werden', (x) => { m.workflows = x; }),
      ),
      isAdvanced() ? h('section', { class: 'panel' },
        h('h2', null, 'Attribute'),
        h('p', { class: 'small muted' }, 'Jedes Portal-Attribut lässt sich auf ein vorhandenes Attribut umlenken. Typ und Bedeutung sollten passen; das Portal ergänzt dort nur fehlende Auswahlwerte.'),
        h('div', { class: 'grid-2' }, ...d.specs.map((spec) => fieldWrap(
          zAttrs.length ? select(m.attrs[spec.key], attrOptions(spec).some((o) => o.value === m.attrs[spec.key]) ? attrOptions(spec) : [{ value: m.attrs[spec.key], label: m.attrs[spec.key] }, ...attrOptions(spec)], (x) => { m.attrs[spec.key] = x; })
            : input(m.attrs[spec.key], (x) => { m.attrs[spec.key] = x.trim(); }),
          { label: spec.display.replace(/^Portal: /, ''), help: `${FOR_LABEL[spec.for]} · ${spec.type}` },
        ))),
      ) : h('p', { class: 'small muted' }, 'Die Namen der einzelnen Attribute zeigt die Ansicht „Erweitert“.'),
      h('div', { class: 'form-actions sticky' },
        button('Speichern und prüfen', () => save(), { kind: 'primary' }),
        button('Auf Standard zurücksetzen', async () => {
          if (await confirmDialog('Zuordnung zurücksetzen?', 'Alle Einstellungen auf dieser Seite gehen auf den Standard zurück. In Zammad wird nichts gelöscht.', 'Zurücksetzen')) void save(structuredClone(d.defaults));
        }, { kind: 'ghost' }),
      ),
    );
  };
  draw();
  void admin;
  return host;
}
