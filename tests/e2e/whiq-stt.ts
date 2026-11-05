// End-to-end: speech to text for the embedded platform agent. The Speech-to-text seat points at a provider that is a
// stand-in server (fake-model.ts answers /audio/transcriptions); a short WAV is in the project's working folder; the
// scripted model calls transcribe_audio. Checks: the tool is offered (the seat is set, no sandbox needed), the agent
// converted the recording with its bundled ffmpeg and sent it through the router's stt seat, and the transcript file
// is in the working folder.
//   node tests/e2e/whiq-stt.ts [--exe <P6 Clone.exe>]   (needs vendor/whiq-agent installed and built)
import { _electron as electron } from 'playwright';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fakeModel, type Req } from './fake-model.ts';
const ok = (c: boolean, m: string) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };

const TRANSCRIPT = 'Site meeting: the crane arrives on Monday and the slab pour moves to Thursday.';
const results = (r: Req) => r.messages.filter((m) => m.role === 'tool').map((m) => typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
const offered = (r: Req, n: string) => (r.tools ?? []).some((t) => t.function.name === n);
const fake = await fakeModel((r) => {
  if (!offered(r, 'load_tools')) return { text: 'ok' };
  const done = results(r);
  if (done.length === 0) return { call: 'load_tools', args: { names: ['transcribe_audio'] } };
  if (done.length === 1) return { call: 'transcribe_audio', args: { path: 'meeting.wav' } };
  return { text: `Done: transcribed. ${/error|failed/i.test(done[1]) ? 'FAILED ' + done[1].slice(0, 200) : 'The transcript is saved.'}` };
}, TRANSCRIPT);

/** One second of a 440 Hz tone: 16 kHz, 16-bit, mono WAV. */
function wav(): Buffer {
  const rate = 16000, n = rate, data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / rate)), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

const root = join(import.meta.dirname, '..', '..');
const profile = mkdtempSync(join(tmpdir(), 'p6whiqs-'));
const folder = join(profile, 'Data', 'Projects', 'CFC Modified');
mkdirSync(folder, { recursive: true });
writeFileSync(join(folder, 'meeting.wav'), wav());
const exe = process.argv.includes('--exe') ? process.argv[process.argv.indexOf('--exe') + 1] : '';
const app = await electron.launch({ ...(exe ? { executablePath: exe } : {}), args: [...(exe ? [] : [root]), '--user-data', profile, '--import', join(root, 'Sample XERs/cairo festival city.xer')], cwd: root });
const win = await app.firstWindow(); const errors: string[] = []; win.on('pageerror', (e) => errors.push(e.message));
await win.waitForSelector('button:has-text("View Diagnostics...")'); await win.click('button:has-text("Next >")'); await win.click('button:has-text("Finish")'); await win.waitForSelector('.grid-row');
for (let i = 0; i < 4 && (await win.locator('.dialog').count()); i++) { await win.keyboard.press('Escape'); await win.waitForTimeout(150); }
await app.evaluate(({ dialog }, f) => { (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [f] }); }, folder);
// two providers on the one stand-in server: the agent's model, and the transcriber (its own tier, on the Speech-to-text seat)
const saved = await win.evaluate((u) => {
  const prov = (id: string) => ({ id, name: id, kind: 'openai', baseUrl: u, extraHeaders: '', extraBody: '', hasKey: false, keyHint: '' });
  return (window as any).p6.aiSaveModels({ enabled: true, actions: true, encrypted: true, providers: [prov('main'), prov('ears')], tiers: [{ name: 'Main', provider: 'main', model: 'fake-1' }, { name: 'Ears', provider: 'ears', model: 'whisper-fake' }], seats: { stt: 'Ears' } }, { main: 'not-a-key', ears: 'stt-test-key' });
}, fake.url);
ok(saved?.ok === true, 'the models and the Speech-to-text seat are saved ' + JSON.stringify(saved).slice(0, 200));
await win.waitForSelector('.ai-panel', { timeout: 15000 }).catch(async () => { await win.click('.ai-strip'); await win.waitForSelector('.ai-panel'); });
await win.waitForSelector('.ai-head b:has-text("Scheduler Agent")', { timeout: 15000 });
await win.fill('.ai-panel textarea', 'Transcribe meeting.wav.');
await win.keyboard.press('Enter');
await win.waitForSelector('.ai-panel .ai-msg:has-text("Done: transcribed")', { timeout: 180000 }).catch(() => {});
const panel = await win.locator('.ai-panel .ai-body').innerText();
ok(/Done: transcribed\. The transcript is saved/.test(panel), 'the agent finished the transcription (the tool was offered with no sandbox, because the seat is set): ' + panel.replace(/\s+/g, ' ').slice(-300));
ok(fake.audio.length === 1 && fake.audio[0].model === 'whisper-fake' && fake.audio[0].format === 'ogg' && fake.audio[0].bytes > 200 && /stt-test-key/.test(fake.audio[0].auth), `the transcriber got the converted recording: ${JSON.stringify(fake.audio)}`);
const files = existsSync(folder) ? (readdirSync(folder, { recursive: true }) as string[]) : [];
const tr = files.find((f) => /\.md$/i.test(f) && readFileSync(join(folder, f), 'utf8').includes(TRANSCRIPT));
ok(!!tr, `the transcript file is in the working folder: ${tr ?? files.join(', ')}`);
ok(!errors.length, 'no page errors ' + errors.join(' | '));
await app.close();
fake.close();
rmSync(profile, { recursive: true, force: true });
