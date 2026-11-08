import { existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { createMinecraftBody, type MinecraftConfig } from './body/minecraft/index.ts';
import { Brain, type BrainConfig } from './brain/brain.ts';
import { makeLLM, type ProviderConfig } from './llm/index.ts';
import { Jev } from './llm/jev.ts';
import { JevRouter } from './brain/router.ts';

type Config = {
  minecraft: MinecraftConfig;
  brain: { provider: string } & BrainConfig;
  /** Optional Jev fast router (TypeSafe). Key from apiKey or TYPESAFE_API_KEY. */
  jev?: { enabled: boolean; apiKey?: string; model?: string } | null;
  providers: Record<string, ProviderConfig>;
};

const { values } = parseArgs({
  options: {
    config: { type: 'string', short: 'c', default: 'craftie.config.json' },
    provider: { type: 'string', short: 'p' },  // override brain provider
    jev: { type: 'boolean' },                   // turn the Jev fast router on
    host: { type: 'string' }, port: { type: 'string' }, username: { type: 'string', short: 'u' },
    version: { type: 'string', short: 'v' }, auth: { type: 'string' },
  },
});

if (!existsSync(values.config!)) {
  console.error(`No ${values.config} found. Copy craftie.config.example.json to craftie.config.json and edit it.`);
  process.exit(1);
}
const cfg: Config = JSON.parse(readFileSync(values.config!, 'utf8'));
const mc = { ...cfg.minecraft };
if (values.host) mc.host = values.host;
if (values.port) mc.port = Number(values.port);
if (values.username) mc.username = values.username;
if (values.version) mc.version = values.version;
if (values.auth) mc.auth = values.auth as any;

const brainName = values.provider ?? cfg.brain.provider;
const pick = (n: string) => {
  const p = cfg.providers[n];
  if (!p) { console.error(`Provider "${n}" not in config. Available: ${Object.keys(cfg.providers).join(', ')}`); process.exit(1); }
  return p;
};

const llm = makeLLM(brainName, pick(brainName));
const useJev = values.jev || cfg.jev?.enabled;
const router = useJev ? new JevRouter(new Jev({ apiKey: cfg.jev?.apiKey, model: cfg.jev?.model })) : null;
console.log(`[craftie] brain: ${brainName}${router ? ' | fast: Jev' : ''} | server: ${mc.host}:${mc.port ?? 25565}`);

const body = createMinecraftBody(mc);
const brain = new Brain(body, llm, router, cfg.brain);

// You can also type commands straight into this terminal.
createInterface({ input: process.stdin }).on('line', (l) => l.trim() && brain.command('console (typed in terminal, not in game)', l.trim()));
