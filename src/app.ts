// The easy way to run Craftie. Started by the start.sh / start.bat / start.command files.
//  - First run: opens the setup page in your browser.
//  - After that: starts straight away with your saved settings, no page.
//  - "!ai settings" in Minecraft chat (or running the start file again) opens the page.
import { exec } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'node:util';
import { detectAIs } from './core/detect.ts';
import { autostartEnabled, setAutostart } from './core/autostart.ts';
import { guessPlayerName } from './core/launchers.ts';
import { installMod, listInstances } from './core/instances.ts';
import { isComplete, loadSetup, saveSetup, savedSecrets, Session, type Setup, storeSecrets } from './core/session.ts';

const PORT = 3008;
const here = dirname(fileURLToPath(import.meta.url));
const TOKEN = randomBytes(24).toString('base64url'); // new every run; only links Craftie opens carry it
const session = new Session();
const clients = new Set<ServerResponse>();
const recent: string[] = [];

function broadcast(event: string, data: unknown) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(msg);
}
session.on('status', (s) => broadcast('status', s));
session.on('log', (line) => { recent.push(line); if (recent.length > 300) recent.shift(); broadcast('log', line); });

// Mirror everything the bot prints into the page's activity feed.
for (const level of ['log', 'error', 'warn'] as const) {
  const orig = console[level].bind(console);
  console[level] = (...a: any[]) => { orig(...a); const line = format(...a); session.observe(line); session.log(line); };
}

function openSettings() {
  const url = `http://localhost:${PORT}/?t=${TOKEN}`;
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  if (!process.env.CRAFTIE_NO_BROWSER) exec(cmd, () => {});
  console.log(`\n  Settings: ${url}\n`);
}
session.onSettings = openSettings;

// "craftie restart": leave cleanly, then a detached helper starts a fresh copy once this one has exited
// (it waits, so the new copy doesn't think we're still running).
session.onRestart = async () => {
  console.log('  Restarting Craftie...');
  const { spawn } = await import('node:child_process');
  const args = process.argv.slice(1).map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
  const helper = spawn('sh', ['-c', `while kill -0 ${process.pid} 2>/dev/null; do sleep 0.3; done; sleep 1; exec '${process.execPath}' ${args}`],
    { cwd: process.cwd(), detached: true, stdio: ['ignore', 'inherit', 'inherit'], env: process.env });
  helper.unref();
  await session.stop();
  process.exit(0);
};

const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};
async function readBody(req: IncomingMessage): Promise<any> {
  let s = '';
  for await (const chunk of req) { s += chunk; if (s.length > 100_000) throw new Error('too big'); }
  return s ? JSON.parse(s) : {};
}
const tokenOk = (t: string | null | undefined) =>
  !!t && t.length === TOKEN.length && timingSafeEqual(Buffer.from(t), Buffer.from(TOKEN));

/** Settings for the page, with every secret replaced by "is it saved?". */
function publicSetup(s: Setup | null) {
  if (!s) return null;
  const c = JSON.parse(JSON.stringify(s));
  delete c.ai?.apiKey; delete c.jev?.apiKey; delete c.play?.password;
  return c;
}

const server = createServer(async (req, res) => {
  try {
    // Block other websites from talking to this server (DNS rebinding / cross-site requests).
    const host = req.headers.host ?? '';
    if (!/^(localhost|127\.0\.0\.1):\d+$/.test(host)) return json(res, 403, { error: 'forbidden' });
    const url = new URL(req.url ?? '/', 'http://localhost');

    // A second start file run asks the first one to open settings. The custom header
    // can't be sent cross-site without a CORS preflight, which we never approve.
    if (url.pathname === '/api/open-settings' && req.method === 'POST' && req.headers['x-craftie'] === '1') {
      openSettings();
      return json(res, 200, { ok: true, craftie: true });
    }

    if (url.pathname === '/') {
      if (!tokenOk(url.searchParams.get('t'))) {
        res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' });
        return res.end('<p style="font:16px system-ui;padding:2em">This link has expired. Type <b>!ai settings</b> in Minecraft, or run the Craftie start file again.</p>');
      }
      const html = readFileSync(join(here, 'ui', 'index.html'), 'utf8').replace('__CRAFTIE_TOKEN__', TOKEN);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' });
      return res.end(html);
    }

    // Everything under /api needs the token (header for fetch, query for EventSource).
    if (!tokenOk((req.headers['x-craftie-token'] as string) ?? url.searchParams.get('t'))) return json(res, 403, { error: 'forbidden' });

    if (url.pathname === '/api/state') {
      const setup = loadSetup();
      return json(res, 200, { setup: publicSetup(setup), saved: savedSecrets(setup), ais: await detectAIs(), guessedName: guessPlayerName(), autostart: autostartEnabled(), status: session.status, recent });
    }
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(`event: status\ndata: ${JSON.stringify(session.status)}\n\n`);
      clients.add(res);
      return void req.on('close', () => clients.delete(res));
    }
    if (req.method === 'POST' && url.pathname === '/api/start') {
      const body = await readBody(req);
      try { setAutostart(Boolean(body.autostart)); } catch (e: any) { console.warn('[autostart]', e.message); }
      delete body.autostart;
      const clean = storeSecrets(body); // keys go into the encrypted vault, not the settings file
      saveSetup(clean);
      const how = await session.apply(clean); // live when possible; rejoins only for name/where changes
      return json(res, 200, { ok: true, how });
    }
    if (url.pathname === '/api/instances') return json(res, 200, { instances: listInstances() });
    if (req.method === 'POST' && url.pathname === '/api/install-mod') {
      const { id } = await readBody(req);
      try { return json(res, 200, { ok: true, message: await installMod(String(id)) }); }
      catch (e: any) { return json(res, 200, { ok: false, message: e.message }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/stop') { await session.stop(); return json(res, 200, { ok: true }); }
    if (req.method === 'POST' && url.pathname === '/api/command') {
      const { text } = await readBody(req);
      if (text) session.command(String(text));
      return json(res, 200, { ok: true });
    }
    json(res, 404, { error: 'not found' });
  } catch (e: any) {
    json(res, 500, { error: e.message });
  }
});

async function main() {
  server.once('error', async (e: any) => {
    if (e.code !== 'EADDRINUSE') throw e;
    // Already running? Then this launch just opens its settings page.
    try {
      const r = await fetch(`http://localhost:${PORT}/api/open-settings`, { method: 'POST', headers: { 'x-craftie': '1' } });
      if ((await r.json()).craftie) { console.log('Craftie is already running. Opened its settings page.'); process.exit(0); }
    } catch {}
    console.error(`Port ${PORT} is used by another program. Close it and try again.`);
    process.exit(1);
  });
  server.listen(PORT, '127.0.0.1', async () => {
    const setup = loadSetup();
    if (setup && (setup.play as any).mode === 'world') setup.play.mode = 'lan'; // older setups
    if (isComplete(setup)) {
      console.log(`\n  Craftie is starting with your saved settings.\n  To change settings, type "!ai settings" in Minecraft chat (or run this start file again).\n  Keep this window open while you play.\n`);
      await session.start(setup);
      if (session.status.state === 'error') { console.log('  Something went wrong, opening settings so you can fix it.'); openSettings(); }
    } else {
      console.log('\n  First time? Opening setup in your browser...');
      openSettings();
    }
  });
}
main();

const shutdown = async () => { await session.stop(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
