// Freigaben durch Vorgesetzte: Liste und Entscheidung.
import { h, icon, mount, fmtDate, relTime, type Child } from '../lib/dom.ts';
import { get, post } from '../lib/api.ts';
import { emptyState, errorText, fieldWrap, notice, pageHead, statusBadge, tabs, textarea, toast } from '../lib/ui.ts';
import { link, navigate, setUrl } from '../lib/app.ts';
import { refreshCounts } from '../lib/notify.ts';
import { DEMO } from '../lib/env.ts';

interface Approval {
  id: string; status: string; title: string; systemName: string; requesterName: string;
  createdAt: number; expiresAt: number; decidedAt: number | null; decidedByName: string | null; comment: string | null;
}
interface Summary { form: string; system: string; requester: { name: string; email: string; department: string }; fields: { label: string; value: string; multiline: boolean }[] }

const DONE_TEXT: Record<string, string> = {
  approved: 'Freigegeben', rejected: 'Abgelehnt', withdrawn: 'Von der anfragenden Person zurückgezogen', expired: 'Ohne Entscheidung abgelaufen',
};

function approvalStatus(a: Approval): HTMLElement {
  return statusBadge(a.status === 'pending' ? 'awaiting_approval' : a.status);
}

export async function approvalsPage(_p: Record<string, string>, q: URLSearchParams) {
  const host = h('div', { class: 'container' });
  const load = async (which: string) => {
    const r = await get<{ approvals: Approval[]; open: number }>(`/api/portal/approvals?status=${which}`);
    mount(host,
      pageHead('Freigaben', 'Anfragen, die auf Ihre Entscheidung warten'),
      tabs([{ id: 'open', label: r.open ? `Offen (${r.open})` : 'Offen' }, { id: 'done', label: 'Erledigt' }], which, (id) => { setUrl(`/freigaben${id === 'done' ? '?ansicht=erledigt' : ''}`, true); void load(id); }),
      r.approvals.length
        ? h('ul', { class: ['form-list', 'approval-list'] }, ...r.approvals.map((a) => h('li', null, link(`/freigaben/${a.id}`,
          h('span', { class: 'form-icon', attrs: { 'aria-hidden': 'true' } }, icon('shield', 20)),
          h('span', { class: 'form-text' },
            h('span', { class: 'form-name' }, a.title),
            h('span', { class: 'form-desc' }, `${a.requesterName} · ${a.systemName} · ${which === 'open' ? relTime(a.createdAt) : fmtDate(a.decidedAt ?? a.createdAt)}`)),
          approvalStatus(a)))))
        : emptyState(which === 'open' ? 'Nichts zu tun' : 'Noch nichts erledigt', which === 'open' ? 'Zurzeit wartet keine Anfrage auf Ihre Freigabe.' : 'Hier stehen Anfragen, über die Sie entschieden haben.'));
  };
  await load(q.get('ansicht') === 'erledigt' ? 'done' : 'open');
  return host;
}

export async function approvalDetailPage(p: Record<string, string>) {
  const d = await get<{ approval: Approval; summary: Summary | null; files: { id: string; filename: string; size: number }[] }>(`/api/portal/approvals/${p.approvalId}`);
  void refreshCounts();
  const a = d.approval;
  const s = d.summary;
  let comment = '';
  const msg = h('div', { attrs: { 'aria-live': 'polite' } });
  const commentBox = textarea('', (v) => { comment = v; }, { rows: 3, maxlength: 2000 });

  const act = async (decision: 'approve' | 'reject', btn: HTMLButtonElement) => {
    mount(msg);
    if (decision === 'reject' && !comment.trim()) { mount(msg, notice('error', 'Bitte kurz begründen, warum Sie ablehnen.')); commentBox.focus(); return; }
    btn.disabled = true;
    try {
      await post(`/api/portal/approvals/${a.id}/${decision}`, { comment });
      toast(decision === 'approve' ? 'Freigegeben – die Anfrage geht jetzt an die IT' : 'Abgelehnt – die anfragende Person wird benachrichtigt');
      void refreshCounts();
      navigate(DEMO ? '/freigaben' : `/freigaben/${a.id}`, true);
    } catch (err) {
      mount(msg, notice('error', errorText(err)));
      btn.disabled = false;
    }
  };

  const facts: Child[] = s ? [
    h('dt', null, 'Angefragt von'), h('dd', null, s.requester.name, s.requester.department ? h('span', { class: 'muted' }, ` · ${s.requester.department}`) : null, h('br'), h('span', { class: 'muted small' }, s.requester.email)),
    h('dt', null, 'Formular'), h('dd', null, s.form),
    h('dt', null, 'Geht an'), h('dd', null, s.system),
    h('dt', null, 'Gesendet'), h('dd', null, fmtDate(a.createdAt)),
    h('dt', null, 'Frist'), h('dd', null, `bis ${fmtDate(a.expiresAt, false)} – danach verfällt die Anfrage`),
  ] : [
    h('dt', null, 'Angefragt von'), h('dd', null, a.requesterName),
    h('dt', null, 'Geht an'), h('dd', null, a.systemName),
    h('dt', null, 'Gesendet'), h('dd', null, fmtDate(a.createdAt)),
  ];

  const approveBtn = h('button', { class: ['btn', 'btn-primary'], attrs: { type: 'button' } }, icon('check', 16), 'Freigeben');
  const rejectBtn = h('button', { class: ['btn', 'btn-danger'], attrs: { type: 'button' } }, icon('x', 16), 'Ablehnen');
  approveBtn.addEventListener('click', () => void act('approve', approveBtn));
  rejectBtn.addEventListener('click', () => void act('reject', rejectBtn));

  return h('div', { class: 'container narrow' },
    h('nav', { class: 'crumbs', attrs: { 'aria-label': 'Navigation' } }, link('/freigaben', icon('back', 14), 'Freigaben')),
    h('div', { class: 'ticket-head' }, h('h1', null, a.title), h('p', { class: 'ticket-meta' }, approvalStatus(a))),
    a.status !== 'pending' ? notice(a.status === 'approved' ? 'ok' : a.status === 'rejected' ? 'error' : 'info',
      h('strong', null, DONE_TEXT[a.status] ?? a.status), a.decidedAt ? ` am ${fmtDate(a.decidedAt)}` : '', a.decidedByName && a.status !== 'withdrawn' && a.status !== 'expired' ? ` von ${a.decidedByName}` : '',
      a.comment ? h('p', { class: 'quote' }, a.comment) : null,
      a.status === 'approved' ? h('p', { class: 'small' }, 'Die Anfrage wurde an das Ticketsystem übermittelt. Den Inhalt zeigt das Portal nach der Entscheidung nicht mehr an.') : null) : null,
    h('section', { class: 'panel' }, h('dl', { class: 'facts' }, ...facts)),
    s ? h('section', { class: 'panel' }, h('h2', null, 'Inhalt der Anfrage'),
      s.fields.length ? h('dl', { class: 'facts facts-wide' }, ...s.fields.flatMap((f) => [h('dt', null, f.label), h('dd', { class: f.multiline ? 'pre' : undefined }, f.value)])) : h('p', { class: 'muted' }, 'Keine weiteren Angaben.'),
      d.files.length ? h('div', null, h('h3', null, 'Anhänge'), h('ul', { class: 'attachments' }, ...d.files.map((f) => h('li', null,
        h('a', { attrs: { href: `/api/portal/approvals/${a.id}/files/${f.id}`, download: f.filename } }, icon('file', 14), f.filename))))) : null) : null,
    a.status === 'pending' ? h('section', { class: 'panel decide' },
      h('h2', null, 'Ihre Entscheidung'),
      h('p', { class: 'muted' }, 'Nach der Freigabe geht die Anfrage an das Ticketsystem. Ihr Name, die Uhrzeit und Ihr Hinweis stehen im Ticket. Bei Ablehnung wird die Anfrage gelöscht und die anfragende Person benachrichtigt.'),
      fieldWrap(commentBox, { label: 'Hinweis oder Begründung', help: 'Bei Ablehnung Pflicht, bei Freigabe freiwillig (z. B. Kostenstelle).' }),
      msg,
      h('div', { class: 'form-actions' }, approveBtn, rejectBtn)) : null,
  );
}

