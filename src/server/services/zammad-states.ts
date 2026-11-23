// Ticket-Status in Zammad auflösen – das Portal setzt nie einen Status über einen fest eingetragenen Namen.
//
// Zammad-Installationen benennen ihre Status oft um („1 Neu“, „2 In Arbeit“, „9 Erledigt“). Das Portal fragt
// deshalb je Rolle (neu, offen, geschlossen):
//   1. den Namen aus der Zammad-Zuordnung, falls dort einer gepflegt ist und es ihn in Zammad gibt,
//   2. sonst den aktiven Zammad-Status mit passendem Typ – bei mehreren den als Standard markierten
//      („Standard beim Anlegen“ bzw. „Standard bei Folgenachricht“), sonst den mit der kleinsten ID.
// Ergebnis je Ticketsystem zehn Minuten zwischengespeichert.
import type { App } from '../app.ts';
import { HttpError } from '../http/core.ts';
import { connectorFor, type SystemRow } from './systems.ts';
import type { SetupInfo, StateType } from '../connectors/types.ts';
import { forgetClosedStates } from '../connectors/zammad.ts';
import type { StateRole, ZammadMapping } from '../../shared/zammad-model.ts';

type StateList = SetupInfo['states'];
const TTL = 10 * 60_000;
const cache = new Map<string, { at: number; states: StateList }>();

export function resetStateCache(systemId?: string): void {
  if (systemId) cache.delete(systemId); else cache.clear();
  forgetClosedStates(systemId);
}

/** Status aus Zammad (mit Typ), zwischengespeichert */
export async function zammadStates(app: App, sys: SystemRow, fresh = false): Promise<StateList> {
  const hit = cache.get(sys.id);
  if (!fresh && hit && Date.now() - hit.at < TTL) return hit.states;
  const states = (await connectorFor(app, sys).setupInfo()).states;
  cache.set(sys.id, { at: Date.now(), states });
  return states;
}

const ROLE_TYPE: Record<StateRole, StateType> = { new: 'new', open: 'open', closed: 'closed' };

/** Auflösen ohne Zammad-Aufruf (für Prüfung und Tests) */
export function pickState(states: StateList, role: StateRole, m: ZammadMapping, preferred?: string): string | null {
  const active = states.filter((s) => s.active);
  for (const name of [preferred, m.states[role]]) {
    if (name && active.some((s) => s.name === name)) return name;
  }
  const type = ROLE_TYPE[role];
  // „Wartet auf Freigabe“ ist auch vom Typ offen – nie als allgemeinen offenen Status nehmen
  const candidates = active.filter((s) => s.type === type && s.name !== m.approval.state).sort((a, b) => a.id - b.id);
  const marked = role === 'new' ? candidates.find((s) => s.defaultCreate) : role === 'open' ? candidates.find((s) => s.defaultFollowUp) : undefined;
  return (marked ?? candidates[0])?.name ?? null;
}

/**
 * Name des Status für eine Rolle. `preferred` ist ein Wert aus der Zuordnung mit Vorrang (z. B. der Status nach der
 * Freigabe). Gibt es weder ihn noch einen Status des passenden Typs, kommt ein verständlicher Fehler.
 */
export async function resolveState(app: App, sys: SystemRow, m: ZammadMapping, role: StateRole, preferred?: string): Promise<string> {
  let name = pickState(await zammadStates(app, sys), role, m, preferred);
  if (!name) name = pickState(await zammadStates(app, sys, true), role, m, preferred);
  if (!name) throw new HttpError(422, `In ${sys.name} gibt es keinen aktiven Status vom Typ „${ROLE_TYPE[role]}“ – bitte in der Zammad-Zuordnung einen Status eintragen`, 'config_error');
  return name;
}
