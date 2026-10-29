// Verwaltung: Übersicht, Zustellung, Audit-Log, Updates.
import { h, mount, fmtDate, relTime } from '../lib/dom.ts';
import { get, post } from '../lib/api.ts';
import { badge, button, confirmDialog, dialog, emptyState, errorText, fieldWrap, notice, pageHead, select, statusBadge, table, textarea, toast } from '../lib/ui.ts';
import { can, link, navigate, curPath, curSearch } from '../lib/app.ts';
import { admin, loadAdminSystems } from './common.ts';

export async function dashboardPage() {
  await loadAdminSystems();
  const d = await get<{
    version: string; systems: { id: string; name: string; status: string }[]; requests7d: Record<string, number>; failed: number; awaitingApproval: number;
    pendingApprovals: { forms: { id: string; form_id: string; version: number; name: string; system_id: string }[]; branding: { id: string; system_id: string; version: number }[] };
    warnings: string[]; update: { latest_version: string | null; current_version: string | null; updater_seen_at: number | null } | null;
  }>('/api/admin/overview');
  const sysName = (id: string) => d.systems.find((s) => s.id === id)?.name ?? '';
  const approvals = [...d.pendingApprovals.forms.map((f) => ({ label: `Formular „${f.name}“, Version ${f.version}`, sys: f.system_id, href: `/admin/systeme/${f.system_id}/formulare/${f.form_id}` })),
    ...d.pendingApprovals.branding.map((b) => ({ label: `Stil, Farben, Logo – Version ${b.version}`, sys: b.system_id, href: `/admin/systeme/${b.system_id}/branding` }))];
  const delivered = d.requests7d.delivered ?? 0;
  const waiting = (d.requests7d.queued ?? 0) + (d.requests7d.sending ?? 0);
  return h('div', null,
    pageHead('Verwaltung', `Service-Portal, Version ${d.version}`),
    d.warnings.length ? h('section', { class: 'panel' }, h('h2', null, 'Zu erledigen'), h('ul', { class: 'todo' }, ...d.warnings.map((w) => h('li', null, w)))) : null,
    h('div', { class: 'stats' },
      h('div', { class: 'stat' }, h('span', { class: 'stat-n' }, String(delivered)), h('span', null, 'Anfragen übermittelt (7 Tage)')),
      h('div', { class: ['stat', waiting > 0 && 'stat-info'] }, h('span', { class: 'stat-n' }, String(waiting)), h('span', null, 'warten auf Zustellung'),
        d.awaitingApproval ? h('span', { class: 'small' }, link('/admin/zustellung?status=awaiting_approval', `außerdem ${d.awaitingApproval} bei Vorgesetzten zur Freigabe`)) : null),
      h('div', { class: ['stat', d.failed > 0 && 'stat-bad'] }, h('span', { class: 'stat-n' }, String(d.failed)), h('span', null, d.failed ? link('/admin/zustellung?status=failed', 'fehlgeschlagen') : 'fehlgeschlagen'))),
    approvals.length ? h('section', { class: 'panel' }, h('h2', null, 'Wartet auf Ihre Freigabe'),
      h('ul', { class: 'plain' }, ...approvals.map((a) => h('li', null, link(a.href, a.label), h('span', { class: 'muted' }, ` (${sysName(a.sys)})`))))) : null,
    h('section', { class: 'panel' }, h('h2', null, 'Ticketsysteme'),
      d.systems.length ? table(d.systems, [
        { label: 'Name', class: 'grow', render: (s) => link(`/admin/systeme/${s.id}`, s.name) },
        { label: 'Status', render: (s) => statusBadge(s.status) },
        { label: '', render: (s) => link(`/admin/systeme/${s.id}/formulare`, 'Formulare') },
      ]) : emptyState('Noch kein Ticketsystem', 'Verbinden Sie zuerst eine Zammad-Instanz.', admin.canCreate ? link('/admin/systeme', 'Ticketsystem hinzufügen') : undefined)),
  );
}

export async function deliveryPage(_p: Record<string, string>, q: URLSearchParams) {
  const status = q.get('status') ?? '';
  const r = await get<{ requests: { id: string; systemName: string; title: string; status: string; attempts: number; lastError: string | null; ticketNumber: string | null; createdAt: number; userName: string; nextAttemptAt: number; systemId: string }[] }>(`/api/admin/requests${status ? `?status=${status}` : ''}`);
  return h('div', null,
    pageHead('Zustellung', 'Anfragen auf dem Weg vom Portal nach Zammad'),
    h('div', { class: 'row' }, select(status, [{ value: 'failed', label: 'Fehlgeschlagen' }, { value: 'queued', label: 'Wartend' }, { value: 'delivered', label: 'Übermittelt' },
      { value: 'awaiting_approval', label: 'Wartet auf Freigabe' }, { value: 'rejected', label: 'Abgelehnt' }, { value: 'withdrawn', label: 'Zurückgezogen' }, { value: 'expired', label: 'Abgelaufen' }, { value: 'cancelled', label: 'Abgebrochen' }], (x) => navigate(`/admin/zustellung${x ? `?status=${x}` : ''}`), { empty: 'Alle' })),
    table(r.requests, [
      { label: 'Gesendet', render: (x) => fmtDate(x.createdAt) },
      { label: 'Betreff', class: 'grow', render: (x) => h('span', null, x.title, h('br'), h('span', { class: 'muted small' }, `${x.userName}, ${x.systemName}`)) },
      { label: 'Status', render: (x) => h('span', null, statusBadge(x.status), x.status === 'queued' && x.attempts > 0 ? h('span', { class: 'muted small' }, ` nächster Versuch ${relTime(x.nextAttemptAt).replace('vor', 'in')}`) : null) },
      { label: 'Ticket', class: 'num', render: (x) => x.ticketNumber ? `#${x.ticketNumber}` : '' },
      { label: 'Letzter Fehler', render: (x) => x.lastError ? h('span', { class: 'small' }, x.lastError) : '' },
      { label: '', render: (x) => can('system.manage', x.systemId) && ['failed', 'queued', 'awaiting_approval'].includes(x.status) ? h('span', { class: 'row' },
        x.status === 'failed' ? button('Erneut senden', async () => {
          try { await post(`/api/admin/requests/${x.id}/retry`); toast('Wird erneut gesendet'); navigate(curPath() + curSearch(), true); } catch (err) { toast(errorText(err), 'error'); }
        }, { kind: 'ghost', icon: 'refresh' }) : null,
        button('Abbrechen', () => void cancelDialog(x), { kind: 'ghost', icon: 'x' })) : null },
    ], { empty: 'Keine Anfragen in dieser Ansicht.' }));
}

/** Anfrage abbrechen: Inhalt und Anhänge werden gelöscht, nichts geht an Zammad. */
async function cancelDialog(x: { id: string; title: string; userName: string; status: string }) {
  let reason = '';
  const msg = h('div');
  const field = textarea('', (v) => { reason = v; }, { rows: 3, maxlength: 2000 });
  await dialog('Anfrage abbrechen?', h('div', { class: 'stack' }, msg,
    h('p', null, `„${x.title}“ von ${x.userName} wird nicht an Zammad übermittelt. Inhalt und Anhänge werden gelöscht.`
      + (x.status === 'awaiting_approval' ? ' Die offene Freigabe wird beendet.' : '') + ' Die Person wird im Portal benachrichtigt.'),
    fieldWrap(field, { label: 'Grund (freiwillig)', help: 'Steht in der Benachrichtigung und im Audit-Log.' })),
  (close) => [
    button('Zurück', () => close(), { kind: 'ghost' }),
    button('Anfrage abbrechen', async () => {
      try {
        await post(`/api/admin/requests/${x.id}/cancel`, { reason });
        close();
        toast('Anfrage abgebrochen');
        navigate(curPath() + curSearch(), true);
      } catch (err) { mount(msg, notice('error', errorText(err))); }
    }, { kind: 'danger' }),
  ]);
}

const ACTIONS: Record<string, string> = {
  'login.success': 'Anmeldung', 'login.failed': 'Anmeldung fehlgeschlagen', 'login.locked': 'Konto gesperrt', 'login.password_ok': 'Passwort korrekt', 'login.totp_failed': 'Code falsch', logout: 'Abmeldung',
  'stepup.success': 'Erneute Anmeldung', 'stepup.failed': 'Erneute Anmeldung fehlgeschlagen',
  'user.created': 'Benutzer angelegt', 'user.updated': 'Benutzer geändert', 'user.password_reset': 'Passwort zurückgesetzt', 'user.password_changed': 'Passwort geändert', 'user.totp_enabled': '2FA eingerichtet', 'user.unlocked': 'Benutzer entsperrt',
  'system.created': 'Ticketsystem angelegt', 'system.updated': 'Ticketsystem geändert', 'system.deleted': 'Ticketsystem gelöscht', 'system.tested': 'Verbindung getestet', 'attributes.released': 'Zammad-Objekte freigegeben', 'form.meta_staged': 'Formular-Angaben vorgemerkt', 'login.email_rejected': 'Mail-Adresse nicht übernommen',
  'form.created': 'Formular angelegt', 'form.updated': 'Formular geändert', 'form.deleted': 'Formular gelöscht', 'form.draft_saved': 'Entwurf gespeichert', 'form.published': 'Formular veröffentlicht', 'form.submitted_for_approval': 'Zur Freigabe gesendet', 'form.approved': 'Formular freigegeben', 'form.rejected': 'Freigabe abgelehnt', 'form.restored': 'Version wiederhergestellt', 'form.copied': 'Formular kopiert',
  'template.created': 'Vorlage angelegt', 'template.updated': 'Vorlage geändert', 'template.deleted': 'Vorlage gelöscht',
  'overview.created': 'Übersicht angelegt', 'overview.updated': 'Übersicht geändert', 'overview.deleted': 'Übersicht gelöscht',
  'branding.draft_saved': 'Branding-Entwurf', 'branding.published': 'Branding veröffentlicht', 'branding.submitted_for_approval': 'Branding zur Freigabe', 'branding.approved': 'Branding freigegeben', 'branding.rejected': 'Branding abgelehnt', 'asset.uploaded': 'Bild hochgeladen', 'settings.branding': 'Anmeldeseite geändert',
  'role.created': 'Rolle angelegt', 'role.updated': 'Rolle geändert', 'role.deleted': 'Rolle gelöscht', 'role.assigned': 'Rolle zugeordnet', 'role.unassigned': 'Zuordnung entfernt',
  'request.created': 'Anfrage gesendet', 'request.retry': 'Erneut gesendet',
  'approval.requested': 'Freigabe erbeten', 'approval.approved': 'Anfrage freigegeben', 'approval.rejected': 'Anfrage abgelehnt', 'approval.withdrawn': 'Anfrage zurückgezogen',
  'approval.reassigned': 'Freigebende Person geändert', 'approval.expired': 'Freigabe abgelaufen', 'request.cancelled': 'Anfrage abgebrochen', 'transfer.exported': 'Export erstellt', 'transfer.imported': 'Import ausgeführt', 'ticket.reply': 'Antwort gesendet',
  'update.requested': 'Update angefordert', 'update.check_requested': 'Update-Prüfung angefordert', 'audit.exported': 'Audit-Log exportiert',
};

export async function auditPage(_p: Record<string, string>, q: URLSearchParams) {
  await loadAdminSystems();
  const action = q.get('aktion') ?? '';
  const host = h('div');
  const rows: any[] = [];
  let global = false;
  const listHost = h('div');
  const more = h('div', { class: 'row' });
  const load = async (before?: number) => {
    const r = await get<{ entries: any[]; global: boolean }>(`/api/admin/audit?${new URLSearchParams({ limit: '100', ...(before ? { before: String(before) } : {}), ...(action ? { action } : {}) })}`);
    global = r.global;
    rows.push(...r.entries);
    mount(listHost, table(rows, [
      { label: 'Zeit', render: (e) => fmtDate(e.at) },
      { label: 'Person', render: (e) => h('span', null, e.actor_name ?? '–', e.ip ? h('br') : null, e.ip ? h('span', { class: 'muted small' }, e.ip) : null) },
      { label: 'Aktion', render: (e) => ACTIONS[e.action] ?? e.action },
      { label: 'Ticketsystem', render: (e) => admin.systems.find((s) => s.id === e.system_id)?.name ?? '' },
      { label: 'Details', class: 'grow', render: (e) => e.details ? h('details', { class: 'audit-details' }, h('summary', null, 'anzeigen'), h('pre', null, JSON.stringify(e.details, null, 2))) : '' },
    ], { empty: 'Keine Einträge.' }));
    mount(more, r.entries.length === 100 ? button('Ältere laden', () => load(rows[rows.length - 1].seq)) : null);
  };
  await load();
  const verifyResult = h('span');
  mount(host,
    pageHead('Audit-Log', 'Alle Anmeldungen und Änderungen, nicht nachträglich änderbar', global ? [
      button('Integrität prüfen', async () => {
        const r = await get<{ ok: boolean; brokenAt: number | null; count: number }>('/api/admin/audit/verify');
        mount(verifyResult, r.ok ? badge(`unverändert, ${r.count} Einträge`, 'ok') : badge(`verändert ab Eintrag ${r.brokenAt}`, 'error'));
      }),
      h('a', { class: ['btn', 'btn-secondary'], attrs: { href: '/api/admin/audit/export', download: '' } }, 'Als CSV exportieren'),
    ] : []),
    h('div', { class: 'row' }, select(action, [
      { value: 'login', label: 'Anmeldungen' }, { value: 'form', label: 'Formulare' }, { value: 'role', label: 'Rollen' }, { value: 'user', label: 'Benutzer' },
      { value: 'system', label: 'Ticketsysteme' }, { value: 'branding', label: 'Branding' }, { value: 'update', label: 'Updates' }, { value: 'request', label: 'Anfragen' },
    ], (x) => navigate(`/admin/audit${x ? `?aktion=${x}` : ''}`), { empty: 'Alle Aktionen' }), verifyResult),
    listHost, more);
  return host;
}

export async function updatesPage() {
  const d = await get<{ runningVersion: string; installMode?: 'docker' | 'native'; currentVersion: string; latestVersion: string | null; available: string[]; changelog: string; checkedAt: number | null; lastError: string | null; updaterOnline: boolean; jobs: { id: string; requestedBy: string; targetVersion: string; status: string; log: string; createdAt: number; finishedAt: number | null }[] }>('/api/admin/updates');
  const newer = d.available.filter((v) => v !== d.runningVersion);
  const native = d.installMode === 'native';
  // Ohne Prüfung oder ohne veröffentlichte Versionen nicht „aktuell“ behaupten
  const emptyText = !d.checkedAt ? 'Noch keine Prüfung – sobald der Update-Dienst läuft, prüft er automatisch.'
    : d.lastError ? 'Die letzte Prüfung ist fehlgeschlagen (siehe oben).'
      : !d.latestVersion ? 'Im Repository gibt es noch keine veröffentlichte Version (signierter Tag vX.Y.Z). Siehe docs/UPDATES.md.'
        : 'Das Portal ist aktuell.';
  return h('div', null,
    pageHead('Updates', `Installiert: Version ${d.runningVersion}`, can('update.install') ? [button('Jetzt nach Updates suchen', async () => { await post('/api/admin/updates/check'); toast('Der Updater prüft in Kürze'); })] : []),
    !d.updaterOnline ? notice('warn', native
      ? 'Der Update-Dienst meldet sich nicht. Auf dem Server prüfen: „systemctl status zammad-service-portal-updater“. Fehlt der Dienst (Installation vor 1.8.0), einmal den Installationsbefehl erneut ausführen – danach gehen Updates hier über die Verwaltung.'
      : 'Der Update-Dienst meldet sich nicht. Läuft der Container „updater“ (COMPOSE_PROFILES mit „updater“)? Siehe docs/UPDATES.md.') : null,
    d.lastError ? notice('error', `Letzte Prüfung: ${d.lastError}`) : null,
    h('section', { class: 'panel' },
      h('h2', null, 'Verfügbare Versionen'),
      h('p', { class: 'muted small' }, d.checkedAt ? `Zuletzt geprüft ${relTime(d.checkedAt)}` : 'Noch nicht geprüft'),
      newer.length ? table(newer.map((v) => ({ v })), [
        { label: 'Version', render: (x) => h('strong', null, x.v) },
        { label: '', render: (x) => x.v === d.latestVersion ? badge('neueste', 'info') : '' },
        { label: '', render: (x) => can('update.install') ? button(`Auf ${x.v} aktualisieren`, async () => {
          if (!await confirmDialog(`Auf Version ${x.v} aktualisieren?`, 'Der Updater prüft die Signatur der neuen Version, sichert die Datenbank und startet das Portal neu. Schlägt der Start fehl, wird automatisch auf die alte Version zurückgesetzt. Das Portal ist dabei ca. 1 Minute nicht erreichbar.', 'Update starten')) return;
          try { await post('/api/admin/updates/install', { version: x.v }); toast('Update angefordert'); navigate(curPath(), true); } catch (err) { toast(errorText(err), 'error'); }
        }, { kind: 'primary' }) : null },
      ]) : h('p', null, emptyText),
      d.changelog ? h('details', null, h('summary', null, 'Änderungen'), h('pre', { class: 'changelog' }, d.changelog)) : null),
    h('section', { class: 'panel' }, h('h2', null, 'Verlauf'), table(d.jobs, [
      { label: 'Angefordert', render: (j) => `${fmtDate(j.createdAt)} von ${j.requestedBy}` },
      { label: 'Version', render: (j) => j.targetVersion },
      { label: 'Status', render: (j) => statusBadge(j.status) },
      { label: 'Protokoll', class: 'grow', render: (j) => j.log ? h('details', null, h('summary', null, 'anzeigen'), h('pre', null, j.log)) : '' },
    ], { empty: 'Noch keine Updates über die Oberfläche.' })),
  );
}
