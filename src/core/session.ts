// Turns the simple choices from the settings page into a running bot.
// Everything technical lives here so the user never sees it.
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { createMinecraftBody, type MinecraftConfig } from '../body/minecraft/index.ts';
import type { Body } from '../body/types.ts';
import { Brain } from '../brain/brain.ts';
import { makeLLM, type ProviderConfig } from '../llm/index.ts';
import { Jev } from '../llm/jev.ts';
import { JevRouter } from '../brain/router.ts';
import { getSecret, hasSecret, setSecret } from './secrets.ts';
import { Team } from '../brain/team.ts';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HELPERS_FILE = join(homedir(), '.craftie', 'helpers.json');
const MAX_HELPERS = 3;

export type Setup = {
  playerName: string;
  botName: string;
  ai: { id: string; apiKey?: string; model?: string; baseUrl?: string };
  /** Optional speed boost: TypeSafe Jev handles simple commands in a fraction of a second. */
  jev?: { enabled: boolean; apiKey?: string };
  /** lan = the world you have open in Minecraft (Open to LAN); server = an address. */
  play: { mode: 'lan' | 'server'; address?: string; password?: string };
};

export const SETUP_FILE = 'craftie.setup.json';

export function loadSetup(): Setup | null {
  try { return existsSync(SETUP_FILE) ? JSON.parse(readFileSync(SETUP_FILE, 'utf8')) : null; } catch { return null; }
}
export function saveSetup(s: Setup) { writeFileSync(SETUP_FILE, JSON.stringify(s, null, 2)); }

// Names under which each secret lives in the vault.
const keyName = { ai: (id: string) => `ai-key:${id}`, jev: 'jev-key', login: (addr: string) => `server-login:${addr}` };

/** Move any keys/passwords from the form into the vault; the returned setup holds none. */
export function storeSecrets(s: Setup): Setup {
  const clean: Setup = JSON.parse(JSON.stringify(s));
  if (s.ai.apiKey) setSecret(keyName.ai(s.ai.id), s.ai.apiKey);
  if (s.jev?.apiKey) setSecret(keyName.jev, s.jev.apiKey);
  if (s.play.password && s.play.address) setSecret(keyName.login(s.play.address), s.play.password);
  delete clean.ai.apiKey; if (clean.jev) delete clean.jev.apiKey; delete clean.play.password;
  return clean;
}

/** Which secrets are already saved, so the panel can say "saved" without ever showing them. */
export function savedSecrets(s: Setup | null) {
  if (!s) return { ai: false, jev: false, login: false };
  return {
    ai: hasSecret(keyName.ai(s.ai.id)),
    jev: hasSecret(keyName.jev),
    login: Boolean(s.play.address && hasSecret(keyName.login(s.play.address))),
  };
}

/** Setup is complete enough to start without asking anything. */
export function isComplete(s: Setup | null): s is Setup {
  if (!s?.playerName || !s.ai?.id || !s.play?.mode) return false;
  if (s.play.mode === 'server') return Boolean(s.play.address);
  return true;
}

const PRESETS: Record<string, ProviderConfig> = {
  'claude-sub': { type: 'claude-cli', model: 'sonnet' },
  'codex-sub': { type: 'codex-cli' },
  'ollama': { type: 'openai', baseUrl: 'http://localhost:11434/v1', model: 'qwen3:8b' },
  'lmstudio': { type: 'openai', baseUrl: 'http://localhost:1234/v1', model: 'local-model' },
  'claude-api': { type: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY', model: 'claude-sonnet-5-5' },
  'openai': { type: 'openai', baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY', model: 'gpt-5' },
  'openrouter': { type: 'openai', baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY' },
  'deepseek': { type: 'openai', baseUrl: 'https://api.deepseek.com/v1', apiKeyEnv: 'DEEPSEEK_API_KEY', model: 'deepseek-chat' },
  'custom': { type: 'openai' },
};

export function providerFor(ai: Setup['ai']): ProviderConfig {
  const p = { ...(PRESETS[ai.id] ?? PRESETS.custom) };
  if (ai.apiKey) p.apiKey = ai.apiKey;
  if (ai.model) p.model = ai.model;
  if (ai.baseUrl) p.baseUrl = ai.baseUrl;
  return p;
}

export type Status = { state: 'idle' | 'starting' | 'waiting' | 'joined' | 'error'; message: string };

export class Session extends EventEmitter {
  status: Status = { state: 'idle', message: 'Not running' };
  private body: Body | null = null;
  private brain: Brain | null = null;
  private setup: Setup | null = null;
  private team = new Team();
  private helpers: { name: string; body: Body; brain: Brain }[] = [];
  private mcBase: MinecraftConfig | null = null;
  private llm: any = null;
  private router: JevRouter | null = null;

  private set(s: Status) { this.status = s; this.emit('status', s); }
  log(text: string) { this.emit('log', text); }

  get running() { return this.status.state !== 'idle' && this.status.state !== 'error'; }

  /** Fires when someone types "!ai settings" in game. */
  onSettings: () => void = () => {};
  /** Fires on "craftie restart". */
  onRestart: () => void = () => {};

  async start(saved: Setup) {
    if (this.running) await this.stop();
    // Pull keys out of the encrypted vault for this run only.
    const setup: Setup = JSON.parse(JSON.stringify(saved));
    setup.ai.apiKey ??= getSecret(keyName.ai(setup.ai.id));
    if (setup.jev?.enabled) setup.jev.apiKey ??= getSecret(keyName.jev);
    if (setup.play.address) setup.play.password ??= getSecret(keyName.login(setup.play.address));
    this.setup = setup;
    try {
      if (!setup.playerName.trim()) throw new Error('Enter your Minecraft name first.');
      if (['claude-api', 'openai', 'openrouter', 'deepseek'].includes(setup.ai.id) && !setup.ai.apiKey && !process.env[(providerFor(setup.ai).apiKeyEnv ?? '')])
        throw new Error('This AI needs an API key. Type "!ai settings" in game or open the settings page to add one.');
      if (setup.jev?.enabled && !setup.jev.apiKey && !process.env.TYPESAFE_API_KEY)
        throw new Error('Jev speed boost is on but has no API key.');
      const llm = makeLLM(setup.ai.id, providerFor(setup.ai));
      const router = setup.jev?.enabled ? new JevRouter(new Jev({ apiKey: setup.jev.apiKey })) : null;

      let host = 'lan', port: number | undefined;
      if (setup.play.mode === 'server') {
        const a = (setup.play.address ?? '').trim();
        if (!a) throw new Error('Enter the server address.');
        const m = a.match(/^\[?([^\]]+?)\]?(?::(\d+))?$/)!;
        host = m[1]; port = m[2] ? Number(m[2]) : 25565;
      }
      this.set({ state: 'waiting', message: setup.play.mode === 'server' ? 'Craftie is joining...' : 'Waiting for your game: open your world, then Esc → Open to LAN.' });
      const name = setup.botName || 'Craftie';
      this.team = new Team();
      const mc: MinecraftConfig = {
        host, port, username: name, auth: 'offline',
        owners: [setup.playerName.trim()], // only the player can command Craftie
        prefixes: ['!ai', 'craftie', '@craftie', 'team', 'crafties'],
        password: setup.play.password || undefined, autoReconnect: true, viewerPort: 0,
        team: this.team.names,
      };
      this.mcBase = mc; this.llm = llm; this.router = router;
      this.body = createMinecraftBody(mc);
      this.brain = new Brain(this.body, llm, router, {
        verbose: true, onSettings: () => this.onSettings(), onRestart: () => this.onRestart(), owner: setup.playerName.trim(),
        name, team: this.team, onJoin: () => this.addHelper(), onExit: (who) => this.removeHelper(who),
      });
      // Helpers who were on the team last time come back too (once the main Craftie is in).
      const saved = this.savedHelpers();
      if (saved.length) setTimeout(() => { for (const n of saved) if (this.body) this.addHelper(n, true); }, 8000);
    } catch (e: any) {
      this.set({ state: 'error', message: e.message });
      await this.stop(true);
    }
  }

  /**
   * Save-and-apply from the settings page. Changes that don't affect the connection
   * (AI provider/model, keys, Jev) are swapped in live; only name/where-to-play changes rejoin.
   */
  async apply(saved: Setup): Promise<'started' | 'live' | 'reconnected'> {
    const prev = this.setup;
    if (!this.running || !prev || !this.brain) { await this.start(saved); return 'started'; }
    const connKey = (x: Setup) => JSON.stringify([x.playerName.trim(), x.botName, x.play.mode, x.play.address ?? '', x.play.password ? 'pw' : '']);
    const next: Setup = JSON.parse(JSON.stringify(saved));
    next.ai.apiKey ??= getSecret(keyName.ai(next.ai.id));
    if (next.jev?.enabled) next.jev.apiKey ??= getSecret(keyName.jev);
    if (next.play.address) next.play.password ??= getSecret(keyName.login(next.play.address));
    if (connKey(next) !== connKey(prev)) { await this.start(saved); return 'reconnected'; }
    const llm = makeLLM(next.ai.id, providerFor(next.ai));
    const router = next.jev?.enabled && (next.jev.apiKey || process.env.TYPESAFE_API_KEY) ? new JevRouter(new Jev({ apiKey: next.jev.apiKey })) : null;
    this.brain.setAI(llm, router);
    for (const h of this.helpers) h.brain.setAI(llm, router);
    this.llm = llm; this.router = router;
    this.setup = next;
    this.log(`[craftie] settings applied live (AI: ${next.ai.id}${router ? ', Jev on' : ''})`);
    return 'live';
  }

  /** Called with each captured log line, to move the status along. */
  observe(line: string) {
    if (line.includes('[mc] spawned') && this.status.state === 'waiting')
      this.set({ state: 'joined', message: `Craftie is in the game! Type "!ai <anything>" in Minecraft chat.` });
    const kick = line.match(/\[mc\] kicked: (.*)/);
    if (kick && this.running) this.set({ state: 'waiting', message: /verify|unverified|authenticat/i.test(kick[1])
      ? 'Your game only lets premium accounts in. In the Open to LAN screen (Custom LAN), turn Online Mode OFF, then open it again.'
      : 'Craftie got kicked, retrying... (' + kick[1].slice(0, 120) + ')' });
    if (line.includes('No LAN world found') && this.status.state === 'waiting')
      this.set({ state: 'waiting', message: 'Waiting for your game: open your world, then Esc → Open to LAN (Online Mode off).' });
  }

  private savedHelpers(): string[] { try { return JSON.parse(readFileSync(HELPERS_FILE, 'utf8')).slice(0, MAX_HELPERS); } catch { return []; } }
  private saveHelpers() { try { writeFileSync(HELPERS_FILE, JSON.stringify(this.helpers.map((h) => h.name))); } catch {} }

  /** "craftie join": one more Craftie (Craftie1, Craftie2...). Same owner, same AI, shared memory and projects. */
  addHelper(wanted?: string, quiet = false): string {
    if (!this.mcBase || !this.body) return "I'm not in a world yet.";
    if (this.helpers.length >= MAX_HELPERS) return `That's the whole team (${MAX_HELPERS} helpers max).`;
    const base = this.mcBase.username;
    let name = wanted;
    for (let i = 1; !name; i++) if (!this.helpers.some((h) => h.name === `${base}${i}`)) name = `${base}${i}`;
    const body = createMinecraftBody({
      ...this.mcBase, username: name, prefixes: [name.toLowerCase(), `@${name.toLowerCase()}`, 'team', 'crafties'],
      helper: true, followGap: 3 + 2 * (this.helpers.length + 1), team: this.team.names,
    });
    this.team.names.push(name); // before it spawns, so nobody mistakes it for a stranger
    const brain = new Brain(body, this.llm, this.router, {
      verbose: true, owner: this.setup!.playerName.trim(), name, helper: true, team: this.team,
      onExit: (who) => this.removeHelper(who),
    });
    this.helpers.push({ name, body, brain });
    this.saveHelpers();
    this.log(`[craftie] ${name} joined the team`);
    return quiet ? '' : `${name} is joining to help. Talk to it with "${name.toLowerCase()} ...".`;
  }

  /** "craftie exit": send helpers home. who = a name, "all", or null = the newest one. */
  removeHelper(who: string | null): string {
    if (!this.helpers.length) return 'No helpers to send home.';
    const gone = who === 'all' ? [...this.helpers] : [who ? this.helpers.find((h) => h.name.toLowerCase() === who.toLowerCase()) : this.helpers.at(-1)].filter(Boolean) as typeof this.helpers;
    if (!gone.length) return `No helper called ${who}.`;
    for (const h of gone) {
      h.brain.shutdown(); setTimeout(() => h.body.quit(), 1500); // let its goodbye go out
      this.team.remove(h.name);
      this.helpers = this.helpers.filter((x) => x !== h);
    }
    this.saveHelpers();
    this.log(`[craftie] ${gone.map((h) => h.name).join(', ')} left`);
    return gone.length > 1 ? 'Helpers sent home.' : `${gone[0].name} is heading home. Bye!`;
  }

  command(text: string) {
    if (!this.brain || !this.setup) return;
    this.brain.command(this.setup.playerName, text);
  }

  async stop(keepStatus = false) {
    for (const h of this.helpers) { h.brain.shutdown(); h.body.quit(); }
    this.helpers = []; // the saved list stays, so they come back next start
    this.brain?.shutdown(); this.body?.quit();
    this.brain = null; this.body = null;
    if (!keepStatus) this.set({ state: 'idle', message: 'Stopped' });
  }
}
