// Kleiner Markdown-Umsetzer für die Anleitungen auf der Webseite (GitHub Pages).
// Bewusst ohne fremde Pakete. Deckt ab, was in docs/*.md vorkommt: Überschriften (mit GitHub-Ankern),
// Absätze, verschachtelte Listen, Code-Blöcke, Tabellen, Zitate, Trennlinien, Bilder, Links,
// fett/kursiv/Code und wenige erlaubte HTML-Tags (img, br, details, summary, kbd, sub, sup).
// Alles andere wird maskiert – die Quellen stammen aus dem eigenen Repository, trotzdem kein freies HTML.

export interface MdOptions {
  /** Ziel eines Links oder Bildes umschreiben (z. B. INSTALLATION.md → installation.html) */
  rewrite?: (url: string, kind: 'link' | 'image') => string;
}

export interface MdResult {
  html: string;
  title: string;
  /** Überschriften der Ebene 2 für das Inhaltsverzeichnis */
  toc: { id: string; text: string; level: number }[];
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const ALLOWED_TAG = /^<\/?(img|br|details|summary|kbd|sub|sup)\b(?:\s+[a-z-]+(?:="[^"<>]*")?)*\s*\/?>/i;
const ALLOWED_ATTR = new Set(['src', 'alt', 'width', 'height', 'title', 'open']);

/** GitHub-Anker: klein, Satzzeichen weg, Leerzeichen → Bindestrich (Umlaute bleiben). */
export function slug(text: string): string {
  return text.toLowerCase().replace(/<[^>]*>/g, '').replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s/g, '-');
}

export function renderMarkdown(src: string, opts: MdOptions = {}): MdResult {
  const rewrite = opts.rewrite ?? ((u: string) => u);
  const ids = new Map<string, number>();
  const toc: MdResult['toc'] = [];
  let title = '';

  function uniqueId(text: string): string {
    const base = slug(text) || 'abschnitt';
    const n = ids.get(base) ?? 0;
    ids.set(base, n + 1);
    return n ? `${base}-${n}` : base;
  }

  function safeUrl(u: string): string {
    const t = u.trim();
    if (/^(javascript|data|vbscript):/i.test(t)) return '#';
    return t;
  }

  function tag(raw: string): string {
    // Erlaubtes Tag neu zusammensetzen: nur bekannte Attribute, src über rewrite
    const m = /^<(\/?)([a-z]+)([^>]*?)(\/?)>$/i.exec(raw);
    if (!m) return esc(raw);
    const [, close, name, attrs] = m;
    if (close) return `</${name.toLowerCase()}>`;
    const out: string[] = [];
    for (const a of attrs.matchAll(/([a-z-]+)(?:="([^"]*)")?/gi)) {
      const k = a[1].toLowerCase();
      if (!ALLOWED_ATTR.has(k)) continue;
      let v = a[2] ?? '';
      if (k === 'src') v = safeUrl(rewrite(v, 'image'));
      out.push(a[2] === undefined ? k : `${k}="${esc(v)}"`);
    }
    if (name.toLowerCase() === 'img') out.push('loading="lazy"');
    return `<${name.toLowerCase()}${out.length ? ' ' + out.join(' ') : ''}>`;
  }

  function inline(text: string): string {
    const keep: string[] = [];
    const hold = (html: string) => `\u0000${keep.push(html) - 1}\u0000`;
    let s = text;
    // Code zuerst, damit darin nichts umgesetzt wird
    s = s.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, _t, c: string) => hold(`<code>${esc(c.trim() === '' ? c : c.replace(/^ (.*) $/, '$1'))}</code>`));
    // Erlaubte HTML-Tags
    s = s.replace(/<\/?[a-z][^<>]*>/gi, (t) => (ALLOWED_TAG.test(t) ? hold(tag(t)) : t));
    // Bilder und Links
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (_, alt: string, url: string, t?: string) =>
      hold(`<img src="${esc(safeUrl(rewrite(url, 'image')))}" alt="${esc(alt)}"${t ? ` title="${esc(t)}"` : ''} loading="lazy">`));
    s = s.replace(/\[((?:[^\[\]]|\[[^\]]*\])+)\]\(([^)\s]+)\)/g, (_, label: string, url: string) => {
      const href = safeUrl(rewrite(url, 'link'));
      const ext = /^https?:/i.test(href);
      return hold(`<a href="${esc(href)}"${ext ? ' rel="noopener"' : ''}>`) + label + hold('</a>');
    });
    s = s.replace(/<(https?:\/\/[^\s<>]+)>/g, (_, u: string) => hold(`<a href="${esc(u)}" rel="noopener">${esc(u)}</a>`));
    s = esc(s);
    s = s.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^\w*])\*([^*\s][^*]*?)\*(?!\w)/g, '$1<em>$2</em>');
    s = s.replace(/(^|[\s(])_([^_\s][^_]*?)_(?=[\s.,;:!?)]|$)/g, '$1<em>$2</em>');
    s = s.replace(/\\([\\`*_{}\[\]()#+\-.!|])/g, '$1');
    // Platzhalter zurück (auch verschachtelt, z. B. Code in Linktext)
    for (let i = 0; i < 3 && s.includes('\u0000'); i++) s = s.replace(/\u0000(\d+)\u0000/g, (_, n: string) => keep[Number(n)]);
    return s;
  }

  const listRe = /^( {0,12})([-*+]|\d{1,3}[.)])( +)(.*)$/;
  const isBlank = (l: string) => l.trim() === '';
  const indentOf = (l: string) => l.length - l.trimStart().length;
  const startsBlock = (l: string) => /^ {0,3}(#{1,6} |```|~~~|>|---\s*$|\*\*\*\s*$|\|)/.test(l) || listRe.test(l);

  function splitRow(row: string): string[] {
    let r = row.trim();
    if (r.startsWith('|')) r = r.slice(1);
    if (r.endsWith('|') && !r.endsWith('\\|')) r = r.slice(0, -1);
    const cells: string[] = [];
    let cur = '', code = false;
    for (let i = 0; i < r.length; i++) {
      const c = r[i];
      if (c === '\\' && r[i + 1] === '|') { cur += '|'; i++; continue; }
      if (c === '`') code = !code;
      if (c === '|' && !code) { cells.push(cur.trim()); cur = ''; continue; }
      cur += c;
    }
    cells.push(cur.trim());
    return cells;
  }

  function blocks(lines: string[]): string {
    const out: string[] = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (isBlank(line)) { i++; continue; }
      const t = line.trimStart();

      // Code-Block
      const fence = /^(\s*)(```+|~~~+)\s*([\w-]*)/.exec(line);
      if (fence) {
        const ind = fence[1].length, mark = fence[2];
        const body: string[] = [];
        i++;
        while (i < lines.length && !lines[i].trimStart().startsWith(mark)) {
          body.push(lines[i].slice(Math.min(ind, indentOf(lines[i]) || 0)));
          i++;
        }
        i++;
        out.push(`<pre${fence[3] ? ` data-lang="${esc(fence[3])}"` : ''}><code>${esc(body.join('\n'))}</code></pre>`);
        continue;
      }
      // Überschrift
      const hm = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(t);
      if (hm && indentOf(line) < 4) {
        const level = hm[1].length;
        const text = hm[2];
        const id = uniqueId(text);
        const html = inline(text);
        if (level === 1 && !title) title = text.replace(/[*`]/g, '');
        if (level === 2 || level === 3) toc.push({ id, level, text: text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*`]/g, '') });
        out.push(`<h${level} id="${esc(id)}">${html}<a class="anchor" href="#${esc(id)}" aria-label="Link zu diesem Abschnitt">#</a></h${level}>`);
        i++;
        continue;
      }
      // Trennlinie
      if (/^ {0,3}(---|\*\*\*|___)\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
      // Tabelle
      if (t.startsWith('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
        const head = splitRow(line);
        const align = splitRow(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /-:$/.test(c) ? 'right' : ''));
        i += 2;
        const rows: string[][] = [];
        while (i < lines.length && lines[i].trimStart().startsWith('|')) { rows.push(splitRow(lines[i])); i++; }
        const td = (c: string, k: number, tagName: string) => `<${tagName}${align[k] ? ` style="text-align:${align[k]}"` : ''}>${inline(c)}</${tagName}>`;
        out.push(`<div class="table"><table><thead><tr>${head.map((c, k) => td(c, k, 'th')).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${head.map((_, k) => td(r[k] ?? '', k, 'td')).join('')}</tr>`).join('')}</tbody></table></div>`);
        continue;
      }
      // Zitat
      if (t.startsWith('>')) {
        const body: string[] = [];
        while (i < lines.length && !isBlank(lines[i]) && (lines[i].trimStart().startsWith('>') || !startsBlock(lines[i]))) {
          body.push(lines[i].trimStart().replace(/^> ?/, ''));
          i++;
        }
        out.push(`<blockquote>${blocks(body)}</blockquote>`);
        continue;
      }
      // Liste
      const lm = listRe.exec(line);
      if (lm) {
        const ordered = /\d/.test(lm[2]);
        const baseIndent = lm[1].length;
        const start = ordered ? parseInt(lm[2], 10) : 1;
        const items: string[] = [];
        let loose = false;
        while (i < lines.length) {
          const m = listRe.exec(lines[i]);
          if (!m || m[1].length !== baseIndent || /\d/.test(m[2]) !== ordered) break;
          const contentIndent = m[1].length + m[2].length + m[3].length;
          const body = [m[4]];
          i++;
          let sawBlank = false;
          while (i < lines.length) {
            const l = lines[i];
            if (isBlank(l)) { body.push(''); sawBlank = true; i++; continue; }
            const ind = indentOf(l);
            if (ind >= contentIndent || (ind > baseIndent && listRe.test(l))) { body.push(l.slice(Math.min(contentIndent, ind))); sawBlank = false; i++; continue; }
            // Fortsetzungszeile eines Absatzes (ohne Einrückung)
            if (!sawBlank && !startsBlock(l) && ind > baseIndent - 1 && body.length && !isBlank(body[body.length - 1])) { body.push(l.trim()); i++; continue; }
            break;
          }
          while (body.length && isBlank(body[body.length - 1])) body.pop();
          if (sawBlank && i < lines.length && listRe.test(lines[i]) && indentOf(lines[i]) === baseIndent) loose = true;
          const inner = blocks(body);
          // Enge Liste: der erste Absatz eines Punktes ohne <p> (wie GitHub)
          items.push(`<li>${loose ? inner : inner.replace(/^<p>([\s\S]*?)<\/p>/, '$1')}</li>`);
          // Leerzeilen zwischen Punkten überspringen, wenn die Liste weitergeht
          let j = i;
          while (j < lines.length && isBlank(lines[j])) j++;
          const nm = j < lines.length ? listRe.exec(lines[j]) : null;
          if (nm && nm[1].length === baseIndent && /\d/.test(nm[2]) === ordered) { if (j > i) loose = true; i = j; } else break;
        }
        out.push(ordered ? `<ol${start !== 1 ? ` start="${start}"` : ''}>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
        continue;
      }
      // Absatz
      const para: string[] = [line.trim()];
      i++;
      while (i < lines.length && !isBlank(lines[i]) && !startsBlock(lines[i])) { para.push(lines[i].trim()); i++; }
      const joined = para.map((p, k) => (k < para.length - 1 && / {2}$/.test(lines[i - para.length + k] ?? '') ? p + '\u0001' : p)).join('\n');
      out.push(`<p>${inline(joined).replace(/\u0001\n/g, '<br>\n')}</p>`);
    }
    return out.join('\n');
  }

  const html = blocks(src.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n'));
  return { html, title, toc };
}
