// Baut die Video-Einführung aus Sprechertext und Bildern der Webseite.
//
//   node tools/video/build.ts
//
// Ablauf: Sätze aus narration.json mit Piper vertonen (Stimme de-thorsten), je Satz ein Bild 1920 × 1080 rendern
// (Hintergrund, Kapitelleiste, Browserrahmen mit Aufnahme aus docs/website/img, Untertitel), mit ffmpeg zum Video
// zusammensetzen. Ergebnis in docs/video: MP4, Untertitel (SRT, VTT), Vorschaubild und Vorschau-GIF.
// Voraussetzungen: ffmpeg, Playwright mit Chromium, Piper (PIPER=/pfad/piper, PIPER_VOICE=/pfad/stimme.onnx).
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const root = new URL('../..', import.meta.url).pathname;
const img = join(root, 'docs/website/img');
const out = join(root, 'docs/video');
const work = process.env.VIDEO_WORK ?? join(tmpdir(), 'zsp-video');
mkdirSync(join(work, 'tts'), { recursive: true });
mkdirSync(join(work, 'frames'), { recursive: true });
const PIPER = process.env.PIPER ?? '/opt/piper/piper';
const VOICE = process.env.PIPER_VOICE ?? '/opt/piper-voice/de-thorsten-low.onnx';

interface Scene { chapter: string; image: string; text: string; say?: string }
const { chapters, scenes } = JSON.parse(readFileSync(new URL('./narration.json', import.meta.url), 'utf8')) as { chapters: string[]; scenes: Scene[] };

const plain = (t: string) => t.replace(/\*/g, '');
const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const probe = (f: string) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString().trim());

// ------------------------------------------------------------------------------------------ Sprache
const PAUSE = 0.45;        // nach jedem Satz
const CHAPTER_PAUSE = 0.9; // zusätzlich vor einem neuen Kapitel
const timings: { start: number; end: number; dur: number; wav: string }[] = [];
let t = 0.6;
for (const [i, s] of scenes.entries()) {
  const say = s.say ?? plain(s.text);
  const wav = join(work, 'tts', `${createHash('sha256').update(VOICE + say).digest('hex').slice(0, 16)}.wav`);
  if (!existsSync(wav)) execFileSync(PIPER, ['--model', VOICE, '--output_file', wav, '--length_scale', '1.02', '--sentence_silence', '0.15'], { input: say, stdio: ['pipe', 'ignore', 'ignore'] });
  const d = probe(wav);
  if (i > 0 && scenes[i - 1]!.chapter !== s.chapter) t += CHAPTER_PAUSE;
  timings.push({ start: t, end: t + d, dur: d, wav });
  t += d + PAUSE;
}
const total = t + 0.8;
console.log(`${scenes.length} Sätze, ${total.toFixed(1)} s`);

// ------------------------------------------------------------------------------------------ Bilder
const require = createRequire(import.meta.url);
let pw: any;
try { pw = require('playwright'); } catch { pw = require(process.env.PLAYWRIGHT_PATH ?? '/opt/node22/lib/node_modules/playwright'); }

function stage(s: Scene): string {
  const chips = chapters.map((c) => `<span class="chip${c === s.chapter ? ' on' : ''}">${esc(c)}</span>`).join('');
  const caption = esc(s.text).replace(/\*([^*]+)\*/g, '<b>$1</b>');
  const url = 'serviceportal.example.org';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  @font-face { font-family: Inter; src: url("file://${root}src/web/fonts/inter-500.woff"); font-weight: 400 500; }
  @font-face { font-family: Inter; src: url("file://${root}src/web/fonts/inter-display-700.woff"); font-weight: 600 800; }
  * { box-sizing: border-box; margin: 0; }
  body { width: 1920px; height: 1080px; overflow: hidden; font-family: Inter, sans-serif; color: #fff;
    background: radial-gradient(1200px 800px at 10% 0%, #2a3bd6 0%, transparent 60%), radial-gradient(1100px 900px at 100% 100%, #0f8a7a 0%, transparent 55%),
      radial-gradient(900px 700px at 80% 10%, #5b2bb8 0%, transparent 60%), #0b1022; }
  .bar { position: absolute; top: 26px; left: 50%; transform: translateX(-50%); display: flex; gap: 8px; padding: 8px; border-radius: 999px;
    background: rgba(10, 14, 30, .55); box-shadow: 0 10px 40px rgba(0,0,0,.35); backdrop-filter: blur(10px); }
  .chip { font-size: 17px; font-weight: 500; padding: 9px 16px; border-radius: 999px; color: rgba(255,255,255,.55); white-space: nowrap; }
  .chip.on { color: #fff; background: linear-gradient(135deg, #3b82f6, #22c3b0); font-weight: 600; }
  .frame { position: absolute; left: 50%; top: 104px; transform: translateX(-50%); width: 1392px; border-radius: 16px; overflow: hidden;
    box-shadow: 0 40px 120px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.08); background: #1d2233; }
  .top { height: 38px; display: flex; align-items: center; gap: 8px; padding: 0 16px; background: #1d2233; }
  .dot { width: 12px; height: 12px; border-radius: 50%; } .r { background: #ff5f57; } .y { background: #febc2e; } .g { background: #28c840; }
  .url { margin-left: 18px; font-size: 14px; color: rgba(255,255,255,.6); background: rgba(255,255,255,.07); padding: 5px 14px; border-radius: 8px; font-family: ui-monospace, monospace; }
  .shot { display: block; width: 1392px; height: 788px; object-fit: cover; object-position: top center; }
  .cap { position: absolute; left: 50%; bottom: 30px; transform: translateX(-50%); max-width: 1500px; padding: 20px 34px; border-radius: 18px;
    background: rgba(8, 11, 24, .78); box-shadow: 0 16px 50px rgba(0,0,0,.45); backdrop-filter: blur(12px);
    font-size: 36px; line-height: 1.3; font-weight: 500; text-align: center; letter-spacing: -.005em; }
  .cap b { font-weight: 700; background: linear-gradient(90deg, #7cb3ff, #5eead4); -webkit-background-clip: text; background-clip: text; color: transparent; }
  </style></head><body>
  <div class="bar">${chips}</div>
  <div class="frame"><div class="top"><span class="dot r"></span><span class="dot y"></span><span class="dot g"></span><span class="url">${esc(url)}</span></div>
  <img class="shot" src="file://${join(img, s.image)}"></div>
  <div class="cap">${caption}</div></body></html>`;
}

const browser = await pw.chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
for (const [i, s] of scenes.entries()) {
  if (!existsSync(join(img, s.image))) throw new Error(`Bild fehlt: ${s.image}`);
  const html = join(work, 'frames', `${String(i).padStart(2, '0')}.html`);
  writeFileSync(html, stage(s));
  await page.goto(`file://${html}`);
  await page.waitForLoadState('load');
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(work, 'frames', `${String(i).padStart(2, '0')}.png`) });
}
await browser.close();

// ------------------------------------------------------------------------------------------ Zusammensetzen
// Bild je Satz: vom Beginn des Satzes bis zum Beginn des nächsten (das erste ab 0)
const list: string[] = [];
for (const [i] of scenes.entries()) {
  const from = i === 0 ? 0 : timings[i]!.start;
  const to = i === scenes.length - 1 ? total : timings[i + 1]!.start;
  list.push(`file '${join(work, 'frames', `${String(i).padStart(2, '0')}.png`)}'`, `duration ${(to - from).toFixed(3)}`);
}
list.push(`file '${join(work, 'frames', `${String(scenes.length - 1).padStart(2, '0')}.png`)}'`);
writeFileSync(join(work, 'frames.txt'), list.join('\n'));
// Ton: Sätze an ihre Startzeit legen
const inputs: string[] = [];
const delays: string[] = [];
timings.forEach((x, i) => { inputs.push('-i', x.wav); delays.push(`[${i}]aresample=48000,adelay=${Math.round(x.start * 1000)}|${Math.round(x.start * 1000)}[a${i}]`); });
const mix = `${delays.join(';')};${timings.map((_, i) => `[a${i}]`).join('')}amix=inputs=${timings.length}:normalize=0,highpass=f=70,lowpass=f=7600,acompressor=threshold=-20dB:ratio=2.5,loudnorm=I=-16:TP=-1.5,apad=whole_dur=${total.toFixed(2)}[out]`;
const wav = join(work, 'voice.wav');
execFileSync('ffmpeg', ['-v', 'error', '-y', ...inputs, '-filter_complex', mix, '-map', '[out]', '-ar', '48000', '-ac', '2', wav]);
const mp4 = join(out, 'service-portal-demo.mp4');
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', join(work, 'frames.txt'), '-i', wav,
  '-vf', `fps=30,format=yuv420p,fade=t=in:st=0:d=0.5,fade=t=out:st=${(total - 0.6).toFixed(2)}:d=0.6`,
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-tune', 'stillimage', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-shortest', mp4]);

// ------------------------------------------------------------------------------------------ Untertitel, Vorschau
const ts = (s: number, sep: string) => {
  const ms = Math.round(s * 1000);
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, sec = Math.floor(ms / 1000) % 60, r = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}${sep}${String(r).padStart(3, '0')}`;
};
writeFileSync(join(out, 'service-portal-demo.srt'), scenes.map((s, i) => `${i + 1}\n${ts(timings[i]!.start, ',')} --> ${ts(timings[i]!.end, ',')}\n${plain(s.text)}\n`).join('\n'));
writeFileSync(join(out, 'service-portal-demo.de.vtt'), 'WEBVTT\n\n' + scenes.map((s, i) => `${ts(timings[i]!.start, '.')} --> ${ts(timings[i]!.end, '.')}\n${plain(s.text)}\n`).join('\n'));
const zammadScene = scenes.findIndex((s) => s.chapter === 'Zammad');
execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', join(work, 'frames', `${String(Math.max(zammadScene, 0)).padStart(2, '0')}.png`), '-vf', 'scale=1280:-1', '-q:v', '4', join(out, 'poster.jpg')]);
// Vorschau-GIF: je zwei Sekunden aus einigen Szenen
const pick = [0, 9, 11, 17, 21, zammadScene, zammadScene + 3, scenes.length - 1].filter((x, i, a) => x >= 0 && a.indexOf(x) === i);
const gifList = pick.flatMap((i) => [`file '${join(work, 'frames', `${String(i).padStart(2, '0')}.png`)}'`, 'duration 2']);
gifList.push(gifList.at(-2)!);
writeFileSync(join(work, 'gif.txt'), gifList.join('\n'));
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', join(work, 'gif.txt'),
  '-vf', 'fps=4,scale=720:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer', join(out, 'vorschau.gif')]);
const minutes = `${Math.floor(total / 60)}:${String(Math.round(total % 60)).padStart(2, '0')}`;
console.log(`Video: ${mp4} (${minutes})`);
