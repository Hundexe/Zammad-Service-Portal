// Prüfung hochgeladener Dateien: Typ anhand des Inhalts (nicht der Angabe des Browsers),
// sichere Dateinamen, Virenscan, verschlüsselte Zwischenablage bis zur Zustellung.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { App } from '../app.ts';
import { HttpError } from '../http/core.ts';
import type { FileKind } from '../../shared/form.ts';
import { log } from '../log.ts';

export interface IncomingFile { name: string; type?: string; data: string }
export interface CheckedFile { filename: string; mime: string; kind: FileKind; data: Buffer }

const OFFICE_ZIP: Record<string, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
};
const OFFICE_OLE: Record<string, string> = { doc: 'application/msword', xls: 'application/vnd.ms-excel', msg: 'application/vnd.ms-outlook' };
const TEXT_EXT: Record<string, string> = { txt: 'text/plain', csv: 'text/csv', log: 'text/plain' };

export function safeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'datei';
  const clean = base
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f<>:"|?*‪-‮⁦-⁩]/g, '')
    .replace(/^\.+/, '')
    .trim()
    .slice(-150);
  return clean || 'datei';
}

function ext(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

/** Ermittelt Art und MIME-Typ aus den ersten Bytes. null = nicht erlaubt. */
export function sniff(data: Buffer, filename: string): { kind: FileKind; mime: string } | null {
  const e = ext(filename);
  const head = data.subarray(0, 16);
  if (head.subarray(0, 5).toString('latin1') === '%PDF-') return e === 'pdf' ? { kind: 'pdf', mime: 'application/pdf' } : null;
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return e === 'png' ? { kind: 'image', mime: 'image/png' } : null;
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return ['jpg', 'jpeg'].includes(e) ? { kind: 'image', mime: 'image/jpeg' } : null;
  if (head.subarray(0, 6).toString('latin1') === 'GIF87a' || head.subarray(0, 6).toString('latin1') === 'GIF89a') return e === 'gif' ? { kind: 'image', mime: 'image/gif' } : null;
  if (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return e === 'webp' ? { kind: 'image', mime: 'image/webp' } : null;
  if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) return OFFICE_ZIP[e] ? { kind: 'office', mime: OFFICE_ZIP[e] } : null;
  if (head.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) return OFFICE_OLE[e] ? { kind: 'office', mime: OFFICE_OLE[e] } : null;
  if (TEXT_EXT[e]) {
    const sample = data.subarray(0, 64 * 1024);
    if (sample.includes(0)) return null;
    try { new TextDecoder('utf-8', { fatal: true }).decode(sample.subarray(0, Math.max(0, sample.length - 4))); } catch { return null; }
    return { kind: 'text', mime: TEXT_EXT[e] };
  }
  return null;
}

const B64 = /^[A-Za-z0-9+/]*={0,2}$/;

export function decodeBase64Strict(s: unknown): Buffer {
  if (typeof s !== 'string' || s.length % 4 !== 0 || !B64.test(s)) throw new HttpError(400, 'Datei ist nicht korrekt kodiert', 'bad_file');
  return Buffer.from(s, 'base64');
}

/** Prüft Dateien eines Feldes: Inhaltstyp, erlaubte Arten, Virenscan. */
export async function checkFiles(app: App, files: IncomingFile[], accept: FileKind[] | undefined, maxBytes: number): Promise<CheckedFile[]> {
  const out: CheckedFile[] = [];
  for (const f of files) {
    const filename = safeFilename(String(f?.name ?? ''));
    const data = decodeBase64Strict(f?.data);
    if (data.length === 0) throw new HttpError(422, `Datei „${filename}“ ist leer`, 'bad_file');
    if (data.length > maxBytes) throw new HttpError(422, `Datei „${filename}“ ist zu groß`, 'bad_file');
    const s = sniff(data, filename);
    if (!s) throw new HttpError(422, `Dateityp von „${filename}“ ist nicht erlaubt`, 'bad_file');
    if (accept && accept.length && !accept.includes(s.kind)) throw new HttpError(422, `„${filename}“: dieser Dateityp ist hier nicht erlaubt`, 'bad_file');
    await scan(app, data, filename);
    out.push({ filename, mime: s.mime, kind: s.kind, data });
  }
  return out;
}

export async function scan(app: App, data: Buffer, filename: string): Promise<void> {
  if (!app.clamav) {
    if (app.cfg.clamav.required && app.cfg.env === 'production') {
      throw new HttpError(503, 'Virenscanner ist nicht konfiguriert – Uploads sind gesperrt', 'scanner_missing');
    }
    return;
  }
  try {
    const r = await app.clamav.scan(data);
    if (!r.clean) {
      log.warn('Virenscanner hat eine Datei abgelehnt', { signature: r.signature });
      throw new HttpError(422, `„${filename}“ wurde vom Virenscanner abgelehnt`, 'virus_found');
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    log.error('Virenscanner nicht erreichbar', { error: (err as Error).message });
    if (app.cfg.clamav.required) throw new HttpError(503, 'Virenscanner nicht erreichbar – bitte später erneut versuchen', 'scanner_down');
  }
}

export function storeFile(app: App, requestId: string, fileId: string, data: Buffer): void {
  const dir = join(app.uploadsDir, requestId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, fileId), app.box.encryptBlob('upload', data), { mode: 0o600 });
}

export function loadFile(app: App, requestId: string, fileId: string): Buffer {
  return app.box.decryptBlob('upload', readFileSync(join(app.uploadsDir, requestId, fileId)));
}

export function removeRequestFiles(app: App, requestId: string): void {
  if (!/^[0-9a-f-]{36}$/.test(requestId)) return;
  rmSync(join(app.uploadsDir, requestId), { recursive: true, force: true });
}

/** Prüft ein Logo. SVGs werden auf gefährliche Inhalte geprüft; ausgeliefert werden sie zusätzlich mit Sandbox-CSP. */
export function checkLogo(data: Buffer, kind: 'logo' | 'favicon'): { mime: string } {
  const limit = kind === 'logo' ? 1024 * 1024 : 256 * 1024;
  if (data.length === 0 || data.length > limit) throw new HttpError(422, `Datei zu groß (max. ${limit / 1024} KB)`, 'bad_file');
  const head = data.subarray(0, 12);
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png' };
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return { mime: 'image/jpeg' };
  if (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return { mime: 'image/webp' };
  if (kind === 'favicon' && head[0] === 0 && head[1] === 0 && head[2] === 1 && head[3] === 0) return { mime: 'image/x-icon' };
  const text = data.toString('utf8');
  if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(text)) {
    const bad = /<script|<foreignObject|<iframe|<embed|<object|<!ENTITY|<!DOCTYPE|\son[a-z]+\s*=|javascript:|data:text\/html|xlink:href\s*=\s*["']\s*(?!#)|\shref\s*=\s*["']\s*(?!#)|@import|url\s*\(\s*["']?\s*(?!#)/i;
    if (bad.test(text)) throw new HttpError(422, 'SVG enthält nicht erlaubte Inhalte (Skripte, externe Verweise)', 'bad_file');
    return { mime: 'image/svg+xml' };
  }
  throw new HttpError(422, 'Erlaubt sind PNG, JPEG, WebP oder SVG', 'bad_file');
}
