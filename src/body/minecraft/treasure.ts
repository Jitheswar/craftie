// Treasure sense: notice valuable ores and dropped items around Craftie and the player.
// Close, visible, safe finds get grabbed as a quick chore; deep or risky ones are reported
// once and remembered. Plain code, no AI.
import type { Bot } from 'mineflayer';

const RARE = ['diamond_ore', 'deepslate_diamond_ore', 'emerald_ore', 'deepslate_emerald_ore', 'ancient_debris', 'gold_ore', 'deepslate_gold_ore', 'nether_gold_ore'];
const USEFUL = ['iron_ore', 'deepslate_iron_ore', 'lapis_ore', 'deepslate_lapis_ore', 'redstone_ore', 'deepslate_redstone_ore', 'copper_ore', 'deepslate_copper_ore'];
const VALUABLE_ITEMS = /diamond|emerald|netherite|ancient_debris|gold_ingot|gold_block|enchanted_book|totem_of_undying|golden_apple|elytra|trident|heart_of_the_sea|nautilus_shell|name_tag|saddle|music_disc/;

export type Treasure =
  | { kind: 'grab'; block: string; x: number; y: number; z: number; rare: boolean }
  | { kind: 'item'; item: string; x: number; y: number; z: number }
  | { kind: 'report'; block: string; x: number; y: number; z: number; depth: number; why: string };

const seen = new Set<string>(); // finds already handled or reported (per session)

export function findTreasure(bot: Bot, owner: string | null): Treasure | null {
  if (bot.game.gameMode === 'creative' || bot.game.gameMode === 'spectator') return null;
  const me = bot.entity.position;
  const o = owner ? Object.values(bot.entities).find((e) => e.username === owner) : null;
  const nearPlayer = (p: any) => !o || p.distanceTo(o.position) <= 10;

  // 1. Valuable items lying around: always worth picking up when close.
  for (const e of Object.values(bot.entities) as any[]) {
    if (e.name !== 'item') continue;
    const it = e.getDroppedItem?.();
    if (!it || !VALUABLE_ITEMS.test(it.name) || e.position.distanceTo(me) > 12 || !nearPlayer(e.position)) continue;
    const key = `item:${e.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    return { kind: 'item', item: it.name, x: e.position.x, y: e.position.y, z: e.position.z };
  }

  // 2. Ores.
  const ids = [...RARE, ...USEFUL].map((n) => (bot.registry.blocksByName as any)[n]?.id).filter((x) => x !== undefined);
  const air = (p: any) => ['air', 'cave_air'].includes(bot.blockAt(p)?.name ?? '');
  const lavaNear = (p: any) => [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1],[0,-2,0]].some(([x, y, z]) => (bot.blockAt(p.offset(x, y, z))?.name ?? '').includes('lava'));
  const found = bot.findBlocks({ matching: ids, maxDistance: 24, count: 80 });
  for (const p of found.sort((a, b) => a.distanceTo(me) - b.distanceTo(me))) {
    const key = `${p.x},${p.y},${p.z}`;
    if (seen.has(key)) continue;
    const b = bot.blockAt(p);
    if (!b) continue;
    const rare = RARE.includes(b.name);
    const exposed = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]].some(([x, y, z]) => air(p.offset(x, y, z)));
    const depth = Math.round(me.y - p.y);
    // Mining it with the wrong pickaxe destroys it (no drop), so only grab what we can harvest.
    const canHarvest = !(b as any).harvestTools || bot.inventory.items().some((i) => (b as any).harvestTools[i.type]);
    const safeClose = exposed && Math.abs(depth) <= 4 && p.distanceTo(me) <= 10 && nearPlayer(p) && !lavaNear(p);
    if (safeClose && canHarvest) { seen.add(key); return { kind: 'grab', block: b.name, x: p.x, y: p.y, z: p.z, rare }; }
    if (safeClose && !canHarvest && !rare) { seen.add(key); continue; } // common ore, wrong tool: not worth a message
    // Rare but not a safe quick grab: tell the player once, and remember it.
    if (rare) {
      seen.add(key);
      // Skip the rest of the same vein so one find gives one message.
      for (const q of found) if (q.distanceTo(p) < 4) seen.add(`${q.x},${q.y},${q.z}`);
      const why = safeClose && !canHarvest ? 'I need a better pickaxe for it' : lavaNear(p) ? 'next to lava' : !exposed ? 'inside the rock' : Math.abs(depth) > 4 ? `${Math.abs(depth)} blocks ${depth > 0 ? 'down' : 'up'}` : 'too far from you';
      return { kind: 'report', block: b.name, x: p.x, y: p.y, z: p.z, depth, why };
    }
  }
  return null;
}
