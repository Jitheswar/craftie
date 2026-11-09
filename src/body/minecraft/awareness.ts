// World awareness: what's going on around Craftie and the player, noticed by plain code.
// Produces events (warnings, sights, places) for the brain to react to or remember, a short
// "around us" summary for the AI, and something interesting to glance at when idle.
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';

export type Event = {
  key: string;          // dedupe key (one event per thing)
  kind: 'warn' | 'sight' | 'place';
  text: string;         // one short chat line
  priority: number;     // warnings skip the chat cooldown
  attack?: string;      // entity name/username to deal with
  place?: { what: string; x: number; y: number; z: number };
  feedPlayer?: boolean;
  coverLava?: { x: number; y: number; z: number };
  lightAt?: { x: number; y: number; z: number };
};

const HOSTILE_NEAR_PLAYER: Record<string, string> = {
  creeper: 'Creeper behind you!', skeleton: 'Skeleton aiming at you!', stray: 'Skeleton aiming at you!',
  spider: 'Spider coming for you!', witch: 'Witch nearby, careful!', phantom: 'Phantom overhead!',
  enderman: 'Enderman close by, don\'t look at it!', pillager: 'Pillager! Careful.', vindicator: 'Vindicator coming!',
  warden: 'Warden nearby! Quiet and back off!', blaze: 'Blaze nearby!', ghast: 'Ghast!',
  zombie: 'Zombie coming!', husk: 'Husk coming!', drowned: 'Drowned!', zombie_villager: 'Zombie villager!',
  cave_spider: 'Cave spider!', slime: 'Slime!', magma_cube: 'Magma cube!', silverfish: 'Silverfish!',
  wither_skeleton: 'Wither skeleton!', piglin_brute: 'Piglin brute!', hoglin: 'Hoglin!', zoglin: 'Zoglin!',
  evoker: 'Evoker!', ravager: 'Ravager!', vex: 'Vex!', bogged: 'Skeleton aiming at you!', breeze: 'Breeze!',
  guardian: 'Guardian!', endermite: 'Endermite!',
};
const NICE_MOBS: Record<string, string> = {
  horse: 'A horse over there, want to tame it?', cat: 'Aww, a cat nearby.', wolf: 'A wolf! Bones would tame it.',
  parrot: 'A parrot!', panda: 'A panda!', fox: 'A fox, cute.', axolotl: 'An axolotl!', allay: 'An allay!',
  sniffer: 'A sniffer!', camel: 'A camel!', mooshroom: 'A mooshroom!',
};
const BIOME_LINES: Record<string, string> = {
  cherry_grove: 'Ooh, a cherry grove. So pretty.', mushroom_fields: 'Mushroom island! No mobs spawn here.',
  deep_dark: 'This is the deep dark. Stay quiet, wardens live here.', badlands: 'Badlands! There\'s gold around here.',
  jungle: 'A jungle. Watch for temples.', desert: 'Desert. Look out for pyramids and husks.',
  ice_spikes: 'Ice spikes!', lush_caves: 'Lush caves, lovely.', dark_forest: 'Dark forest. Mobs spawn even by day here.',
  swamp: 'A swamp. Witches live around here.', snowy_plains: 'Snowy plains, chilly.', meadow: 'A meadow up here, nice.',
};

const seenKeys = new Map<string, number>();
const fresh = (key: string, every = 10 * 60_000) => { const t = seenKeys.get(key) ?? 0; if (Date.now() - t < every) return false; seenKeys.set(key, Date.now()); return true; };

function biomeAt(bot: any, p: Vec3): string {
  try { const b = bot.blockAt(p); const id = b?.biome?.name ?? bot.registry.biomes?.[b?.biome?.id]?.name; return (id ?? '').replace(/^minecraft:/, ''); } catch { return ''; }
}

/** Scan once. Call every couple of seconds. */
export function scan(bot: Bot, owner: string | null): Event[] {
  const b: any = bot;
  if (!bot.entity) return [];
  const out: Event[] = [];
  const me = bot.entity.position;
  const o: any = owner ? Object.values(bot.entities).find((e: any) => e.username === owner) : null;
  const center = o?.position ?? me;

  // Threats near the player (or near Craftie when the player isn't around).
  for (const e of Object.values(bot.entities) as any[]) {
    if (!e.name || e === bot.entity || e.type === 'player') continue;
    const line = HOSTILE_NEAR_PLAYER[e.name];
    if (!line) continue;
    const d = e.position.distanceTo(center);
    const close = e.name === 'creeper' ? d < 7 : e.name === 'warden' ? d < 24 : d < 10;
    if (close && fresh(`threat:${e.id}`, 60_000)) out.push({ key: `threat:${e.id}`, kind: 'warn', text: line, priority: 3, attack: e.name === 'warden' || e.name === 'enderman' ? undefined : e.name });
  }

  // The player in trouble.
  if (o) {
    const md = o.metadata ?? [];
    const hp = typeof md[9] === 'number' ? (md[9] as number) : undefined; // LivingEntity health (index 9 since 1.17)
    if (typeof hp === 'number' && hp > 0 && hp <= 6 && fresh('lowhp', 45_000)) out.push({ key: 'lowhp', kind: 'warn', text: `You're hurt (${Math.ceil(hp / 2)} hearts). Here, have some food.`, priority: 3, feedPlayer: true });
    const op = o.position.floored();
    for (const [x, y, z] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0], [1, -1, 0], [-1, -1, 0], [0, -1, 1], [0, -1, -1]]) {
      const lp = op.offset(x, y, z);
      if ((bot.blockAt(lp)?.name ?? '').includes('lava') && fresh(`lava:${lp.x},${lp.y},${lp.z}`, 20_000)) {
        out.push({ key: 'lava', kind: 'warn', text: 'Lava right next to you, careful!', priority: 3, coverLava: { x: lp.x, y: lp.y, z: lp.z } });
        break;
      }
    }
    // Dark and underground around the player: somewhere to put a torch (on the floor near them).
    const here = bot.blockAt(op);
    const dark = here && (here as any).skyLight === 0 && ((here as any).light ?? 15) < 5;
    if (dark && fresh('dark', 15_000)) {
      for (const [x, z] of [[2, 0], [-2, 0], [0, 2], [0, -2], [2, 2], [-2, -2]]) {
        const t = op.offset(x, 0, z), floor = bot.blockAt(t.offset(0, -1, 0));
        if (bot.blockAt(t)?.name.includes('air') && floor?.boundingBox === 'block') { out.push({ key: 'dark', kind: 'sight', text: 'Dark here, placing a torch.', priority: 2, lightAt: { x: t.x, y: t.y, z: t.z } }); break; }
      }
    }
  }

  // Time and weather.
  const t = bot.time?.timeOfDay ?? 0;
  if (t > 12200 && t < 12800 && fresh('dusk', 8 * 60_000)) out.push({ key: 'dusk', kind: 'sight', text: 'It\'s getting dark. Want to head to bed, or should I light things up?', priority: 2 });
  if ((bot as any).thunderState > 0.5 && fresh('thunder', 10 * 60_000)) out.push({ key: 'thunder', kind: 'sight', text: 'Thunderstorm. Charged creepers and lightning, stay sharp.', priority: 2 });

  // Biome changes (new biome around the player).
  const biome = biomeAt(b, center.floored());
  if (biome && BIOME_LINES[biome] && fresh(`biome:${biome}`, 30 * 60_000)) out.push({ key: `biome:${biome}`, kind: 'sight', text: BIOME_LINES[biome], priority: 1 });

  // Nice animals.
  for (const e of Object.values(bot.entities) as any[]) {
    const line = NICE_MOBS[e.name];
    if (line && e.position.distanceTo(center) < 16 && fresh(`mob:${e.name}`, 15 * 60_000)) { out.push({ key: `mob:${e.name}`, kind: 'sight', text: line, priority: 1 }); break; }
  }

  // Places worth remembering: villages (villagers/bells), spawners, structure chests.
  const villager = Object.values(bot.entities).find((e: any) => e.name === 'villager' && e.position.distanceTo(me) < 48) as any;
  if (villager) {
    const v = villager.position.floored(), key = `village:${Math.round(v.x / 64)},${Math.round(v.z / 64)}`;
    if (fresh(key, 24 * 60 * 60_000)) out.push({ key, kind: 'place', text: `A village around ${v.x} ${v.y} ${v.z}! I'll remember it.`, priority: 2, place: { what: 'village', x: v.x, y: v.y, z: v.z } });
  }
  const special = bot.findBlocks({ matching: (blk: any) => ['spawner', 'trial_spawner', 'end_portal_frame', 'bell', 'enchanting_table'].includes(blk.name), maxDistance: 32, count: 4 });
  for (const p of special) {
    const blk = bot.blockAt(p);
    if (!blk) continue;
    const what = blk.name === 'spawner' || blk.name === 'trial_spawner' ? 'mob spawner' : blk.name === 'end_portal_frame' ? 'stronghold portal' : blk.name.replace(/_/g, ' ');
    if (blk.name === 'bell' || blk.name === 'enchanting_table') continue; // bells mark villages (covered above); tables are usually yours
    const key = `place:${what}:${p.x},${p.z}`;
    if (fresh(key, 24 * 60 * 60_000)) out.push({ key, kind: 'place', text: `A ${what} at ${p.x} ${p.y} ${p.z}! Remembering that.`, priority: 2, place: { what, x: p.x, y: p.y, z: p.z } });
  }
  return out;
}

/** Something interesting to glance at while idle (an animal, a mob, another player), or null. */
export function glanceTarget(bot: Bot, owner: string | null): any {
  const me = bot.entity.position;
  const cands = (Object.values(bot.entities) as any[]).filter((e) => e !== bot.entity && e.username !== owner && e.position.distanceTo(me) < 12 && (e.type === 'player' || e.type === 'animal' || e.type === 'hostile' || NICE_MOBS[e.name]));
  return cands.length ? cands[Math.floor(Math.random() * cands.length)] : null;
}

/** One line for the AI: where we are and what's around. */
export function aroundUs(bot: Bot, owner: string | null): string {
  const me = bot.entity.position;
  const t = bot.time?.timeOfDay ?? 0;
  const tod = t < 1000 ? 'morning' : t < 6000 ? 'day' : t < 12000 ? 'afternoon' : t < 13000 ? 'dusk' : t < 23000 ? 'night' : 'dawn';
  const biome = biomeAt(bot, me.floored()) || 'unknown';
  const threats = (Object.values(bot.entities) as any[]).filter((e) => e.type === 'hostile' && e.position.distanceTo(me) < 16).map((e) => e.name);
  const weather = (bot as any).thunderState > 0.5 ? 'thunderstorm' : bot.isRaining ? 'rain' : 'clear';
  return `AROUND US: ${biome}, ${tod}, ${weather}${threats.length ? `, threats: ${[...new Set(threats)].join(', ')}` : ', no threats'}`;
}
