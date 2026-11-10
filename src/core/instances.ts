// Finds the Minecraft instances on this PC and installs the Craftie game mod into the one
// the player picks on the setup page. Knows Prism Launcher / MultiMC / PolyMC instances and
// the standard .minecraft folder (official launcher, SKlauncher, TLauncher and similar).
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prismRoots, vanillaDir } from './launchers.ts';

const BUILDS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'mods', 'builds');
const OURS = /^craftie-autolan.*\.jar(\.disabled)?$/i;
const FABRIC_API = /^fabric-api.*\.jar$/i;

export interface Instance {
  id: string;
  name: string;
  launcher: string;
  version: string;              // Minecraft version, e.g. "1.21.4"
  fabric: boolean;              // the mod needs the Fabric loader
  /** none = not installed, old = a different build is installed, current = up to date. */
  mod: 'none' | 'old' | 'current';
  /** Why it can't be installed here, if it can't. */
  blocked?: string;
}
type Found = Instance & { modsDir: string };

const buildFor = (version: string) => join(BUILDS, `craftie-autolan-${version}.jar`);
const same = (a: string, b: string) => { try { return readFileSync(a).equals(readFileSync(b)); } catch { return false; } };
const list = (dir: string) => { try { return readdirSync(dir); } catch { return [] as string[]; } };

function describe(name: string, launcher: string, version: string, fabric: boolean, modsDir: string): Found {
  const mine = list(modsDir).filter((f) => OURS.test(f));
  const build = buildFor(version);
  const mod = !mine.length ? 'none' : mine.length === 1 && same(join(modsDir, mine[0]), build) ? 'current' : 'old';
  const blocked = !fabric ? 'Needs the Fabric loader' : !existsSync(build) ? `No Craftie mod for Minecraft ${version} yet` : undefined;
  const id = createHash('sha1').update(`${modsDir}|${version}`).digest('hex').slice(0, 16);
  return { id, name, launcher, version, fabric, mod, blocked, modsDir };
}

/** Prism Launcher and its relatives: one folder per instance, each with its own mods. */
function prismInstances(): Found[] {
  const out: Found[] = [];
  for (const root of prismRoots()) {
    const launcher = /prism/i.test(root) ? 'Prism Launcher' : /poly/i.test(root) ? 'PolyMC' : 'MultiMC';
    for (const dir of list(join(root, 'instances'))) {
      const base = join(root, 'instances', dir);
      try {
        const parts: any[] = JSON.parse(readFileSync(join(base, 'mmc-pack.json'), 'utf8')).components ?? [];
        const version = parts.find((c) => c.uid === 'net.minecraft')?.version;
        if (!version) continue;
        const name = readFileSync(join(base, 'instance.cfg'), 'utf8').match(/^name=(.*)$/m)?.[1]?.trim() || dir;
        const game = existsSync(join(base, '.minecraft')) ? join(base, '.minecraft') : join(base, 'minecraft');
        out.push(describe(name, launcher, version, parts.some((c) => c.uid === 'net.fabricmc.fabric-loader'), join(game, 'mods')));
      } catch {} // not an instance folder
    }
  }
  return out;
}

/** The standard .minecraft folder: every installed Fabric version shares one mods folder. */
function vanillaInstances(): Found[] {
  const root = vanillaDir();
  const out = new Map<string, Found>();
  const add = (name: string, versionId: string, gameDir?: string) => {
    const version = versionId.match(/^fabric-loader-[^-]+-(.+)$/)?.[1];
    if (!version) return;
    const f = describe(name, 'Minecraft Launcher', version, true, join(gameDir || root, 'mods'));
    if (!out.has(f.id)) out.set(f.id, f);
  };
  try {
    const profiles = JSON.parse(readFileSync(join(root, 'launcher_profiles.json'), 'utf8')).profiles ?? {};
    for (const p of Object.values<any>(profiles)) add(p.name || `Fabric ${p.lastVersionId}`, String(p.lastVersionId ?? ''), p.gameDir);
  } catch {}
  for (const v of list(join(root, 'versions'))) add(`Fabric ${v.replace(/^fabric-loader-[^-]+-/, '')}`, v); // launchers without profiles
  return [...out.values()];
}

function find(): Found[] {
  return [...prismInstances(), ...vanillaInstances()].sort((a, b) => Number(!!a.blocked) - Number(!!b.blocked) || a.name.localeCompare(b.name));
}

export function listInstances(): Instance[] {
  return find().map(({ modsDir, ...rest }) => rest);
}

/** The mod needs Fabric API. If the instance doesn't have it, get the right one from Modrinth. */
async function ensureFabricApi(modsDir: string, version: string): Promise<string> {
  if (list(modsDir).some((f) => FABRIC_API.test(f))) return '';
  try {
    const q = `game_versions=${encodeURIComponent(JSON.stringify([version]))}&loaders=${encodeURIComponent('["fabric"]')}`;
    const r = await fetch(`https://api.modrinth.com/v2/project/fabric-api/version?${q}`, { headers: { 'user-agent': 'craftie' }, signal: AbortSignal.timeout(20000) });
    const file = (await r.json())[0]?.files?.find((f: any) => f.primary) ?? null;
    if (!file || !/^https:\/\/cdn\.modrinth\.com\//.test(file.url) || !/^[\w.+-]+\.jar$/.test(file.filename)) throw new Error('none found');
    const jar = await fetch(file.url, { signal: AbortSignal.timeout(60000) });
    if (!jar.ok) throw new Error(`download failed (${jar.status})`);
    writeFileSync(join(modsDir, file.filename), Buffer.from(await jar.arrayBuffer()));
    return ' Fabric API was missing, so I added it too.';
  } catch {
    return ' This instance also needs the Fabric API mod, which I couldn\'t download: add it from modrinth.com/mod/fabric-api.';
  }
}

/** Puts the right build of the mod into the instance, replacing any older copy. */
export async function installMod(id: string): Promise<string> {
  const inst = find().find((i) => i.id === id); // only folders we found ourselves, never a path from the page
  if (!inst) throw new Error('That instance is gone. Reload the page.');
  if (inst.blocked) throw new Error(inst.blocked);
  mkdirSync(inst.modsDir, { recursive: true });
  for (const f of list(inst.modsDir)) if (OURS.test(f)) rmSync(join(inst.modsDir, f), { force: true });
  copyFileSync(buildFor(inst.version), join(inst.modsDir, `craftie-autolan-${inst.version}.jar`));
  const api = await ensureFabricApi(inst.modsDir, inst.version);
  return `Craftie mod installed in "${inst.name}".${api} Restart Minecraft if it's open.`;
}
