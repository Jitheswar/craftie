// Finds the player's name from common launchers (Prism/MultiMC accounts, then
// vanilla's recent-player cache) so the setup page can fill it in.
import { existsSync, readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

const home = homedir();
const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming');
const os = platform();
const dataDir = (name: string) => os === 'win32' ? join(appData, name) : os === 'darwin' ? join(home, 'Library/Application Support', name) : join(process.env.XDG_DATA_HOME || join(home, '.local/share'), name);

export function vanillaDir(): string {
  return os === 'win32' ? join(appData, '.minecraft') : os === 'darwin' ? join(home, 'Library/Application Support/minecraft') : join(home, '.minecraft');
}

function prismRoots(): string[] {
  return [
    dataDir('PrismLauncher'),
    join(home, '.var/app/org.prismlauncher.PrismLauncher/data/PrismLauncher'), // Flatpak
    dataDir('multimc'), dataDir('MultiMC'), join(home, 'MultiMC'),
    dataDir('PolyMC'),
  ].filter((d) => existsSync(join(d, 'instances')));
}

/** The player's name: Prism's active account first, then vanilla's recent-player cache. */
export function guessPlayerName(): string {
  for (const root of prismRoots()) {
    try {
      const acc = JSON.parse(readFileSync(join(root, 'accounts.json'), 'utf8')).accounts ?? [];
      const a = acc.find((x: any) => x.active) ?? acc[0];
      const n = a?.profile?.name ?? a?.ygg?.extra?.userName;
      if (n) return n;
    } catch {}
  }
  try {
    const cache = JSON.parse(readFileSync(join(vanillaDir(), 'usercache.json'), 'utf8'));
    return cache.sort((a: any, b: any) => String(b.expiresOn).localeCompare(String(a.expiresOn)))[0]?.name ?? '';
  } catch { return ''; }
}
