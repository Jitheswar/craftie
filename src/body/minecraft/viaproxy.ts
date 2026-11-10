// Lets Craftie join worlds newer than its Minecraft library understands (e.g. 26.3 when it
// speaks up to 26.1). ViaProxy runs locally and translates between the two versions:
// Craftie -> 127.0.0.1:<proxy port> (old version) -> ViaProxy -> the world (new version).
// Needs Java on PATH. The jar is downloaded once into ~/.craftie/viaproxy.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ownPorts } from './lan.ts';

const DIR = join(homedir(), '.craftie', 'viaproxy');
const JAR = join(DIR, 'ViaProxy.jar');
const URL = 'https://github.com/ViaVersion/ViaProxy/releases/download/v3.4.14/ViaProxy-3.4.14.jar';

let proc: ChildProcess | null = null;
let current: { target: string; port: number } | null = null;

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => res(p)); });
    s.on('error', rej);
  });
}

async function download() {
  if (existsSync(JAR)) return;
  mkdirSync(DIR, { recursive: true });
  console.log('[mc] downloading ViaProxy (one time, ~50 MB) to join a newer Minecraft version...');
  const r = await fetch(URL);
  if (!r.ok) throw new Error(`couldn't download ViaProxy (${r.status})`);
  writeFileSync(JAR, Buffer.from(await r.arrayBuffer()));
}

/** Starts (or reuses) a proxy to host:port and returns where to connect instead. */
export async function viaProxy(host: string, port: number): Promise<{ host: string; port: number }> {
  const target = `${host}:${port}`;
  if (proc && current?.target === target && proc.exitCode === null) return { host: '127.0.0.1', port: current.port };
  stopViaProxy();
  await download();
  const local = await freePort();
  const p = spawn('java', ['-jar', JAR, 'cli', '--target-address', target, '--bind-address', `127.0.0.1:${local}`, '--auth-method', 'NONE'],
    { cwd: DIR, stdio: ['ignore', 'pipe', 'pipe'] });
  proc = p; current = { target, port: local }; ownPorts.add(local);
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error('ViaProxy took too long to start')), 60000);
    const watch = (d: Buffer) => { if (/Binding proxy server/.test(d.toString())) { clearTimeout(t); res(); } };
    p.stdout!.on('data', watch); p.stderr!.on('data', watch);
    p.on('error', (e: any) => { clearTimeout(t); rej(new Error(e.code === 'ENOENT' ? 'Java is not installed (needed for ViaProxy)' : e.message)); });
    p.on('exit', (c) => { clearTimeout(t); rej(new Error(`ViaProxy exited (${c})`)); });
  });
  await new Promise((r) => setTimeout(r, 500)); // let it finish binding
  console.log(`[mc] ViaProxy translating 127.0.0.1:${local} -> ${target}`);
  return { host: '127.0.0.1', port: local };
}

export function stopViaProxy() {
  try { proc?.kill(); } catch {}
  if (current) ownPorts.delete(current.port);
  proc = null; current = null;
}

process.on('exit', stopViaProxy);
