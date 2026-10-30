// Funktionsschalter (Verwaltung → Funktionen). Gespeichert in settings unter „features“.
import type { App } from '../app.ts';
import { DEFAULT_FEATURES, normalizeFeatures, type Features } from '../../shared/itsm.ts';

export function getFeatures(app: App): Features {
  const row = app.db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'features'");
  if (!row) return { ...DEFAULT_FEATURES, locations: [] };
  try { return normalizeFeatures(JSON.parse(row.value)); } catch { return { ...DEFAULT_FEATURES, locations: [] }; }
}

export function saveFeatures(app: App, f: Features): void {
  app.db.run("INSERT INTO settings (key, value) VALUES ('features', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify(f));
}
