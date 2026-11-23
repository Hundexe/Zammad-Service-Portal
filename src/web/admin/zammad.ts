// Verwaltung: Zammad-Zuordnung und Einrichtung.
// Wie bildet das Portal Freigaben, Störungen, Wartungen und Probleme in Zammad ab? Prüfen, Überschneidungen mit
// vorhandenen Attributen übernehmen, Felder je Art ausblenden – und auf Knopfdruck in Zammad einrichten.
import { h, mount, relTime, type Child } from '../lib/dom.ts';
import { get, post, put } from '../lib/api.ts';
import { badge, button, checkbox, confirmDialog, errorText, fieldWrap, input, listInput, notice, pageHead, select, table, toast } from '../lib/ui.ts';
import { admin, adminSystem, loadAdminSystems } from './common.ts';
import { isAdvanced } from './mode.ts';
import { ITSM_KINDS, KIND_LABEL, OVERVIEW_INFO, OVERVIEW_KEYS, STATE_ROLES, STATE_ROLE_LABEL, type AttrKey, type AttrSpec, type ItsmKind, type StateRole, type ZammadMapping } from '../../shared/zammad-model.ts';

interface Report {
  checkedAt: number; ready: boolean; error: string | null;
  missing: {
    groups: string[]; states: string[]; attributes: { name: string; display: string }[]; options: { attribute: string; values: string[] }[];
    labels: { attribute: string; from: string; to: string }[]; overviews: string[];
  };
  problems: string[]; notes: string[]; workflows: string[];
  suggestions: ({ type: 'attr'; key: AttrKey; attribute: string; display: string; portalDisplay: string } | { type: 'kind'; kind: ItsmKind; attribute: string; display: string; value: string; valueLabel: string })[];
  attributes: Record<string, { display: string; dataType: string; options: Record<string, string> }>;
  others: { name: string; display: string; dataType?: string }[];
  states: { name: string; type: string | null }[];
  resolvedStates: Record<StateRole, string | null>;
}
interface Loaded { mapping: ZammadMapping; defaults: ZammadMapping; specs: AttrSpec[]; report: Report | null; workflows: { name: string }[] }

const FOR_LABEL: Record<AttrSpec['for'], string> = {
  requests: 'Anfragen', approvals: 'Freigaben', itsm: 'Störungen, Wartungen, Probleme', incidents: 'Störungen', maintenance: 'Wartungen', problems: 'Probleme',
};
const TYPE_LABEL: Record<string, string> = {
  input: 'Text', textarea: 'Text (mehrzeilig)', select: 'Auswahl', multiselect: 'Mehrfachauswahl', tree_select: 'Auswahl (Baum)', multi_tree_select: 'Mehrfachauswahl (Baum)',
  boolean: 'Ja/Nein', datetime: 'Datum und Uhrzeit', date: 'Datum', integer: 'Zahl',
};
const STATE_TYPE_LABEL: Record<string, string> = { new: 'neu', open: 'offen', closed: 'geschlossen', 'pending reminder': 'warten (Erinnerung)', 'pending action': 'warten (Aktion)', merged: 'zusammengeführt', removed: 'entfernt' };

export async function zammadPage(p: Record<string, string>) {
  await loadAdminSystems();
  const s = adminSystem(p.systemId);
  const host = h('div');
  let d = await get<Loaded>(`/api/admin/systems/${s.id}/zammad`);
  if (!d.report) d = { ...d, report: (await post<{ report: Report }>(`/api/admin/systems/${s.id}/zammad/check`)).report };
  let m: ZammadMapping = structuredClone(d.mapping);
  // Formulare für eigene Übersichten (z. B. alle Software-Anfragen, auch die noch nicht freigegebenen)
  const forms = await get<{ forms: { id: string; name: string }[] }>(`/api/admin/systems/${s.id}/forms`).then((x) => x.forms).catch(() => [] as { id: string; name: string }[]);
  const msg = h('div', { attrs: { 'aria-live': 'polite' } });

  const save = async (next = m, quiet = false) => {
    try {
      const r = await put<{ mapping: ZammadMapping; report: Report }>(`/api/admin/systems/${s.id}/zammad`, { mapping: next });
      m = structuredClone(r.mapping);
      d = { ...d, mapping: r.mapping, report: r.report };
      if (!quiet) toast('Zuordnung gespeichert');
      draw();
    } catch (err) { mount(msg, notice('error', errorText(err))); window.scrollTo({ top: 0 }); }
  };

  const reportPanel = (r: Report | null): Child => {
    if (!r) return null;
    if (r.error) return notice('error', h('strong', null, 'Zammad lässt sich nicht prüfen. '), r.error, h('p', { class: 'small' }, 'Der API-Benutzer braucht in Zammad die Rolle „Admin“ (Gruppen, Status, Objekt-Manager und Core Workflows).'));
    const items: Child[] = [
      ...r.missing.groups.map((g) => h('li', null, `Gruppe „${g}“`)),
      ...r.missing.states.map((x) => h('li', null, `Status „${x}“ (Typ „offen“)`)),
      ...r.missing.attributes.map((a) => h('li', null, `Attribut „${a.display}“ `, h('code', null, a.name))),
      ...r.missing.options.map((o) => h('li', null, `Auswahlwerte ${o.values.join(', ')} in `, h('code', null, o.attribute))),
      ...r.missing.labels.map((l) => h('li', null, `Bezeichnung „${l.from}“ → „${l.to}“ in `, h('code', null, l.attribute))),
      ...r.missing.overviews.map((o) => h('li', null, `Übersicht „${o}“`)),
      ...r.workflows.map((w) => h('li', null, `Abhängigkeit „${w}“`)),
    ];
    return h('section', { class: 'panel' },
      h('h2', null, 'Stand in Zammad ', r.ready ? badge('passt', 'ok') : badge('unvollständig', 'warn'), h('span', { class: 'muted small' }, ` geprüft ${relTime(r.checkedAt)}`)),
      items.length ? h('div', null, h('p', null, 'Das Portal legt an:'), h('ul', null, ...items)) : h('p', { class: 'muted' }, 'Alles, was das Portal braucht, ist vorhanden.'),
      r.problems.length ? notice('warn', h('strong', null, 'Bitte selbst klären: '), h('ul', null, ...r.problems.map((x) => h('li', null, x)))) : null,
      r.notes.length ? notice('info', h('strong', null, 'Hinweise: '), h('ul', null, ...r.notes.map((x) => h('li', null, x)))) : null,
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
        button('Erneut prüfen', async () => { d = { ...d, report: (await post<{ report: Report }>(`/api/admin/systems/${s.id}/zammad/check`)).report }; draw(); }, { kind: 'ghost', icon: 'refresh' }),
        button('In Zammad einrichten', async () => {
          if (!await confirmDialog('In Zammad einrichten?', `Das Portal legt in „${s.name}“ an, was oben aufgeführt ist, und schreibt seine Abhängigkeiten („${m.names.workflowPrefix}…“) und Übersichten neu. Vorhandenes wird nicht gelöscht.`, 'Einrichten')) return;
          try {
            const r = await post<{ report: Report; created: string[] }>(`/api/admin/systems/${s.id}/zammad/apply`);
            d = { ...d, report: r.report };
            toast(r.created.length ? `${r.created.length} Punkte in Zammad eingerichtet` : 'Nichts zu tun');
            draw();
          } catch (err) { mount(msg, notice('error', errorText(err))); }
        }, { kind: 'primary' })),
    );
  };

  const draw = () => {
    const r = d.report;
    const adv = isAdvanced();
    const zAttrs = r ? [...Object.entries(r.attributes).map(([name, a]) => ({ name, display: a.display })), ...r.others] : [];
    const attrOptions = (spec: AttrSpec) => [
      { value: spec.name, label: `${spec.name} (legt das Portal an)` },
      ...zAttrs.filter((a) => a.name !== spec.name && !a.name.startsWith('portal_')).map((a) => ({ value: a.name, label: `${a.name} – ${a.display}` })),
    ];
    const tags = (v: string[], set: (x: string[]) => void, ph = 'Tag, einer pro Zeile') => listInput(v, set, ph);
    const kindPlural = (k: ItsmKind) => ({ incident: 'Störungen', maintenance: 'Wartungen', problem: 'Problemen' })[k];

    // ------------------------------------------------ Felder – wie der Objekt-Manager in Zammad
    const stand = (spec: AttrSpec): Child => {
      const name = m.attrs[spec.key];
      if (!r) return null;
      if (r.missing.attributes.some((a) => a.name === name)) return badge('wird angelegt', 'info');
      const have = r.attributes[name];
      if (!have) return badge('nicht benötigt', 'neutral');
      if (r.missing.labels.some((l) => l.attribute === name) || r.missing.options.some((o) => o.attribute === name)) return badge('wird angepasst', 'warn');
      return badge('vorhanden', 'ok');
    };
    const fieldTable = table(d.specs, [
      { label: 'Anzeige', class: 'grow', render: (spec) => input(m.names.attrs[spec.key] ?? '', (x) => { const v = x.trim(); if (v) m.names.attrs[spec.key] = v; else delete m.names.attrs[spec.key]; }, { placeholder: spec.display, 'aria-label': `Anzeige für ${spec.display}`, maxlength: 60 }) },
      { label: 'Name', render: (spec) => adv
        ? (zAttrs.length
          ? select(m.attrs[spec.key], attrOptions(spec).some((o) => o.value === m.attrs[spec.key]) ? attrOptions(spec) : [{ value: m.attrs[spec.key], label: m.attrs[spec.key] }, ...attrOptions(spec)], (x) => { m.attrs[spec.key] = x; }, { ariaLabel: `Zammad-Attribut für ${spec.display}` })
          : input(m.attrs[spec.key], (x) => { m.attrs[spec.key] = x.trim(); }, { 'aria-label': `Zammad-Attribut für ${spec.display}` }))
        : h('code', null, m.attrs[spec.key]) },
      { label: 'Typ', render: (spec) => TYPE_LABEL[spec.type] ?? spec.type },
      { label: 'Verwendet für', render: (spec) => FOR_LABEL[spec.for] },
      { label: 'Stand', render: stand },
    ]);

    // ------------------------------------------------ Arten
    const kindPanel = (k: ItsmKind) => {
      const km = m.kinds[k];
      let fieldsText = Object.entries(km.fields).map(([n, v]) => `${n}=${v}`).join('\n');
      const hideHost = h('div', { class: 'value-grid' }, ...(r?.others ?? []).map((a) => checkbox(km.hide.includes(a.name), a.display, (x) => {
        km.hide = x ? [...new Set([...km.hide, a.name])] : km.hide.filter((n) => n !== a.name);
      })));
      return h('section', { class: 'panel' },
        h('h3', null, m.names.kinds[k]),
        h('div', { class: 'grid-2' },
          fieldWrap(input(m.names.kinds[k], (x) => { m.names.kinds[k] = x.trim() || KIND_LABEL[k]; }, { maxlength: 40 }), { label: 'Bezeichnung in Zammad', help: `Wert im Feld „${m.names.attrs.kind || 'Portal: Art'}“. Standard: ${KIND_LABEL[k]}.` }),
          fieldWrap(input(km.group, (x) => { km.group = x.trim(); }, { placeholder: s.defaultGroup ?? '' }), { label: 'Gruppe in Zammad', help: `Leer = Standardgruppe (${s.defaultGroup ?? '–'}). Fehlt sie, legt das Portal sie an.` }),
          fieldWrap(tags(km.tags, (x) => { km.tags = x; }), { label: 'Tags', help: 'z. B. für Ausnahmen in SLAs oder Übersichten.' }),
          adv ? fieldWrap(listInput(fieldsText ? fieldsText.split('\n') : [], (x) => {
            fieldsText = x.join('\n');
            km.fields = Object.fromEntries(x.map((l) => l.split('=')).filter((p) => p.length === 2 && p[0]!.trim() && p[1]!.trim()).map(([n, v]) => [n!.trim(), v!.trim()]));
          }, 'attribut=wert'), { label: 'Zusätzliche Werte beim Anlegen', help: 'Damit die Tickets in eure Struktur passen, z. B. ticketart=stoerung. Eine Zuordnung pro Zeile.' }) : null,
        ),
        adv && r?.others.length ? fieldWrap(hideHost, { label: `Bei ${kindPlural(k)} ausblenden`, help: `Diese vorhandenen Felder blendet Zammad bei dieser Art aus (Abhängigkeit „${m.names.workflowPrefix}…“). Status, Gruppe, Besitzer und Priorität bleiben immer.` }) : null,
      );
    };

    // ------------------------------------------------ Status
    const stateOpts = (r?.states ?? []).map((x) => ({ value: x.name, label: `${x.name}${x.type ? ` (${STATE_TYPE_LABEL[x.type] ?? x.type})` : ''}` }));
    const stateSelect = (value: string, set: (v: string) => void, auto: string | null | undefined, label: string) => stateOpts.length
      ? select(value, [{ value: '', label: `automatisch${auto ? ` – ${auto}` : ''}` }, ...(value && !stateOpts.some((o) => o.value === value) ? [{ value, label: `${value} (gibt es nicht)` }] : []), ...stateOpts], set, { ariaLabel: label })
      : input(value, (x) => set(x.trim()), { placeholder: 'automatisch (nach Typ)', 'aria-label': label });
    const statePanel = h('section', { class: 'panel' },
      h('h2', null, 'Status'),
      h('p', { class: 'small muted' }, 'Das Portal setzt Status nie über feste Namen. „Automatisch“ nimmt den aktiven Zammad-Status vom passenden Typ (bei mehreren den als Standard markierten). So funktionieren auch umbenannte Status wie „1 Neu“ oder „9 Erledigt“.'),
      h('div', { class: 'grid-3' }, ...STATE_ROLES.map((role) => fieldWrap(stateSelect(m.states[role], (x) => { m.states[role] = x; }, r?.resolvedStates?.[role], STATE_ROLE_LABEL[role]), { label: STATE_ROLE_LABEL[role] }))),
      h('div', { class: 'grid-2' },
        fieldWrap(stateSelect(m.approval.approvedState, (x) => { m.approval.approvedState = x; }, m.states.new || r?.resolvedStates?.new, 'Status nach der Freigabe'), { label: 'Status nach der Freigabe' }),
        fieldWrap(stateSelect(m.approval.closedState, (x) => { m.approval.closedState = x; }, m.states.closed || r?.resolvedStates?.closed, 'Status nach Ablehnung'), { label: 'Status nach Ablehnung, Rückzug oder Ablauf' }),
      ),
    );

    // ------------------------------------------------ Übersichten
    const formRows = h('div', { class: 'stack' });
    const drawForms = () => mount(formRows, ...m.overviews.forms.map((fo, i) => h('div', { class: 'row' },
      select(fo.formId, forms.map((f) => ({ value: f.id, label: f.name })), (x) => { fo.formId = x; }, { ariaLabel: 'Formular' }),
      input(fo.name, (x) => { fo.name = x.trim(); }, { 'aria-label': 'Name der Übersicht', maxlength: 60 }),
      button('Entfernen', () => { m.overviews.forms.splice(i, 1); drawForms(); }, { kind: 'ghost' }),
    )));
    drawForms();
    const overviewPanel = h('section', { class: 'panel' },
      h('h2', null, 'Übersichten in Zammad'),
      h('p', { class: 'small muted' }, 'Für Agenten: je Art eine eigene Übersicht mit allen offenen Tickets (auch wartenden). Die Namen sind frei wählbar.'),
      adv ? checkbox(m.overviews.enabled, 'Übersichten in Zammad pflegen', (x) => { m.overviews.enabled = x; }) : null,
      h('div', { class: 'grid-2' }, ...OVERVIEW_KEYS.map((k) => h('div', { class: 'stack' },
        checkbox(m.overviews.builtin[k].active, `${OVERVIEW_INFO[k].name} – ${OVERVIEW_INFO[k].description}`, (x) => { m.overviews.builtin[k].active = x; }),
        input(m.overviews.builtin[k].name, (x) => { m.overviews.builtin[k].name = x.trim() || OVERVIEW_INFO[k].name; }, { 'aria-label': `Name der Übersicht ${OVERVIEW_INFO[k].name}`, maxlength: 60 }),
      ))),
      h('h3', null, 'Je Formular'),
      h('p', { class: 'small muted' }, 'z. B. „Software-Anfragen“: alle offenen Tickets aus diesem Formular – auch die, die noch auf Freigabe warten.'),
      formRows,
      forms.length ? button('Übersicht für ein Formular hinzufügen', () => {
        const f = forms.find((x) => !m.overviews.forms.some((o) => o.formId === x.id)) ?? forms[0]!;
        m.overviews.forms.push({ formId: f.id, name: f.name });
        drawForms();
      }, { kind: 'ghost', icon: 'plus' }) : h('p', { class: 'small muted' }, 'Noch keine Formulare.'),
    );

    mount(host,
      pageHead('Zammad-Zuordnung', `Wie das Portal in ${s.name} Freigaben, Störungen, Wartungen und Probleme abbildet`),
      notice('info', 'Alles liegt im Ticketsystem: Anfragen mit Freigabe sind sofort Tickets, Störungen, Wartungen und Probleme sind Tickets mit dem Feld „Art“. Die Standardwerte funktionieren ohne Anpassung; Bezeichnungen lassen sich hier ändern.', adv ? null : ' Technische Namen, Status und Abhängigkeiten zeigt die Ansicht „Erweitert“.'),
      msg,
      reportPanel(r),
      h('section', { class: 'panel' },
        h('h2', null, 'Felder'),
        h('p', { class: 'small muted' }, adv
          ? 'Wie im Objekt-Manager von Zammad. „Anzeige“ ist der Name in Zammad (leer = Standard). Unter „Name“ lässt sich jedes Feld auf ein vorhandenes Attribut umlenken – Typ und Bedeutung sollten passen; das Portal ergänzt dort nur fehlende Auswahlwerte.'
          : 'Wie im Objekt-Manager von Zammad. „Anzeige“ ist der Name, den Agenten in Zammad sehen (leer = Standard).'),
        fieldTable,
      ),
      h('section', { class: 'panel' },
        h('h2', null, 'Freigaben'),
        h('div', { class: 'grid-2' },
          adv ? fieldWrap(input(m.approval.state, (x) => { m.approval.state = x; }), { label: 'Status, solange die Freigabe aussteht', help: 'Fehlt er, legt das Portal ihn vom Typ „offen“ an. Tipp: nicht in die SLA-Bedingungen aufnehmen.' }) : null,
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
      ),
      overviewPanel,
      adv ? statePanel : null,
      adv ? h('section', { class: 'panel' },
        h('h2', null, 'Abhängigkeiten (Core Workflows)'),
        checkbox(m.workflows, 'Abhängigkeiten in Zammad pflegen: Portal-Felder nur zeigen, wo sie gebraucht werden', (x) => { m.workflows = x; }),
        fieldWrap(input(m.names.workflowPrefix, (x) => { m.names.workflowPrefix = x; }, { maxlength: 30 }), { label: 'Vorsilbe der Namen', help: 'Die Workflows erkennt das Portal an einer Kennung in der Notiz – Umbenennen legt keine Doppelten an.' }),
      ) : null,
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
