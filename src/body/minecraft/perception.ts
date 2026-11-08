import type { Bot } from 'mineflayer';

const NOTABLE = (n: string) =>
  n.endsWith('_ore') || n.endsWith('_log') || n.endsWith('_bed') ||
  ['crafting_table', 'furnace', 'blast_furnace', 'smoker', 'chest', 'barrel', 'ancient_debris',
   'water', 'lava', 'spawner', 'nether_portal', 'end_portal_frame', 'obsidian'].includes(n);

let notableIds: number[] | null = null;

export const fmt = (p: { x: number; y: number; z: number }) =>
  `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;

export function inventorySummary(bot: Bot): string {
  const counts = new Map<string, number>();
  for (const it of bot.inventory.items()) counts.set(it.name, (counts.get(it.name) ?? 0) + it.count);
  return [...counts].map(([n, c]) => `${n}x${c}`).join(', ') || 'empty';
}

export function nearbyBlocks(bot: Bot, radius = 32): string {
  notableIds ??= Object.values(bot.registry.blocksByName).filter((b: any) => NOTABLE(b.name)).map((b: any) => b.id);
  const found = bot.findBlocks({ matching: notableIds, maxDistance: radius, count: 400 });
  const groups = new Map<string, { n: number; nearest: any; d: number }>();
  const me = bot.entity.position;
  for (const pos of found) {
    const b = bot.blockAt(pos);
    if (!b) continue;
    const d = pos.distanceTo(me);
    const g = groups.get(b.name);
    if (!g) groups.set(b.name, { n: 1, nearest: pos, d });
    else { g.n++; if (d < g.d) { g.d = d; g.nearest = pos; } }
  }
  return [...groups].sort((a, b) => a[1].d - b[1].d)
    .map(([name, g]) => `${name}x${g.n} (nearest ${fmt(g.nearest)}, ${g.d.toFixed(0)}m)`).join('; ') || 'nothing notable';
}

export function nearbyEntities(bot: Bot, radius = 24): string {
  const me = bot.entity.position;
  return Object.values(bot.entities)
    .filter((e) => e !== bot.entity && e.position.distanceTo(me) <= radius)
    .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))
    .slice(0, 15)
    .map((e) => {
      const name = e.type === 'player' ? `player:${e.username}` : e.name === 'item' ? `item:${(e as any).getDroppedItem?.()?.name ?? '?'}` : e.name;
      return `${name} ${e.position.distanceTo(me).toFixed(0)}m${e.type === 'hostile' ? ' [hostile]' : ''}`;
    }).join(', ') || 'none';
}

const MODES = ['survival', 'creative', 'adventure', 'spectator'];

/** Op level arrives as entity status 24-28 (level 0-4); level 2+ can run /give, /tp etc. */
export const canUseCommands = (bot: Bot) => ((bot as any).craftieOpLevel ?? 0) >= 2;

function playerModes(bot: Bot): string {
  return Object.values(bot.players).filter((p) => p.username !== bot.username)
    .map((p) => `${p.username} (${MODES[p.gamemode] ?? '?'})`).join(', ') || 'none';
}

/** What's stored where (from Craftie's chest memory), squeezed into one line. */
function chestLine(bot: any): string[] {
  const list = [...(bot.craftieChests?.values?.() ?? [])] as any[];
  const home = bot.craftieHome ? [`home (your bed): ${bot.craftieHome.x},${bot.craftieHome.y},${bot.craftieHome.z}`] : [];
  if (!list.length) return home;
  const desc = list.slice(0, 4).map((c) => `${c.x},${c.y},${c.z}: ${Object.entries(c.items).sort((a: any, b: any) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k}x${v}`).join(' ') || 'empty'}`);
  return [...home, `my chests: ${desc.join(' | ')}`.slice(0, 400)];
}

export function describe(bot: Bot): string {
  const t = bot.time.timeOfDay;
  return [
    `pos ${fmt(bot.entity.position)} in ${bot.game.dimension} | health ${bot.health?.toFixed(0)}/20 food ${bot.food}/20 | ${t < 12500 || t > 23500 ? 'day' : 'night'}${bot.isRaining ? ', raining' : ''}`,
    `GAME MODE: I am in ${bot.game.gameMode} | commands allowed: ${canUseCommands(bot) ? 'yes' : 'no'} | players: ${playerModes(bot)}`,
    `holding: ${bot.heldItem?.name ?? 'nothing'}`,
    `inventory: ${inventorySummary(bot)}`,
    ...chestLine(bot),
    ...((bot as any).craftieReserved?.size ? [`held for the player (don't use): ${[...(bot as any).craftieReserved].map(([k, v]: any) => `${k}x${v}`).join(', ')}`] : []),
    `entities: ${nearbyEntities(bot)}`,
    `blocks: ${nearbyBlocks(bot)}`,
  ].join('\n');
}

const GATHERABLE = (n: string) => n.endsWith('_log') || n.endsWith('_ore') || n.endsWith('_leaves') ||
  ['stone', 'cobblestone', 'deepslate', 'dirt', 'grass_block', 'sand', 'red_sand', 'gravel', 'clay', 'snow_block', 'ice',
   'andesite', 'diorite', 'granite', 'tuff', 'calcite', 'netherrack', 'obsidian', 'ancient_debris', 'pumpkin', 'melon',
   'sugar_cane', 'bamboo', 'cactus', 'mud', 'terracotta', 'basalt', 'blackstone', 'end_stone', 'amethyst_block'].includes(n);
let gatherIds: number[] | null = null;

export function vocab(bot: Bot) {
  gatherIds ??= Object.values(bot.registry.blocksByName).filter((b: any) => GATHERABLE(b.name)).map((b: any) => b.id);
  const blocks = new Set<string>();
  for (const p of bot.findBlocks({ matching: gatherIds, maxDistance: 48, count: 3000 })) {
    const n = bot.blockAt(p)?.name;
    if (n) blocks.add(n.startsWith('deepslate_') && n.endsWith('_ore') ? n.slice(10) : n);
  }
  const me = bot.entity.position;
  const near = Object.values(bot.entities).filter((e) => e !== bot.entity && e.position.distanceTo(me) < 32);
  return {
    blocks: [...blocks],
    items: [...new Set(bot.inventory.items().map((i) => i.name))],
    mobs: [...new Set(near.filter((e) => e.type !== 'player' && e.name && e.name !== 'item' && e.name !== 'experience_orb').map((e) => e.name!))],
    players: near.filter((e) => e.type === 'player').map((e) => e.username!),
    creative: bot.game.gameMode === 'creative',
  };
}
