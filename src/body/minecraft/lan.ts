// Finds a world opened with "Open to LAN" (its port is random each time).
// 1. Scan this PC's listening ports and ping each one Minecraft-style. This works
//    even when a firewall blocks LAN broadcasts (e.g. ufw on Linux).
// 2. Listen for the game's LAN broadcast on multicast 224.0.2.60:4445 ("[MOTD]..[/MOTD][AD]port[/AD]"),
//    which finds worlds on other PCs in the same network.
import { execSync } from 'node:child_process';
import dgram from 'node:dgram';
import { networkInterfaces, platform } from 'node:os';
import mc from 'minecraft-protocol';

export type LanWorld = { host: string; port: number; motd: string };

const SKIP = new Set([22, 53, 80, 443, 631, 3000, 3007, 5432, 6379, 8080, 11434]);

function localPorts(): number[] {
  try {
    const out = platform() === 'win32' ? execSync('netstat -an -p TCP').toString()
      : platform() === 'darwin' ? execSync('netstat -an -p tcp').toString()
      : execSync('ss -ltnH').toString();
    const ports = new Set<number>();
    for (const line of out.split('\n')) {
      if (!/LISTEN/i.test(line) && platform() !== 'linux') continue;
      const m = line.match(/[.:](\d{2,5})\s+\S*[*:]/) ?? line.match(/[.:](\d{2,5})\s/);
      const p = Number(m?.[1]);
      if (p > 1024 && !SKIP.has(p)) ports.add(p);
    }
    return [...ports];
  } catch { return []; }
}

function ping(host: string, port: number): Promise<string | null> {
  return new Promise((res) => {
    const t = setTimeout(() => res(null), 1500);
    (mc as any).ping({ host, port, closeTimeout: 1500 }, (err: any, r: any) => {
      clearTimeout(t);
      res(err || !r?.version ? null : (typeof r.description === 'string' ? r.description : r.description?.text ?? '') || 'Minecraft world');
    });
  });
}

async function scanLocal(prefer?: string): Promise<LanWorld | null> {
  const results = (await Promise.all(localPorts().map(async (port) => ({ port, motd: await ping('127.0.0.1', port) })))).filter((r) => r.motd !== null);
  // Opened-to-LAN worlds are named "<player> - <world>": prefer the owner's, then any LAN world, then anything.
  const score = (m: string) => (prefer && m.toLowerCase().startsWith(prefer.toLowerCase() + ' - ') ? 2 : / - /.test(m) ? 1 : 0);
  // Only worlds actually opened to LAN (named "<player> - <world>"), never some other server on this PC.
  const hit = results.filter((r) => score(r.motd!) >= 1).sort((a, b) => score(b.motd!) - score(a.motd!))[0];
  return hit ? { host: '127.0.0.1', port: hit.port, motd: hit.motd! } : null;
}

function listenMulticast(timeoutMs: number): Promise<LanWorld | null> {
  return new Promise((resolve) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const done = (w: LanWorld | null) => { clearTimeout(timer); try { sock.close(); } catch {} resolve(w); };
    const timer = setTimeout(() => done(null), timeoutMs);
    sock.on('message', (buf, rinfo) => {
      const s = buf.toString('utf8');
      const port = Number(s.match(/\[AD\](\d+)\[\/AD\]/)?.[1]);
      if (port) done({ host: rinfo.address, port, motd: s.match(/\[MOTD\](.*)\[\/MOTD\]/)?.[1] ?? '' });
    });
    sock.on('error', () => done(null));
    sock.bind(4445, () => {
      for (const addrs of Object.values(networkInterfaces()))
        for (const a of addrs ?? []) if (a.family === 'IPv4') { try { sock.addMembership('224.0.2.60', a.address); } catch {} }
    });
  });
}

export async function discoverLan(timeoutMs = 10000, prefer?: string): Promise<LanWorld> {
  const local = await scanLocal(prefer);
  if (local) return local;
  const remote = await listenMulticast(timeoutMs);
  if (remote) return remote;
  throw new Error('No LAN world found. In Minecraft: Esc -> Open to LAN -> Start LAN World. ' +
    '(World on another PC? Its LAN broadcast may be blocked by a firewall: allow UDP 4445, or set host/port in the config.)');
}
