// Encrypted vault for API keys and server logins. Same method on every OS,
// no password and no OS keychain needed.
//
//   unlock key = scrypt(random 32-byte secret in ~/.craftie/vault.key, this PC's ID + your user name)
//   vault.json = AES-256-GCM(unlock key, all secrets as JSON)
//
// What that protects against: the vault being copied to another computer
// (wrong PC ID), other user accounts on this PC (files are owner-only), and
// keys leaking into settings files, logs or the browser (they never go there).
// What no password-free design can stop: malware already running as you.
// If the PC ID changes (e.g. OS reinstall), just enter your keys again.
import { execSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, hostname, platform, userInfo } from 'node:os';
import { join } from 'node:path';

const DIR = join(homedir(), '.craftie');
const VAULT = join(DIR, 'vault.json');
const KEYFILE = join(DIR, 'vault.key');

function machineId(): string {
  try {
    if (platform() === 'win32')
      return execSync('reg query HKLM\\SOFTWARE\\Microsoft\\Cryptography /v MachineGuid', { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString().match(/MachineGuid\s+REG_SZ\s+(\S+)/)?.[1] ?? hostname();
    if (platform() === 'darwin')
      return execSync('ioreg -rd1 -c IOPlatformExpertDevice', { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString().match(/"IOPlatformUUID" = "([^"]+)"/)?.[1] ?? hostname();
    for (const f of ['/etc/machine-id', '/var/lib/dbus/machine-id']) if (existsSync(f)) return readFileSync(f, 'utf8').trim();
  } catch {}
  return hostname();
}

let cachedKey: Buffer | null = null;
function key(): Buffer {
  if (cachedKey) return cachedKey;
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  if (!existsSync(KEYFILE)) writeFileSync(KEYFILE, randomBytes(32), { mode: 0o600 });
  try { chmodSync(DIR, 0o700); chmodSync(KEYFILE, 0o600); } catch {}
  const salt = Buffer.from(`craftie-vault-v1|${machineId()}|${userInfo().username}`);
  return (cachedKey = scryptSync(readFileSync(KEYFILE), salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }));
}

let secrets: Record<string, string> | null = null;
function load(): Record<string, string> {
  if (secrets) return secrets;
  if (!existsSync(VAULT)) return (secrets = {});
  try {
    const f = JSON.parse(readFileSync(VAULT, 'utf8'));
    const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(f.iv, 'base64'));
    d.setAuthTag(Buffer.from(f.tag, 'base64'));
    secrets = JSON.parse(Buffer.concat([d.update(Buffer.from(f.data, 'base64')), d.final()]).toString('utf8'));
  } catch {
    console.warn('[secrets] Saved keys could not be opened on this PC (copied from another PC, or reinstalled?). Please enter them again.');
    secrets = {};
  }
  return secrets!;
}

function save() {
  const iv = randomBytes(12); // fresh nonce for every write
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([c.update(JSON.stringify(secrets ?? {}), 'utf8'), c.final()]);
  const tmp = VAULT + '.tmp';
  writeFileSync(tmp, JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') }), { mode: 0o600 });
  renameSync(tmp, VAULT); // atomic, so a crash can't corrupt it
}

export function setSecret(name: string, value: string) { load()[name] = value; save(); }
export function getSecret(name: string): string | undefined { return load()[name]; }
export function hasSecret(name: string): boolean { return name in load(); }
export function deleteSecret(name: string) { delete load()[name]; save(); }
