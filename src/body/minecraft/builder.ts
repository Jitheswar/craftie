// build: blueprint -> finished structure, with no further AI calls.
//  1. design: quality presets (cottage, tower, ...) or an AI-made layer design
//  2. materials: count what's missing and obtain() it (trees, mining, crafting, smelting).
//     Decorations that can't be found get swapped for basic blocks, never a hard stop.
//  3. clear the site, add foundation under any holes
//  4. place bottom-up, every block touching something solid, with exact facing for
//     stairs/doors/logs; temporary scaffolding is tracked and removed afterwards
import pf from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { logsFor, newPlan, obtain } from './planner.ts';
import { cancellable, count, epoch, findItem, flyRoute as flyOver, flyTo, pauseGate, sleep } from './skills.ts';

const { goals, Movements } = pf as any;

type Facing = 'north' | 'south' | 'east' | 'west';
import { loadSchematic } from './schematics.ts';
export type Cell = { x: number; y: number; z: number; block: string; facing?: Facing; half?: 'top' | 'bottom' };
export type BuildArgs = {
  blueprint?: 'house' | 'cottage' | 'hut' | 'tower' | 'wall' | 'platform' | 'custom';
  width?: number; depth?: number; height?: number;
  /** Palette overrides. "planks"/"log"/"stairs" mean "whatever wood is around". */
  walls?: string; pillars?: string; base?: string; roof?: string; windows?: string;
  furnish?: boolean; lights?: boolean;
  /** custom: layers[y][z] = row string, one char per x. Legend char -> block, e.g. "oak_stairs[facing=east]". "_" = must be air, "." = don't care. */
  layers?: string[][]; legend?: Record<string, string>;
  /** Build a schematic file (.schem / .litematic) from ~/.craftie/schematics by name. */
  schematic?: string;
  x?: number; y?: number; z?: number;
  /** Build on the flattest free spot near this point (used by projects to lay out several builds). */
  near?: { x: number; z: number };
};

const SOFT = new Set(['air', 'cave_air', 'void_air', 'short_grass', 'grass', 'tall_grass', 'fern', 'large_fern', 'snow', 'dead_bush',
  'dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet', 'oxeye_daisy', 'cornflower', 'lily_of_the_valley', 'red_tulip',
  'orange_tulip', 'white_tulip', 'pink_tulip', 'sweet_berry_bush', 'water', 'lava', 'vine', 'seagrass', 'torch', 'wall_torch']);
const isSolid = (b: any) => b && !SOFT.has(b.name) && b.boundingBox === 'block';
// Clicking these opens/uses them instead of placing against them.
const USABLE = /door|chest|furnace|crafting_table|smoker|barrel|bed|gate|trapdoor|button|lever|anvil|table|shulker|hopper|dispenser|dropper|loom|grindstone|stonecutter|bell|note_block|jukebox|sign|beacon|brewing|enchanting|lectern|composter|cauldron|campfire/;
const canBuildOn = (b: any) => isSolid(b) && !USABLE.test(b.name);
// Blocks that (almost) never generate naturally: if one is in the way, someone built it. Never break those.
const PLAYER_MADE = /_planks$|_stairs$|_slab$|glass|_wool$|_carpet$|bricks?$|concrete|_door$|trapdoor|torch|lantern|chest|furnace|crafting_table|_bed$|fence|_wall$|smooth_|polished_|chiseled_|cut_|bookshelf|_sign$|banner|barrel|smoker|anvil|hay_block|_terracotta$|glazed|iron_block|gold_block|diamond_block|emerald_block|ladder|scaffolding|rail$/;
const playerMade = (n: string) => PLAYER_MADE.test(n) && !/^(infested|mossy_cobblestone_wall)/.test(n);
const YAW: Record<Facing, number> = { north: 0, west: Math.PI / 2, south: Math.PI, east: -Math.PI / 2 };
const DECOR = /pane|glass|torch|lantern|chest|furnace|crafting_table|bed|carpet|flower|banner|door|trapdoor|fence|slab/;
const SCAFFOLD = ['dirt', 'cobblestone'];
// These turn their front toward the player, so to face X the bot must look the opposite way.
const FACES_PLAYER = /furnace|chest|barrel|smoker|dispenser|dropper|observer|piston|carved_pumpkin|jack_o_lantern|loom|beehive/;
const OPPOSITE: Record<Facing, Facing> = { north: 'south', south: 'north', east: 'west', west: 'east' };

function wood(bot: any): string {
  const have = bot.inventory.items().find((i: any) => /_(log|planks)$/.test(i.name) && !i.name.startsWith('stripped'));
  if (have) return have.name.replace(/_(log|planks)$/, '');
  const ids = Object.values(bot.registry.blocksByName as Record<string, any>).filter((b) => b.name.endsWith('_log') && !b.name.startsWith('stripped')).map((b) => b.id);
  return bot.findBlock({ matching: ids, maxDistance: 64 })?.name.replace(/_log$/, '') ?? 'oak';
}

function resolve(bot: any, name: unknown, fallback: string): string {
  const n = typeof name === 'string' && name ? name : fallback, w = wood(bot); // ignore stray booleans like windows:true
  return ({ planks: `${w}_planks`, wood: `${w}_planks`, log: `${w}_log`, logs: `${w}_log`, stairs: `${w}_stairs`, slab: `${w}_slab`, door: `${w}_door`, fence: `${w}_fence` } as Record<string, string>)[n] ?? n;
}

/** "oak_stairs[facing=east,half=top]" -> cell fields */
function parseBlock(s: string): Pick<Cell, 'block' | 'facing' | 'half'> {
  const m = s.match(/^([a-z0-9_:]+)(?:\[(.*)\])?$/);
  const props = Object.fromEntries((m?.[2] ?? '').split(',').filter(Boolean).map((kv) => kv.split('=').map((x) => x.trim())));
  return { block: (m?.[1] ?? s).replace(/^minecraft:/, ''), facing: props.facing, half: props.half };
}

// ---------- designs ----------
function cottage(bot: any, a: BuildArgs): { cells: Cell[]; d: number; doorZ: number } {
  const w = Math.max(5, a.width ?? 7), d = Math.max(5, a.depth ?? 9), h = Math.max(3, a.height ?? 4);
  const walls = resolve(bot, a.walls, 'planks'), pillars = resolve(bot, a.pillars, 'log');
  const base = resolve(bot, a.base, 'cobblestone'), stairs = resolve(bot, a.roof, 'stairs');
  const glass = resolve(bot, a.windows, 'glass_pane'), slab = stairs.replace(/_stairs$/, '_slab');
  const cells: Cell[] = [];
  const doorZ = Math.floor(d / 2);
  const add = (x: number, y: number, z: number, block: string, extra: Partial<Cell> = {}) => cells.push({ x, y, z, block, ...extra });

  // Floor: stone base under everything.
  for (let x = 0; x < w; x++) for (let z = 0; z < d; z++) add(x, -1, z, base);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let z = 0; z < d; z++) {
    const ex = x === 0 || x === w - 1, ez = z === 0 || z === d - 1;
    if (!ex && !ez) { add(x, y, z, 'air'); continue; }
    if (ex && ez) { add(x, y, z, pillars); continue; }              // corner pillars
    if (y === 0) { add(x, y, z, base); continue; }                     // stone band at the bottom
    const isDoor = x === 0 && z === doorZ && y <= 1;
    if (isDoor) { add(x, y, z, 'air'); continue; }
    // Windows: middle of each wall, plus pairs on the long walls.
    const midX = Math.floor(w / 2);
    const win = y >= 1 && y <= Math.min(2, h - 2) && (
      (ez && Math.abs(x - midX) <= (w >= 7 ? 1 : 0) && x > 0 && x < w - 1) ||
      (ex && x === w - 1 && Math.abs(z - doorZ) <= 1) ||
      (ex && (z === 2 || z === d - 3) && z !== doorZ));
    add(x, y, z, win ? glass : walls);
  }
  if (a.furnish ?? true) {
    add(w - 2, 0, 1, 'crafting_table'); add(w - 2, 0, 2, 'furnace', { facing: 'west' }); add(w - 2, 0, d - 2, 'chest', { facing: 'west' });
  }
  if (a.lights ?? true) { add(-1, 1, doorZ - 1, 'torch'); add(-1, 1, doorZ + 1, 'torch'); add(Math.floor(w / 2), h - 1, 1, 'torch'); }
  add(0, 0, doorZ, resolve(bot, 'door', 'door'), { facing: 'east' });

  // Gable roof along z, 1 block overhang all round. Rows climb from both sides to a ridge.
  for (let k = 0; ; k++) {
    const left = -1 + k, right = w - k, y = h - 1 + k;
    if (left > right) break;
    for (let z = -1; z <= d; z++) {
      if (left === right) add(left, y, z, slab, { half: 'bottom' });
      else { add(left, y, z, stairs, { facing: 'east', half: 'bottom' }); add(right, y, z, stairs, { facing: 'west', half: 'bottom' }); }
    }
    // Gable ends: fill the triangle under the roof at the front and back walls.
    if (k >= 1) for (let x = left + 1; x < right; x++) if (x >= 0 && x < w) { add(x, y, 0, walls); add(x, y, d - 1, walls); }
    if (k >= 1) for (let x = left + 1; x < right; x++) for (let z = 1; z < d - 1; z++) if (x > 0 && x < w - 1) add(x, y, z, 'air');
    if (left === right || left + 1 === right) break;
  }
  return { cells, d, doorZ };
}

/** Later cells win when two land on the same spot (e.g. the door over a "keep clear" cell). */
function dedupe<T extends { cells: Cell[] }>(r: T): T {
  const m = new Map<string, Cell>();
  for (const c of r.cells) m.set(`${c.x},${c.y},${c.z}`, c);
  return { ...r, cells: [...m.values()] };
}

function design(bot: any, a: BuildArgs) { return dedupe(designRaw(bot, a)); }

function designRaw(bot: any, a: BuildArgs): { cells: Cell[]; d: number; doorZ?: number } {
  const kind = a.blueprint ?? 'house';
  if (kind === 'house' || kind === 'cottage') return cottage(bot, a);
  if (kind === 'hut') return cottage(bot, { ...a, width: a.width ?? 5, depth: a.depth ?? 5, height: a.height ?? 3, furnish: a.furnish ?? false });
  const cells: Cell[] = [];
  const walls = resolve(bot, a.walls, 'planks');
  if (kind === 'custom') {
    let d = 0;
    (a.layers ?? []).forEach((rows, y) => rows.forEach((row, z) => [...row].forEach((ch, x) => {
      d = Math.max(d, z + 1);
      if (ch === '_') cells.push({ x, y, z, block: 'air' });
      else if (ch !== '.' && ch !== ' ') { const b = parseBlock(resolve(bot, a.legend?.[ch], walls)); cells.push({ x, y, z, ...b, block: resolve(bot, b.block, walls) }); }
    })));
    return { cells, d };
  }
  if (kind === 'wall') {
    const len = a.width ?? 9, h = a.height ?? 3, pillars = resolve(bot, a.pillars, 'log');
    for (let y = 0; y < h; y++) for (let z = 0; z < len; z++) cells.push({ x: 0, y, z, block: z % 4 === 0 ? pillars : walls });
    return { cells, d: len };
  }
  if (kind === 'platform') {
    const w = a.width ?? 7, d = a.depth ?? w;
    for (let x = 0; x < w; x++) for (let z = 0; z < d; z++) cells.push({ x, y: -1, z, block: (x + z) % 2 ? walls : resolve(bot, a.base, 'cobblestone') });
    return { cells, d };
  }
  // tower: stone base, log corners, windows every other floor, battlements
  const w = a.width ?? 5, h = a.height ?? 10, base = resolve(bot, a.base, 'cobblestone'), pillars = resolve(bot, a.pillars, 'log');
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let z = 0; z < w; z++) {
    const ex = x === 0 || x === w - 1, ez = z === 0 || z === w - 1;
    if (!ex && !ez) { cells.push({ x, y, z, block: y === h - 1 ? walls : 'air' }); continue; }
    if (x === 0 && z === Math.floor(w / 2) && y <= 1) { cells.push({ x, y, z, block: 'air' }); continue; }
    cells.push({ x, y, z, block: ex && ez ? pillars : y < 2 ? base : walls });
  }
  for (let x = 0; x < w; x++) for (let z = 0; z < w; z++) if ((x === 0 || z === 0 || x === w - 1 || z === w - 1) && (x + z) % 2 === 0) cells.push({ x, y: h, z, block: base });
  return { cells, d: w, doorZ: Math.floor(w / 2) };
}

/**
 * Place a block that has a facing (stairs, doors, furnaces...). The server takes the
 * facing from where the player looks, so: settle, look, settle, place, then check.
 * If it came out facing the wrong way, break it and try again.
 */
async function placeFacing(bot: any, ref: { n: Vec3; b: any }, c: Cell, p: Vec3) {
  const yaw = YAW[FACES_PLAYER.test(c.block) ? OPPOSITE[c.facing!] : c.facing!];
  for (let attempt = 0; attempt < 3; attempt++) {
    bot.pathfinder.setGoal(null);
    await bot.waitForTicks(1);
    await bot.look(yaw, 0, true);
    await bot.waitForTicks(1);
    try {
      await bot._placeBlockWithOptions(ref.b, ref.n.scaled(-1), { forceLook: 'ignore', half: c.half, swingArm: 'right' });
    } catch (e: any) {
      // Some blocks (doors) aren't accepted with a forced look; fall back to looking at the spot.
      if (attempt === 2) throw e;
      await bot._placeBlockWithOptions(ref.b, ref.n.scaled(-1), { half: c.half, swingArm: 'right' }).catch(() => {});
    }
    const placed = bot.blockAt(p);
    if (!placed || placed.name === 'air') continue;
    const f = placed?.getProperties?.()?.facing;
    if (!f || f === c.facing) return;
    if (process.env.CRAFTIE_DEBUG) console.log(`[build] ${c.block} at ${p} faced ${f}, wanted ${c.facing}; redoing`);
    await bot.dig(placed).catch(() => {});
    await bot.waitForTicks(2);
  }
}

// ---------- site choice ----------
/**
 * Find the spot near the bot that needs the least foundation and clearing.
 * Ground level is the median surface height under the footprint.
 */
function chooseSite(bot: any, w: number, d: number, h: number, near?: { x: number; z: number }): Vec3 {
  const me = near ? new Vec3(Math.floor(near.x), bot.entity.position.floored().y, Math.floor(near.z)) : bot.entity.position.floored();
  const surface = (x: number, z: number) => {
    for (let y = me.y + 6; y > me.y - 10; y--) {
      const b = bot.blockAt(new Vec3(x, y, z));
      if (b && isSolid(b) && !b.name.endsWith('_leaves') && !b.name.endsWith('_log')) return y + 1;
      if (b && (b.name === 'water' || b.name === 'lava')) return null;
    }
    return null;
  };
  let best: { o: Vec3; cost: number } | null = null;
  for (let dx = -12; dx <= 12; dx += 2) for (let dz = -12; dz <= 12; dz += 2) {
    const ox = me.x + dx, oz = me.z + dz;
    const heights: number[] = [];
    let water = false;
    for (let x = -1; x <= w; x += 2) for (let z = -1; z <= d; z += 2) { const s = surface(ox + x, oz + z); if (s === null) water = true; else heights.push(s); }
    if (water || !heights.length) continue;
    heights.sort((a, b) => a - b);
    const base = heights[Math.floor(heights.length / 2)];
    let cost = heights.reduce((c, y) => c + Math.abs(y - base) * 3, 0);         // dig/fill
    for (let x = 0; x < w; x += 2) for (let z = 0; z < d; z += 2) for (let y = 0; y < h; y += 2) {
      const b = bot.blockAt(new Vec3(ox + x, base + y, oz + z));
      if (b && b.name !== 'air' && !SOFT.has(b.name)) cost += playerMade(b.name) ? 10000 : b.name.endsWith('_log') ? 6 : 2;  // trees in the way; never on someone's build
    }
    cost += Math.hypot(dx, dz) * 0.3;                                              // prefer close by
    if (!best || cost < best.cost) best = { o: new Vec3(ox, base, oz), cost };
  }
  return best?.o ?? me.offset(3, 0, -Math.floor(d / 2));
}

// ---------- building ----------
const prof: Record<string, { ms: number; n: number }> = {};
async function timed<T>(name: string, f: () => Promise<T>): Promise<T> {
  const t = performance.now();
  try { return await f(); } finally { const e = (prof[name] ??= { ms: 0, n: 0 }); e.ms += performance.now() - t; e.n++; }
}

export async function build(bot: any, a: BuildArgs, signal: AbortSignal): Promise<string> {
  for (const k of Object.keys(prof)) delete prof[k];
  let cells: Cell[], d: number, doorZ: number | undefined;
  if (a.schematic) {
    const s = await loadSchematic(a.schematic).catch((e) => e as Error);
    if (s instanceof Error) return s.message;
    cells = s.cells; d = Math.max(...cells.map((c) => c.z)) + 1;
  } else ({ cells, d, doorZ } = design(bot, a));
  if (!cells.length) return 'empty design';
  const me = bot.entity.position.floored();
  const W = Math.max(...cells.map((c) => c.x)) + 1, H = Math.max(...cells.map((c) => c.y)) + 1;
  const origin = a.x !== undefined ? new Vec3(a.x, a.y ?? me.y, a.z ?? me.z) : chooseSite(bot, W, d, H, a.near);
  // Remember the spot, so a retry builds on the same site instead of starting a new house.
  a.x = origin.x; a.y = origin.y; a.z = origin.z;
  const at = (c: Cell) => origin.offset(c.x, c.y, c.z);
  const key = (p: Vec3) => `${p.x},${p.y},${p.z}`;

  // Foundation under the lowest layer, up to 4 deep.
  const lowest = Math.min(...cells.filter((c) => c.block !== 'air').map((c) => c.y));
  const footing = new Map<string, Cell>();
  for (const c of cells.filter((c) => c.y === lowest && c.block !== 'air')) {
    for (let dy = 1; dy <= 4; dy++) {
      const cell = { x: c.x, y: c.y - dy, z: c.z, block: 'cobblestone' };
      if (isSolid(bot.blockAt(at(cell)))) break;
      footing.set(key(at(cell)), cell);
    }
  }
  cells = [...footing.values(), ...cells];

  // Materials. Decorations fall back to plain blocks (or are skipped) if they can't be obtained.
  const plan = newPlan(signal);
  const missing = () => {
    const need = new Map<string, number>();
    for (const c of cells) if (c.block !== 'air' && bot.blockAt(at(c))?.name !== c.block) need.set(c.block, (need.get(c.block) ?? 0) + 1);
    return need;
  };
  console.log('[build] materials:', [...missing()].map(([k, v]) => `${k}x${v}`).join(', '));
  if (bot.game.gameMode !== 'creative' && count(bot, 'dirt') + count(bot, 'cobblestone') < 12) {
    try { await obtain(bot, 'dirt', 16, plan); } catch {} // scaffolding to reach the roof
  }
  // Crafted materials first, raw blocks (logs, stone...) last, so crafting stairs or planks
  // doesn't eat the logs meant for pillars. Then top up until everything is in stock at once.
  const isRaw = (n: string) => /_log$|^cobblestone$|^dirt$|^stone$|^sand$|^gravel$/.test(n);
  // Speed: chop all the wood for every wooden part in one trip, instead of a trip per material.
  if (bot.game.gameMode !== 'creative') {
    const w = wood(bot);
    let logs = 0;
    for (const [item, n] of missing()) logs += /_log$/.test(item) ? Math.max(0, n - count(bot, item)) : logsFor(bot, item, n - count(bot, item));
    if (logs > 0) {
      const want = count(bot, `${w}_log`) + Math.ceil(logs * 1.1);
      console.log(`[build] chopping ${Math.ceil(logs * 1.1)} ${w}_log in one go for all the wooden parts`);
      try { await obtain(bot, `${w}_log`, want, plan); } catch (e: any) { if (signal.aborted) throw e; }
    }
  }
  for (let round = 0; round < 4 && bot.game.gameMode !== 'creative'; round++) {
    const short = [...missing()].filter(([item, n]) => count(bot, item) < n)
      .sort(([a], [b]) => Number(isRaw(a)) - Number(isRaw(b)));
    if (!short.length) break;
    for (const [item, n] of short) {
      try { await obtain(bot, item, n, plan); }
      catch (e: any) {
        if (signal.aborted) throw e;
        if (!DECOR.test(item)) return `stopped while getting ${item}: ${e.message}`;
        const swap = /pane|glass/.test(item) ? resolve(bot, a.walls, 'planks') : null;
        console.log(`[build] couldn't get ${item} (${e.message}); ${swap ? 'using ' + swap : 'skipping it'}`);
        cells = cells.flatMap((c) => (c.block !== item ? [c] : swap ? [{ ...c, block: swap }] : []));
      }
    }
  }

  const wanted = new Map(cells.map((c) => [key(at(c)), c.block]));
  const scaffolds = new Map<string, Vec3>();
  // Any dirt/cobblestone that shows up where the design wants something else (or nothing) is scaffolding.
  // Only near the site: dirt/cobble appearing elsewhere (other builds, lava meeting water) isn't ours.
  const xs = cells.map((c) => origin.x + c.x), ys = cells.map((c) => origin.y + c.y), zs = cells.map((c) => origin.z + c.z);
  const box = { x0: Math.min(...xs) - 4, x1: Math.max(...xs) + 4, y0: Math.min(...ys) - 2, y1: Math.max(...ys) + 4, z0: Math.min(...zs) - 4, z1: Math.max(...zs) + 4 };
  const nearSite = (p: Vec3) => p.x >= box.x0 && p.x <= box.x1 && p.y >= box.y0 && p.y <= box.y1 && p.z >= box.z0 && p.z <= box.z1;
  const onUpdate = (_old: any, nb: any) => {
    if (nb && SCAFFOLD.includes(nb.name) && nearSite(nb.position) && wanted.get(key(nb.position)) !== nb.name) scaffolds.set(key(nb.position), nb.position.clone());
  };
  bot.on('blockUpdate', onUpdate);

  const oldMoves = bot.pathfinder.movements;
  const moves = new Movements(bot);
  moves.canDig = false; moves.allowParkour = false;
  const creative = bot.game.gameMode === 'creative';
  moves.allow1by1towers = true;                                        // pillar up to reach the roof (cleaned up afterwards)
  moves.scafoldingBlocks = SCAFFOLD.map((n) => bot.registry.itemsByName[n].id);
  void creative;
  bot.pathfinder.setMovements(moves);
  // Creative flight that doesn't get stuck: flying moves in straight lines and stops at obstacles,
  // so longer trips go up above the build and trees first, across, then down onto the spot.
  // (H = design height, from above)
  const flyLeg = async (to: Vec3, _ms: number) => { await flyTo(bot, to); };
  // Inside the build site, the way is clear (it builds bottom-up and hovers just above the
  // current layer), so hops there go straight; only trips from outside go up and over.
  const inSite = (p: Vec3) => p.x >= origin.x - 4 && p.x <= origin.x + W + 4 && p.z >= origin.z - 4 && p.z <= origin.z + d + 4;
  const flyRoute = async (target: Vec3) => {
    const pos = bot.entity.position;
    const flat = Math.hypot(target.x - pos.x, target.z - pos.z);
    if ((inSite(pos) && inSite(target)) || (flat < 5 && Math.abs(target.y - pos.y) < 5)) {
      // Rise first if the target is higher (never drag through the layer we just built), then across.
      if (target.y > pos.y + 0.5) await flyLeg(new Vec3(pos.x, target.y, pos.z), 0);
      return flyLeg(target, 0);
    }
    const cruise = Math.max(pos.y, target.y, origin.y + H) + 3;
    if (pos.y < cruise - 0.5) await flyLeg(new Vec3(pos.x, cruise, pos.z), 3000);
    await flyLeg(new Vec3(target.x, cruise, target.z), 4000);
    await flyLeg(target, 3000);
  };

  // Every walk is capped, so a blocked route can never hang the build.
  const go = async (goal: any, ms = 25_000) => {
    await pauseGate(bot);
    // (Building walks: flying straight lines kept getting blocked by terrain and trees around the site.)
    let timer: any;
    const limit = new Promise<void>((res) => { timer = setTimeout(() => { bot.pathfinder.stop(); res(); }, ms); });
    try { await timed('walk', () => cancellable(bot, signal, Promise.race([bot.pathfinder.goto(goal), limit])).catch((e: any) => { if (signal.aborted) throw e; if (process.env.CRAFTIE_DEBUG) console.log('[build] walk failed:', e.message, 'goal', JSON.stringify(goal), 'me', bot.entity.position.floored().toString()); })); }
    finally { clearTimeout(timer); }
    await pauseGate(bot);
  };

  try {
    // Clear the site top-down (blocks that are in the way or in "must be air" cells).
    const clear = cells.filter((c) => { const b = bot.blockAt(at(c)); return b && !['air', 'cave_air', 'water', 'lava'].includes(b.name) && b.name !== c.block; })
      .sort((p, q) => q.y - p.y);
    // Protect other people's builds. Blocks from our own earlier attempt here are fine (same design).
    const designBlocks = new Set(cells.map((c) => c.block));
    const theirs = clear.map((c) => bot.blockAt(at(c))).filter((b: any) => b && playerMade(b.name) && !designBlocks.has(b.name));
    if (theirs.length) return `ERROR: the spot at ${origin.x},${origin.y},${origin.z} has someone's build in the way (${[...new Set(theirs.map((b: any) => b.name))].slice(0, 3).join(', ')}). Build somewhere else (leave out x/y/z to pick a free spot).`;
    if (clear.length) console.log(`[build] clearing ${clear.length} blocks`);
    const tPhase = Date.now();
    for (const c of clear) {
      const p = at(c), b = bot.blockAt(p);
      if (!b || b.name === 'air') continue;
      if (bot.entity.position.offset(0, 1.6, 0).distanceTo(p.offset(0.5, 0.5, 0.5)) > 4.2) { moves.canDig = true; await go(new goals.GoalNear(p.x, p.y, p.z, 3)); moves.canDig = false; }
      try { await bot.tool?.equipForBlock?.(b); await cancellable(bot, signal, bot.dig(b)); } catch (e: any) { if (signal.aborted) throw e; }
    }

    prof['phase:clear'] = { ms: Date.now() - tPhase, n: 1 };
    const tPlace = Date.now();
    // Placement order: by height; at each height, solid structure before decorations.
    const solids = cells.filter((c) => c.block !== 'air');
    // Doors go in last, from outside, after the bot has walked out (pathfinding can't open doors).
    const doors = solids.filter((c) => c.block.endsWith('_door'));
    const pending = solids.filter((c) => !c.block.endsWith('_door') && bot.blockAt(at(c))?.name !== c.block);
    const tries = new Map<Cell, number>();
    const NB = [new Vec3(0, -1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1), new Vec3(0, 1, 0)];
    let placed = 0;
    const hotbarUsed: number[] = [];
    while (pending.length) {
      if (signal.aborted) throw new Error('aborted');
      await pauseGate(bot);
      const e0 = epoch(bot);
      const pos = bot.entity.position;
      const ready = pending.filter((c) => NB.some((n) => canBuildOn(bot.blockAt(at(c).plus(n)))));
      if (!ready.length) {
        const c0 = pending[0], p0 = at(c0);
        console.log(`[build] nothing left to place against: ${pending.length} blocks waiting, e.g. ${c0.block} at ${p0} (below: ${bot.blockAt(p0.offset(0, -1, 0))?.name ?? 'not loaded'}, me ${bot.entity.position.floored()})`);
        break;
      }
      // Speed: place everything in reach before walking anywhere. Within reach: lowest first,
      // structure before decoration, and the block already in hand before switching items.
      const eye = pos.offset(0, 1.6, 0), held = bot.heldItem?.name;
      const inReach = (c: Cell) => eye.distanceTo(at(c).offset(0.5, 0.5, 0.5)) <= 4.3;
      const order = (p: Cell, q: Cell) => p.y - q.y || Number(DECOR.test(p.block)) - Number(DECOR.test(q.block))
        || Number(q.block === held) - Number(p.block === held) || at(p).distanceTo(pos) - at(q).distanceTo(pos);
      const near = ready.filter(inReach).sort(order);
      let c: Cell;
      if (near.length) c = near[0];
      else {
        // Nothing in reach: walk toward the lowest unfinished layer, picking the block that has the
        // most other ready blocks around it, so one walk unlocks a whole batch.
        const low = Math.min(...ready.map((r) => r.y));
        const layer = ready.filter((r) => r.y <= low + 1);
        const crowd = (r: Cell) => layer.filter((o) => at(o).distanceTo(at(r)) <= 4).length;
        c = layer.sort((p, q) => crowd(q) - crowd(p) || at(p).distanceTo(pos) - at(q).distanceTo(pos))[0];
      }
      const p = at(c);
      pending.splice(pending.indexOf(c), 1);

      const feet = bot.entity.position.floored();
      // Our body is where the block goes? Creative: float up above that spot. Walking: step aside.
      const bp = bot.entity.position, overlap = Math.abs(bp.x - (p.x + 0.5)) < 0.8 && Math.abs(bp.z - (p.z + 0.5)) < 0.8 && bp.y > p.y - 1.8 && bp.y < p.y + 1;
      if (overlap || feet.equals(p) || feet.offset(0, 1, 0).equals(p)) await go(new goals.GoalInvert(new goals.GoalNear(p.x, p.y, p.z, 1.5)));
      else if (bot.entity.position.offset(0, 1.6, 0).distanceTo(p.offset(0.5, 0.5, 0.5)) > 4.3) await go(new goals.GoalNear(p.x, p.y, p.z, 3));

      let item = findItem(bot, c.block);
      if ((!item || item.name !== c.block) && bot.game.gameMode === 'creative') {
        // Creative: put exactly this block in hand right before placing (the hotbar is too small to pre-stock).
        const { default: PItem } = await import('prismarine-item');
        const info = bot.registry.itemsByName[c.block];
        if (info) {
          const slots = bot.inventory.slots;
          const hit = [...Array(9).keys()].find((i) => slots[36 + i]?.name === c.block);
          if (hit !== undefined) bot.setQuickBarSlot(hit);
          else {
            const lru = [...Array(9).keys()].sort((a, b) => (hotbarUsed[a] ?? 0) - (hotbarUsed[b] ?? 0))[0];
            bot.setQuickBarSlot(lru);
            await timed('creative-give', async () => { await bot.creative.setInventorySlot(36 + lru, new ((PItem as any)(bot.registry))(info.id, Math.min(64, info.stackSize ?? 64))); await sleep(50); });
          }
          hotbarUsed[bot.quickBarSlot] = Date.now();
          item = findItem(bot, c.block);
        }
      }
      if (!item || item.name !== c.block) { console.log(`[build] out of ${c.block}`); continue; }
      // Prefer the block below (logs stand upright, doors and slabs sit right), then any solid side.
      const ref = NB.map((n) => ({ n, b: bot.blockAt(p.plus(n)) })).find((r) => canBuildOn(r.b));
      if (!ref) { pending.push(c); continue; }
      try {
        if (bot.heldItem?.name !== c.block) await timed('equip', () => bot.equip(item, 'hand'));
        if (c.facing) await timed('place-facing', () => placeFacing(bot, ref, c, p));
        else await timed('place', () => bot._placeBlockWithOptions(ref.b, ref.n.scaled(-1), { half: c.half, swingArm: 'right', forceLook: true }));
        if (bot.blockAt(p)?.name === c.block || bot.blockAt(p)?.name?.startsWith(c.block.replace(/^(.*)_(torch)$/, '$1_wall_torch'))) { placed++; if (process.env.CRAFTIE_DEBUG && c.block.endsWith('_stairs')) console.log(`[build] placed ${c.block} at ${p} ${JSON.stringify(bot.blockAt(p)?.getProperties?.())}`); }
        else if (!c.block.endsWith('torch')) { if (process.env.CRAFTIE_DEBUG) console.log(`[build] ${c.block} at ${p} didn't appear (now ${bot.blockAt(p)?.name})`); if ((tries.get(c) ?? 0) < 2) { tries.set(c, (tries.get(c) ?? 0) + 1); pending.push(c); } }
        else placed++;
      } catch (e: any) {
        if (signal.aborted) throw e;
        if (process.env.CRAFTIE_DEBUG) console.log(`[build] place ${c.block}${c.facing ? '/' + c.facing : ''} at ${p} failed: ${e.message} (ref ${ref.b.name} ${ref.n}, dist ${bot.entity.position.offset(0, 1.6, 0).distanceTo(p.offset(0.5, 0.5, 0.5)).toFixed(1)})`);
        if (bot.blockAt(p)?.name === c.block) placed++;
        else if (epoch(bot) !== e0) pending.push(c); // interrupted by a fight: doesn't count as a failed try
        else if ((tries.get(c) ?? 0) < 2) { tries.set(c, (tries.get(c) ?? 0) + 1); pending.push(c); }
      }
    }

    // Remove the scaffolding we put up, then walk out the front.
    prof['phase:place'] = { ms: Date.now() - tPlace, n: 1 };
    const tClean = Date.now();
    bot.removeListener('blockUpdate', onUpdate);
    // Remove scaffolding top-down. canDig stays OFF so walking there never breaks the build;
    // the bot only ever digs the scaffold block itself. Unreachable ones are left.
    let removed = 0;
    // Break everything within reach from where we stand (top-down so nothing floats), then walk
    // to the nearest remaining scaffold and repeat. Pillars cluster, so this saves most walks.
    const isScaffold = (v: Vec3) => { const b = bot.blockAt(v); return !!b && SCAFFOLD.includes(b.name) && wanted.get(key(v)) !== b.name; };
    let scafLeft = [...scaffolds.values()].filter(isScaffold);
    for (let walks = 0; scafLeft.length && walks < 60; walks++) {
      const eye = () => bot.entity.position.offset(0, 1.6, 0);
      const reach = scafLeft.filter((v) => eye().distanceTo(v.offset(0.5, 0.5, 0.5)) <= 4.5).sort((a, b) => b.y - a.y);
      for (const v of reach) {
        if (signal.aborted) throw new Error('aborted');
        const b = bot.blockAt(v);
        if (!b || !isScaffold(v)) continue;
        try { await bot.tool?.equipForBlock?.(b); await cancellable(bot, signal, bot.dig(b, true)); removed++; } catch {}
      }
      scafLeft = scafLeft.filter(isScaffold);
      if (!scafLeft.length) break;
      const me = bot.entity.position;
      const next = scafLeft.sort((a, b) => a.distanceTo(me) - b.distanceTo(me))[0];
      const before = scafLeft.length;
      await go(new goals.GoalNear(next.x, next.y, next.z, 3));
      if (eye().distanceTo(next.offset(0.5, 0.5, 0.5)) > 4.8 && before === scafLeft.length) scafLeft = scafLeft.filter((v) => v !== next); // can't reach that one: leave it
    }
    // Anything we dug out from under the design (e.g. a scaffold standing in a wall spot) gets refilled.
    for (const c of cells) {
      if (c.block === 'air' || c.block.endsWith('_door') || bot.blockAt(at(c))?.name === c.block) continue;
      const p = at(c);
      const ref = NB.map((n) => ({ n, b: bot.blockAt(p.plus(n)) })).find((r) => canBuildOn(r.b));
      let item = findItem(bot, c.block);
      if (!ref || !item) continue;
      try {
        if (bot.entity.position.offset(0, 1.6, 0).distanceTo(p.offset(0.5, 0.5, 0.5)) > 4.3) await go(new goals.GoalNear(p.x, p.y, p.z, 3));
        await bot.equip(item, 'hand');
        if (c.facing) await placeFacing(bot, ref, c, p);
        else await bot._placeBlockWithOptions(ref.b, ref.n.scaled(-1), { half: c.half, swingArm: 'right' });
      } catch {}
    }
    prof['phase:cleanup+refill'] = { ms: Date.now() - tClean, n: 1 };
    if (bot.game.gameMode === 'creative') { try { bot.creative.stopFlying(); } catch {} }
    // Stand outside each door: the player places a door looking in, so "outside" is behind its facing.
    const DIR: Record<string, [number, number]> = { east: [1, 0], west: [-1, 0], south: [0, 1], north: [0, -1] };
    const outside = (c: Cell, k: number) => { const [dx, dz] = DIR[c.facing ?? 'east']; return at(c).offset(-dx * k, 0, -dz * k); };
    if (process.env.CRAFTIE_DEBUG) console.log('[build] door phase starts, me', bot.entity.position.floored().toString(), 'origin', origin.toString());
    if (doors.length) { const o = outside(doors[0], 3); await go(new goals.GoalNearXZ(o.x, o.z, 1), 40_000); }
    for (const c of doors) {
      const p = at(c);
      if (bot.blockAt(p)?.name === c.block) continue;
      let item = findItem(bot, c.block);
      if (!item && bot.game.gameMode === 'creative') {
        const { default: PItem } = await import('prismarine-item');
        const info = bot.registry.itemsByName[c.block];
        if (info) { await bot.creative.setInventorySlot(36 + bot.quickBarSlot, new ((PItem as any)(bot.registry))(info.id, 1)); await sleep(50); item = findItem(bot, c.block); }
      }
      const below = bot.blockAt(p.offset(0, -1, 0));
      if (!item || !canBuildOn(below)) continue;
      try {
        if (bot.entity.position.offset(0, 1.6, 0).distanceTo(p.offset(0.5, 0.5, 0.5)) > 4.3) {
          // Outside the door, at whatever height the ground is; failing that, anywhere within reach.
          const reach = () => bot.entity.position.offset(0, 1.6, 0).distanceTo(p.offset(0.5, 0.5, 0.5)) <= 4.3;
          const o = outside(c, 2); await go(new goals.GoalNearXZ(o.x, o.z, 1));
          if (!reach()) await go(new goals.GoalNear(p.x, p.y, p.z, 3));
        }
        await bot.equip(item, 'hand');
        if (process.env.CRAFTIE_DEBUG) console.log(`[build] door at ${p} facing ${c.facing}; me ${bot.entity.position.floored()} below=${below?.name} here=${bot.blockAt(p)?.name} above=${bot.blockAt(p.offset(0, 1, 0))?.name}`);
        await placeFacing(bot, { n: new Vec3(0, -1, 0), b: below }, c, p);
        placed++;
      } catch (e: any) { if (process.env.CRAFTIE_DEBUG) console.log('[build] door failed:', e.message); }
    }
    await sleep(200);
    if (process.env.CRAFTIE_DEBUG) console.log('[build] time spent:', Object.entries(prof).map(([k, v]) => `${k} ${(v.ms / 1000).toFixed(0)}s/${v.n}`).join(', '));
    if (process.env.CRAFTIE_DEBUG) {
      const st = cells.filter((c) => c.block.endsWith('_stairs'));
      console.log(`[build] stairs standing at the end: ${st.filter((c) => bot.blockAt(at(c))?.name === c.block).length}/${st.length}; e.g. ${st.slice(0, 3).map((c) => `${at(c)}=${bot.blockAt(at(c))?.name}`).join(' ')}`);
    }
    const left = pending.length;
    return `built ${a.schematic ? `schematic "${a.schematic}"` : a.blueprint ?? 'house'} at ${origin.x},${origin.y},${origin.z}: ${placed} blocks placed${left ? `, ${left} couldn't be placed` : ''}${removed ? `, ${removed} scaffold blocks removed` : ''}`;
  } finally {
    bot.removeListener('blockUpdate', onUpdate);
    bot.pathfinder.setMovements(oldMoves);
  }
}
