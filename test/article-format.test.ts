// Aufbereitung von Zammad-Nachrichten für den Verlauf im Portal
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatHtmlArticle, formatTextArticle, blocksToText } from '../src/server/services/article-format.ts';

const ORIGINAL = '<p>Neue Störungsmeldung über das Self-Service-Portal.</p><p>Angefragt von Max Muster (IT) am 29.10.2026.</p>'
  + '<table border="1" cellpadding="4" cellspacing="0"><tr><th>Was ist betroffen?</th><td>Notebook</td></tr>'
  + '<tr><th>Wie stark sind Sie eingeschränkt?</th><td>Blockiert &ndash; ich kann nicht arbeiten</td></tr>'
  + '<tr><th>Was ist passiert?</th><td>Mein Notebook ist abgestürzt\nund leider geht es jetzt nicht mehr an</td></tr></table>'
  + '<p><small>Erstellt über das Self-Service-Portal · Anfrage aefd7593-890e-41c8-9346-436a841a574f</small></p>';

test('Anfrage aus dem Portal: Tabelle wird Feldliste, Fußzeile klein', () => {
  const f = formatHtmlArticle(ORIGINAL);
  assert.deepEqual(f.blocks.map((b) => b.t), ['text', 'fields', 'meta']);
  assert.equal((f.blocks[0] as any).text, 'Neue Störungsmeldung über das Self-Service-Portal.\nAngefragt von Max Muster (IT) am 29.10.2026.');
  assert.deepEqual((f.blocks[1] as any).rows, [
    ['Was ist betroffen?', 'Notebook'],
    ['Wie stark sind Sie eingeschränkt?', 'Blockiert – ich kann nicht arbeiten'],
    ['Was ist passiert?', 'Mein Notebook ist abgestürzt und leider geht es jetzt nicht mehr an'],
  ]);
  assert.match((f.blocks[2] as any).text, /^Erstellt über das Self-Service-Portal · Anfrage aefd/);
  assert.equal(f.quoted, null);
});

test('Antwort aus Zammad: Zitat der Anfrage abgetrennt, Signatur erkannt', () => {
  const html = '<div>Hallo das ist ein test</div><div><br></div><div data-signature="true" data-signature-id="1">Mit freundlichen Grüßen<br><br>Max Muster<br>Tel: 123<br><div>Firma | Straße 1</div></div>'
    + `<br><blockquote type="cite">${ORIGINAL}</blockquote>`;
  const f = formatHtmlArticle(html);
  assert.deepEqual(f.blocks, [
    { t: 'text', text: 'Hallo das ist ein test' },
    { t: 'signature', text: 'Mit freundlichen Grüßen\n\nMax Muster\nTel: 123\nFirma | Straße 1' },
  ]);
  assert.match(f.quoted ?? '', /Neue Störungsmeldung/);
  assert.match(f.quoted ?? '', /Was ist betroffen\?/);
});

test('Outlook-Antwort ohne blockquote: Verlauf ab „Von: … Gesendet:“ abgetrennt', () => {
  const html = '<p class=MsoNormal>Danke, erledigt.</p><div id="appendonsend"></div><hr><div id="divRplyFwdMsg"><b>Von:</b> IT<br><b>Gesendet:</b> Mittwoch</div><div>Alte Nachricht</div>';
  const f = formatHtmlArticle(html);
  assert.deepEqual(f.blocks, [{ t: 'text', text: 'Danke, erledigt.' }]);
  assert.match(f.quoted ?? '', /Alte Nachricht/);
  const g = formatHtmlArticle('<div>Passt so.</div><div>Von: Max Muster</div><div>Gesendet: Montag</div><div>Betreff: X</div><div>alt</div>');
  assert.deepEqual(g.blocks, [{ t: 'text', text: 'Passt so.' }]);
  assert.match(g.quoted ?? '', /^Von: Max Muster/);
  const h = formatHtmlArticle('<div>Ok</div><div>Am 29.10.2026 um 13:24 schrieb Max Muster:</div><div>alt</div>');
  assert.deepEqual(h.blocks, [{ t: 'text', text: 'Ok' }]);
});

test('Nur Zitat: lieber zeigen als leer', () => {
  const f = formatHtmlArticle('<blockquote type="cite">nur alt</blockquote>');
  assert.deepEqual(f.blocks, [{ t: 'text', text: 'nur alt' }]);
  assert.equal(f.quoted, null);
});

test('Zeilenumbrüche im Quelltext sind keine Umbrüche; Tabellen ohne Feld/Wert werden Text', () => {
  const f = formatHtmlArticle('<div>Steuer-Nr.: 64 002/15\n758</div><table><tr><td>a</td><td>b</td><td>c</td></tr></table>');
  assert.equal(blocksToText(f.blocks), 'Steuer-Nr.: 64 002/15 758\n\na\nb\nc');
});

test('Reiner Text: >-Zitate und Signatur nach „-- “', () => {
  const f = formatTextArticle('Hallo\n\n-- \nMax\n> alt\n> älter');
  assert.deepEqual(f.blocks, [{ t: 'text', text: 'Hallo' }, { t: 'signature', text: 'Max' }]);
  assert.equal(f.quoted, 'alt\nälter');
  assert.equal(formatTextArticle('a &amp; b').blocks[0].t === 'text' && (formatTextArticle('a &amp; b').blocks[0] as any).text, 'a &amp; b');
});

test('Linear auch bei bösartigen Eingaben', () => {
  for (const s of ['<'.repeat(150_000), '<script>'.repeat(20_000), '<blockquote>'.repeat(30_000), '<table><tr><td>'.repeat(10_000), `<div ${'a'.repeat(150_000)}>`]) {
    const t = performance.now();
    formatHtmlArticle(s);
    assert.ok(performance.now() - t < 1500, `${s.slice(0, 20)}… dauerte zu lange`);
  }
});

test('Alte Fußzeile („Service-Portal“) aus Tickets vor 1.11.1 wird weiter erkannt', () => {
  const f = formatHtmlArticle('<p>Text</p><p><small>Erstellt über das Service-Portal · Anfrage 1234</small></p>');
  assert.ok(f.blocks.some((b: any) => b.t === 'meta'), JSON.stringify(f.blocks));
});
