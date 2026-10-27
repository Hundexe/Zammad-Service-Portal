// Strukturierte Logs als JSON-Zeilen (für docker logs / Log-Sammler).
// Geheimnisse werden nie geloggt: bekannte Schlüssel werden geschwärzt.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const REDACT = /pass(word)?|secret|token|cookie|authorization|totp|code_verifier|session/i;

let minLevel: number = LEVELS.info;
let silent = false;

export function setLogLevel(level: Level, quiet = false): void {
  minLevel = LEVELS[level] ?? LEVELS.info;
  silent = quiet;
}

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = REDACT.test(k) ? '[geschwärzt]' : redact(v, depth + 1);
  return out;
}

type Listener = (entry: Record<string, unknown>) => void;
const listeners = new Set<Listener>();
/** Zusätzlicher Empfänger für Log-Einträge (Tests, Weiterleitung). Gibt eine Abmeldefunktion zurück. */
export function onLog(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function write(level: Level, msg: string, data?: Record<string, unknown>): void {
  if (listeners.size) {
    const entry = { level, msg, ...(redact(data ?? {}) as object) };
    for (const fn of listeners) { try { fn(entry); } catch { /* Empfängerfehler ignorieren */ } }
  }
  if (silent || LEVELS[level] < minLevel) return;
  const line = JSON.stringify({ time: new Date().toISOString(), level, msg, ...(redact(data ?? {}) as object) });
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
}

export const log = {
  debug: (msg: string, data?: Record<string, unknown>) => write('debug', msg, data),
  info: (msg: string, data?: Record<string, unknown>) => write('info', msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => write('warn', msg, data),
  error: (msg: string, data?: Record<string, unknown>) => write('error', msg, data),
};
