// High-level skills. The AI picks *what* to do; this code does the *how*
// (pathfinding, tool choice, recipes) at full game speed with no AI calls.
import pf from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { canUseCommands, describe, fmt, inventorySummary, nearbyBlocks } from './perception.ts';
export const inventorySummaryShort = (bot: any) => inventorySummary(bot).slice(0, 300);

const { goals } = pf as any;
type Skill = { doc: string; run: (bot: any, a: any, signal: AbortSignal) => Promise<string> };

// ---------- helpers ----------
export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((res, rej) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); rej(new Error('aborted')); }, { once: true });
  });

export async function cancellable<T>(bot: any, signal: AbortSignal, p: Promise<T>): Promise<T> {
  if (signal.aborted) throw new Error('aborted');
  const onAbort = () => { bot.pathfinder.stop(); bot.pvp?.stop(); bot.stopDigging?.(); };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([p, new Promise<T>((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted')), { once: true }))]);
  } finally { signal.removeEventListener('abort', onAbort); }
}

/**
 * Run inventory-window work (crafting, smelting, chests) without auto-eat moving
 * items mid-click, which desyncs the window and makes crafts time out.
 * Eats first if hungry, so it won't need to during the job.
 */
export async function invLock<T>(bot: any, fn: () => Promise<T>): Promise<T> {
  const ae = bot.autoEat;
  try { if (bot.food < 15 && ae && !ae.isEating) await ae.eat().catch(() => {}); } catch {}
  ae?.disableAuto?.();
  try { await clearCraftingGrid(bot); return await fn(); } finally { ae?.enableAuto?.(); }
}

/** Put back anything left in the 2x2 crafting grid or on the cursor (e.g. from a craft that got cut off). */
export async function clearCraftingGrid(bot: any) {
  try {
    const inv = bot.inventory;
    if (inv.selectedItem) {
      const empty = inv.firstEmptyInventorySlot?.();
      if (empty != null) await bot.clickWindow(empty, 0, 0);
    }
    for (let slot = 1; slot <= 4; slot++) if (inv.slots[slot]) await bot.clickWindow(slot, 0, 1); // shift-click back
  } catch {}
}

const TIER = ['netherite', 'diamond', 'iron', 'chainmail', 'stone', 'golden', 'leather', 'wooden'];
const tierOf = (name: string) => { const i = TIER.findIndex((t) => name.startsWith(t + '_')); return i < 0 ? 99 : i; };

/** The best weapon it has: sword of the best material, else the best axe. */
export function bestWeapon(bot: any) {
  const items = bot.inventory.items();
  const pick = (suffix: string) => items.filter((i: any) => i.name.endsWith(suffix)).sort((a: any, b: any) => tierOf(a.name) - tierOf(b.name))[0];
  return pick('_sword') ?? pick('_axe');
}

/** Wear the best armor, shield in the off-hand, best weapon in hand (call when not using a tool for a job). */
export async function equipBest(bot: any, weaponInHand = true) {
  try { await bot.armorManager?.equipAll?.(); } catch {}
  try {
    const shield = bot.inventory.items().find((i: any) => i.name === 'shield');
    if (shield && bot.inventory.slots[45]?.name !== 'shield') await bot.equip(shield, 'off-hand');
  } catch {}
  if (!weaponInHand) return;
  const w = bestWeapon(bot);
  if (w && bot.heldItem?.name !== w.name) { try { await bot.equip(w, 'hand'); } catch {} }
}

/**
 * Creative flight to a point, ~10 blocks/s, that can actually be cancelled: a newer flight cancels the
 * older one (the library's own flyTo can't be stopped, so two flights would fight over the position).
 * It moves in a straight line, so callers route up and over obstacles.
 */
export async function flyTo(bot: any, dest: Vec3, maxMs?: number): Promise<boolean> {
  const id = (bot.craftieFlightId = (bot.craftieFlightId ?? 0) + 1);
  bot.creative?.startFlying?.();
  const limit = Date.now() + (maxMs ?? (dest.distanceTo(bot.entity.position) / 10) * 1000 + 1500);
  while (bot.craftieFlightId === id && Date.now() < limit) {
    const v = dest.minus(bot.entity.position), d = v.norm();
    bot.physics.gravity = 0;
    bot.entity.velocity = new Vec3(0, 0, 0);
    if (d <= 0.5) { bot.entity.position = dest.clone(); return true; }
    bot.entity.position.add(v.scaled(0.5 / d));
    await sleep(50);
  }
  return false;
}
/** Highest solid block at a column (from a bit above `fromY` down), or null if unloaded. */
function surfaceY(bot: any, x: number, z: number, fromY: number): number | null {
  for (let y = Math.min(fromY + 40, 318); y > fromY - 60; y--) {
    const b = bot.blockAt(new Vec3(x, y, z));
    if (b === null) return null;
    if (b.boundingBox === 'block' || b.name.includes('leaves')) return y;
  }
  return fromY - 60;
}

/**
 * Fly somewhere without going through terrain: short hops go straight; longer trips rise above
 * the highest ground along the way, cross up there, and come down at the end.
 */
export async function flyRoute(bot: any, target: Vec3, minCruise = 0): Promise<boolean> {
  const pos = bot.entity.position;
  if (pos.distanceTo(target) < 6) return flyTo(bot, target);
  let top = Math.max(pos.y, target.y, minCruise);
  for (let i = 0; i <= 8; i++) { // sample the ground along the way
    const t = i / 8, sy = surfaceY(bot, Math.floor(pos.x + (target.x - pos.x) * t), Math.floor(pos.z + (target.z - pos.z) * t), Math.floor(Math.max(pos.y, target.y)));
    if (sy !== null) top = Math.max(top, sy);
  }
  const cruise = Math.min(top + 4, 318);
  if (pos.y < cruise - 0.5 && !(await flyTo(bot, new Vec3(pos.x, cruise, pos.z)))) return false;
  if (!(await flyTo(bot, new Vec3(target.x, cruise, target.z)))) return false;
  return flyTo(bot, target);
}

export const cancelFlight = (bot: any) => { bot.craftieFlightId = (bot.craftieFlightId ?? 0) + 1; };

/** Long jobs call this at safe points: if a fight is going on, wait for it to end. */
export async function pauseGate(bot: any) { while (bot.craftiePause) await bot.craftiePause; }
/** Changes every time a fight interrupts us; lets loops tell "interrupted" apart from "failed". */
export const epoch = (bot: any): number => bot.craftieEpoch ?? 0;

// ---------- memory: home spot and what's in each chest (saved per world by the body) ----------
export type ChestMemo = { x: number; y: number; z: number; items: Record<string, number> };
export const chests = (bot: any): Map<string, ChestMemo> => (bot.craftieChests ??= new Map());
export const homeOf = (bot: any): Vec3 | null => (bot.craftieHome ? new Vec3(bot.craftieHome.x, bot.craftieHome.y, bot.craftieHome.z) : null);
export function rememberChest(bot: any, block: any, window: any) {
  const items: Record<string, number> = {};
  for (const it of window.containerItems()) items[it.name] = (items[it.name] ?? 0) + it.count;
  const p = block.position;
  chests(bot).set(`${p.x},${p.y},${p.z}`, { x: p.x, y: p.y, z: p.z, items });
  bot.emit('craftieMemoryChanged');
}

/** Items held for the player (picked up after they died). Jobs must never use these. */
export const reserved = (bot: any): Map<string, number> => (bot.craftieReserved ??= new Map());
const physical = (bot: any, name: string) =>
  bot.inventory.items().filter((i: any) => i.name === name).reduce((s: number, i: any) => s + i.count, 0);
/** How many of an item Craftie may use (its own stock, not counting what it holds for the player). */
export const count = (bot: any, name: string) => Math.max(0, physical(bot, name) - (reserved(bot).get(name) ?? 0));

export const findItem = (bot: any, name: string) =>
  bot.inventory.items().find((i: any) => i.name === name) ??
  bot.inventory.items().find((i: any) => i.name.includes(name));

/** Accepts exact ids ("oak_log") and loose groups ("log", "wood", "stone", "iron"). */
export function blockIds(bot: any, name: string): number[] {
  const all = Object.values(bot.registry.blocksByName) as any[];
  const exact = bot.registry.blocksByName[name];
  if (exact) {
    const ids = [exact.id];
    if (name.endsWith('_ore')) { const deep = bot.registry.blocksByName['deepslate_' + name]; if (deep) ids.push(deep.id); }
    return ids;
  }
  const alias: Record<string, (n: string) => boolean> = {
    log: (n) => n.endsWith('_log') && !n.startsWith('stripped'), wood: (n) => n.endsWith('_log') && !n.startsWith('stripped'),
    stone: (n) => n === 'stone' || n === 'cobblestone', dirt: (n) => n === 'dirt' || n === 'grass_block',
    sand: (n) => n === 'sand', leaves: (n) => n.endsWith('_leaves'),
  };
  const match = alias[name] ?? ((n: string) => n.includes(name) && (n.endsWith('_ore') || !name.match(/iron|gold|diamond|coal|copper|emerald|lapis|redstone/)));
  return all.filter((b) => match(b.name)).map((b) => b.id);
}

export function entityByName(bot: any, target: string) {
  const me = bot.entity.position;
  const t = target.toLowerCase();
  return Object.values(bot.entities as Record<string, any>)
    .filter((e) => e !== bot.entity && (e.username?.toLowerCase() === t || e.name?.toLowerCase() === t || (t === 'hostile' && e.type === 'hostile')))
    .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))[0];
}

export async function gotoPos(bot: any, signal: AbortSignal, p: Vec3, range = 1) {
  await cancellable(bot, signal, bot.pathfinder.goto(new goals.GoalNear(p.x, p.y, p.z, range)));
}

export async function findOrPlace(bot: any, signal: AbortSignal, blockName: string) {
  const id = bot.registry.blocksByName[blockName].id;
  let block = bot.findBlock({ matching: id, maxDistance: 32 });
  if (!block && findItem(bot, blockName)) {
    await placeNear(bot, blockName);
    block = bot.findBlock({ matching: id, maxDistance: 6 });
  }
  if (!block) return null;
  await gotoPos(bot, signal, block.position, 2);
  return block;
}

export async function placeNear(bot: any, itemName: string, at?: Vec3) {
  const item = findItem(bot, itemName);
  if (!item) throw new Error(`no ${itemName} in inventory`);
  await bot.equip(item, 'hand');
  const faces = [new Vec3(0, 1, 0), new Vec3(0, -1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)];
  const targets: Vec3[] = at ? [at] : [];
  if (!at) {
    const base = bot.entity.position.floored();
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [2, 0], [0, 2]]) targets.push(base.offset(dx, 0, dz));
  }
  for (const t of targets) {
    const here = bot.blockAt(t);
    if (!here || !['air', 'cave_air', 'short_grass', 'grass', 'tall_grass', 'snow'].includes(here.name)) continue;
    for (const f of faces) {
      const ref = bot.blockAt(t.minus(f));
      if (ref && ref.boundingBox === 'block') {
        await bot.placeBlock(ref, f);
        return t;
      }
    }
  }
  throw new Error('no valid spot to place block');
}

// ---------- skills ----------
export const skills: Record<string, Skill> = {
  goto: {
    doc: 'goto {x,y,z, range?} OR {player} OR {block} - walk/swim/climb there (block = nearest of that type)',
    async run(bot, a, signal) {
      if (a.player) {
        const e = entityByName(bot, a.player);
        if (!e) return `can't see player ${a.player}`;
        await gotoPos(bot, signal, e.position, a.range ?? 2);
      } else if (a.block) {
        const b = bot.findBlock({ matching: blockIds(bot, a.block), maxDistance: 64 });
        if (!b) return `no ${a.block} within 64 blocks`;
        await gotoPos(bot, signal, b.position, a.range ?? 2);
      } else {
        await gotoPos(bot, signal, new Vec3(a.x, a.y, a.z), a.range ?? 1);
      }
      return `arrived at ${fmt(bot.entity.position)}`;
    },
  },

  follow: {
    doc: 'follow {player, distance?} - keep following (background, until stop)',
    async run(bot, a) {
      const e = entityByName(bot, a.player);
      if (!e) return `can't see ${a.player}`;
      bot.pathfinder.setGoal(new goals.GoalFollow(e, a.distance ?? 2), true);
      return `following ${a.player}`;
    },
  },

  collect: {
    doc: 'collect {block, count} - mine & pick up blocks, auto best tool. block can be exact ("oak_log","iron_ore") or group ("log","stone")',
    async run(bot, a, signal) {
      const want = a.count ?? 1;
      const ids = blockIds(bot, a.block);
      if (!ids.length) return `unknown block "${a.block}"`;
      let got = 0;
      while (got < want) {
        const positions = bot.findBlocks({ matching: ids, maxDistance: 64, count: Math.min(want - got, 16) });
        if (!positions.length) return `collected ${got}/${want}; no more ${a.block} within 64 blocks (try explore)`;
        const blocks = positions.map((p: Vec3) => bot.blockAt(p)).filter(Boolean);
        if (!blocks[0].canHarvest?.(bot.heldItem?.type) && !bot.inventory.items().some((i: any) => blocks[0].canHarvest?.(i.type)))
          return `collected ${got}/${want}; need a better tool to harvest ${blocks[0].name}`;
        await cancellable(bot, signal, bot.collectBlock.collect(blocks, { ignoreNoPath: true }));
        got += blocks.length;
      }
      return `collected ${got} ${a.block}. inventory: ${inventorySummary(bot)}`;
    },
  },

  craft: {
    doc: 'craft {item, count?} - crafts (uses/places crafting table automatically if needed)',
    async run(bot, a, signal) {
      const item = bot.registry.itemsByName[a.item];
      if (!item) return `unknown item "${a.item}"`;
      const n = a.count ?? 1;
      let recipe = bot.recipesFor(item.id, null, 1, null)[0];
      let table = null;
      if (!recipe) {
        const all = bot.recipesAll(item.id, null, true);
        if (all.length) {
          table = await findOrPlace(bot, signal, 'crafting_table');
          if (!table) return 'need a crafting table (craft one from 4 planks)';
          recipe = bot.recipesFor(item.id, null, 1, table)[0];
        }
      }
      if (!recipe) {
        const r = bot.recipesAll(item.id, null, true)[0];
        if (!r) return `${a.item} has no crafting recipe (maybe smelt it or find it)`;
        const need = new Map<string, number>();
        for (const d of r.delta) if (d.count < 0) need.set(bot.registry.items[d.id].name, -d.count);
        return `missing ingredients for ${a.item}. one craft needs: ${[...need].map(([k, v]) => `${k}x${v}`).join(', ')}. have: ${inventorySummary(bot)}`;
      }
      const times = Math.ceil(n / recipe.result.count);
      await invLock(bot, () => bot.craft(recipe, times, table)); // never cut a craft off midway
      return `crafted ${a.item}; now have ${count(bot, a.item)}`;
    },
  },

  smelt: {
    doc: 'smelt {item, count?, fuel?} - smelt in a furnace (finds/places one). item = input e.g. "raw_iron"',
    async run(bot, a, signal) {
      const furnaceBlock = await findOrPlace(bot, signal, 'furnace');
      if (!furnaceBlock) return 'need a furnace (craft from 8 cobblestone)';
      const input = findItem(bot, a.item);
      if (!input) return `no ${a.item} in inventory`;
      const n = Math.min(a.count ?? input.count, count(bot, input.name));
      const fuelName = a.fuel ?? ['coal', 'charcoal', 'coal_block'].find((f) => count(bot, f)) ??
        bot.inventory.items().find((i: any) => i.name.endsWith('_planks') || i.name.endsWith('_log'))?.name;
      if (!fuelName) return 'no fuel (coal, charcoal, planks or logs)';
      return invLock(bot, async () => {
      const furnace = await bot.openFurnace(furnaceBlock);
      try {
        const fuelPer = fuelName.includes('coal') ? 8 : 1.5;
        await furnace.putFuel(bot.registry.itemsByName[fuelName].id, null, Math.min(count(bot, fuelName), Math.ceil(n / fuelPer)));
        await furnace.putInput(input.type, null, n);
        let out = 0;
        const deadline = Date.now() + n * 11000 + 5000;
        while (out < n && Date.now() < deadline) {
          await sleep(2000, signal);
          if (furnace.outputItem()) out += (await furnace.takeOutput())?.count ?? 0;
        }
        return `smelted ${out}/${n} ${a.item}. inventory: ${inventorySummary(bot)}`;
      } finally { furnace.close(); }
      });
    },
  },

  place: {
    doc: 'place {item, x?,y?,z?} - place a block at coords (or next to me). For building, call repeatedly.',
    async run(bot, a, signal) {
      let at: Vec3 | undefined;
      if (a.x !== undefined) { at = new Vec3(a.x, a.y, a.z); if (bot.entity.position.distanceTo(at) > 4) await gotoPos(bot, signal, at, 3); }
      const p = await placeNear(bot, a.item, at);
      return `placed ${a.item} at ${fmt(p)}`;
    },
  },

  dig: {
    doc: 'dig {x,y,z} - break one specific block',
    async run(bot, a, signal) {
      const p = new Vec3(a.x, a.y, a.z);
      if (bot.entity.position.distanceTo(p) > 4) await gotoPos(bot, signal, p, 3);
      const b = bot.blockAt(p);
      if (!b || b.name === 'air') return 'nothing there';
      await bot.tool?.equipForBlock?.(b);
      if (b.harvestTools && !bot.heldItem?.type || (b.harvestTools && !b.harvestTools[bot.heldItem?.type])) return `need a better tool to mine ${b.name}`;
      await cancellable(bot, signal, bot.dig(b));
      // Walk over and pick up what dropped.
      await sleep(300);
      const drop = Object.values(bot.entities as Record<string, any>).filter((e) => e.name === 'item' && e.position.distanceTo(p) < 3)
        .sort((x, y) => x.position.distanceTo(p) - y.position.distanceTo(p))[0];
      if (drop) await Promise.race([bot.pathfinder.goto(new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 0.5)).catch(() => {}), sleep(5000)]);
      return `dug ${b.name}${drop ? ' and picked it up' : ''}`;
    },
  },

  equip: {
    doc: 'equip {item, slot?} - slot: hand|off-hand|head|torso|legs|feet',
    async run(bot, a) {
      const it = findItem(bot, a.item);
      if (!it) return `no ${a.item}`;
      await bot.equip(it, a.slot ?? 'hand');
      return `equipped ${it.name}`;
    },
  },

  attack: {
    doc: 'attack {target} - fight a mob/player by name ("zombie", a username, or "hostile" for nearest hostile) until it dies',
    async run(bot, a, signal) {
      const e = entityByName(bot, a.target);
      if (!e) return `no ${a.target} nearby`;
      await equipBest(bot); // best armor on, best weapon in hand
      bot.pvp.attack(e);
      const deadline = Date.now() + (a.chase ? 90000 : 30000); // players get chased longer
      while (bot.entities[e.id] && e.isValid !== false && Date.now() < deadline) await sleep(300, signal);
      bot.pvp.stop();
      return bot.entities[e.id] ? `${a.target} still alive after 30s` : `killed ${a.target}`;
    },
  },

  give: {
    doc: 'give {player, item, count?} - walk to player and toss items',
    async run(bot, a, signal) {
      const e = entityByName(bot, a.player);
      if (!e) return `can't see ${a.player}`;
      await gotoPos(bot, signal, e.position, 2);
      await bot.lookAt(e.position.offset(0, 1.6, 0));
      const it = findItem(bot, a.item);
      if (!it) return `no ${a.item}`;
      await bot.toss(it.type, null, Math.min(a.count ?? it.count, count(bot, it.name)));
      return `gave ${a.item} to ${a.player}`;
    },
  },

  store: {
    doc: 'store {item?, count?} - put items in nearest chest (no item = everything except tools/armor/food)',
    async run(bot, a, signal) {
      const chestBlock = await findOrPlace(bot, signal, 'chest');
      if (!chestBlock) return 'no chest nearby';
      const chest = await bot.openContainer(chestBlock);
      try {
        const keep = (n: string) => /_(sword|pickaxe|axe|shovel|hoe|helmet|chestplate|leggings|boots)$/.test(n) || bot.registry.foodsByName?.[n] || reserved(bot).has(n);
        const items = a.item ? bot.inventory.items().filter((i: any) => i.name === a.item) : bot.inventory.items().filter((i: any) => !keep(i.name));
        for (const it of items) await chest.deposit(it.type, null, a.item && a.count ? Math.min(a.count, it.count) : it.count);
        rememberChest(bot, chestBlock, chest);
        return `stored. inventory: ${inventorySummary(bot)}`;
      } finally { chest.close(); }
    },
  },

  take: {
    doc: 'take {item, count?} - take items from nearest chest',
    async run(bot, a, signal) {
      const id = bot.registry.blocksByName.chest.id;
      const b = bot.findBlock({ matching: id, maxDistance: 32 });
      if (!b) return 'no chest nearby';
      await gotoPos(bot, signal, b.position, 2);
      const chest = await bot.openContainer(b);
      try {
        const it = chest.containerItems().find((i: any) => i.name === a.item);
        if (!it) return `chest has no ${a.item}. it has: ${chest.containerItems().map((i: any) => `${i.name}x${i.count}`).join(', ')}`;
        await chest.withdraw(it.type, null, Math.min(a.count ?? it.count, it.count));
        rememberChest(bot, b, chest);
        return `took ${a.item}`;
      } finally { chest.close(); }
    },
  },

  eat: {
    doc: 'eat {} - eat best food now',
    async run(bot) {
      await bot.autoEat.eat();
      return `ate; food ${bot.food}/20`;
    },
  },

  sleep: {
    doc: 'sleep {} - find a nearby bed and sleep (night only)',
    async run(bot, _a, signal) {
      const bed = bot.findBlock({ matching: (b: any) => b.name.endsWith('_bed'), maxDistance: 32 });
      if (!bed) return 'no bed within 32 blocks';
      await gotoPos(bot, signal, bed.position, 2);
      await bot.sleep(bed);
      return 'sleeping';
    },
  },

  explore: {
    doc: 'explore {distance?, direction?} - travel to new area (direction: north|south|east|west|random)',
    async run(bot, a, signal) {
      const d = a.distance ?? 60;
      const dirs: Record<string, [number, number]> = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] };
      const ang = Math.random() * Math.PI * 2;
      const [dx, dz] = dirs[a.direction] ?? [Math.cos(ang), Math.sin(ang)];
      const p = bot.entity.position;
      // Give up after a minute: the far point may be unreachable (ocean, cliff).
      let timer: any;
      const limit = new Promise<void>((res) => { timer = setTimeout(() => { bot.pathfinder.stop(); res(); }, 60_000); });
      try { await cancellable(bot, signal, Promise.race([bot.pathfinder.goto(new goals.GoalNearXZ(p.x + dx * d, p.z + dz * d, 3)).catch(() => {}), limit])); }
      finally { clearTimeout(timer); }
      return `now at ${fmt(bot.entity.position)}. nearby blocks: ${nearbyBlocks(bot)}`;
    },
  },

  scan: {
    doc: 'scan {radius?} - detailed look at surroundings (up to radius 64)',
    async run(bot, a) { return `${describe(bot)}\nwide blocks: ${nearbyBlocks(bot, Math.min(a.radius ?? 64, 64))}`; },
  },

  command: {
    doc: 'command {text} - run a server/game command, e.g. "home", "tp 0 64 0", "gamemode creative" (only if allowed)',
    async run(bot, a) { bot.chat('/' + String(a.text).replace(/^\//, '')); await sleep(500); return `sent /${a.text}`; },
  },

  get_item: {
    doc: 'get_item {item, count?} - CREATIVE MODE ONLY (or when the player asks for /give and commands are allowed): instantly get any item',
    async run(bot, a) {
      const item = bot.registry.itemsByName[a.item];
      if (!item) return `unknown item "${a.item}"`;
      const n = Math.min(a.count ?? 1, item.stackSize ?? 64);
      if (bot.game.gameMode === 'creative') {
        const { default: PItem } = await import('prismarine-item');
        const Item = (PItem as any)(bot.registry);
        // Put it in the first empty hotbar slot (36-44), else replace the held slot.
        const slots = bot.inventory.slots;
        let slot = 36 + bot.quickBarSlot;
        for (let i = 36; i <= 44; i++) if (!slots[i]) { slot = i; break; }
        await bot.creative.setInventorySlot(slot, new Item(item.id, n));
        return `got ${n} ${a.item} (creative)`;
      }
      if (canUseCommands(bot)) {
        bot.chat(`/give ${bot.username} ${a.item} ${a.count ?? 1}`);
        await sleep(800);
        return `ran /give; now have ${count(bot, a.item)} ${a.item}`;
      }
      return `can't: I'm in ${bot.game.gameMode} without commands. Gather or craft ${a.item} instead`;
    },
  },

  collect_player_items: {
    doc: "collect_player_items {player, x,y,z} - fetch the items a player dropped when they died and keep them safe for them",
    async run(bot, a, signal) {
      const p = new Vec3(a.x, a.y, a.z);
      let timer: any;
      const limit = new Promise<void>((res) => { timer = setTimeout(() => { bot.pathfinder.stop(); res(); }, 150_000); });
      try { await cancellable(bot, signal, Promise.race([bot.pathfinder.goto(new goals.GoalNear(p.x, p.y, p.z, 2)).catch(() => {}), limit])); }
      finally { clearTimeout(timer); }
      if (bot.entity.position.distanceTo(p) > 12) return `couldn't reach where ${a.player} died (${fmt(p)})`;
      // A full bag would mean leaving your things on the ground: store extras first.
      if ((bot.inventory.emptySlotCount?.() ?? 1) < 4) { try { await skills.tidy?.run(bot, {}, signal); } catch {} }
      const snapshot = () => new Map(bot.inventory.items().map((i: any) => [i.name, physical(bot, i.name)]));
      const before = snapshot();
      for (let round = 0; round < 3; round++) {
        const drops = Object.values(bot.entities as Record<string, any>).filter((e) => e.name === 'item' && e.position.distanceTo(p) < 16)
          .sort((x, y) => x.position.distanceTo(bot.entity.position) - y.position.distanceTo(bot.entity.position));
        if (!drops.length) break;
        for (const d of drops) await Promise.race([bot.pathfinder.goto(new goals.GoalNear(d.position.x, d.position.y, d.position.z, 0.5)).catch(() => {}), sleep(6000, signal)]).catch(() => {});
      }
      bot.pathfinder.stop();
      // Everything that came in is the player's: set it aside.
      const r = reserved(bot); let total = 0;
      for (const [name, n] of snapshot()) { const gained = n - (before.get(name) ?? 0); if (gained > 0) { r.set(name, (r.get(name) ?? 0) + gained); total += gained; } }
      return total ? `holding ${total} of ${a.player}'s items for them: ${[...r].map(([k, v]) => `${k}x${v}`).join(', ')}` : `found none of ${a.player}'s items (despawned or picked up)`;
    },
  },

  return_items: {
    doc: "return_items {player} - hand back everything I'm holding for the player (their stuff from when they died)",
    async run(bot, a, signal) {
      const r = reserved(bot);
      if (!r.size) return 'I am not holding anything for you';
      const e = entityByName(bot, a.player);
      if (!e) return `can't see ${a.player}`;
      await gotoPos(bot, signal, e.position, 2);
      await bot.lookAt(e.position.offset(0, 1.6, 0));
      let given = 0;
      for (const [name, n] of [...r]) {
        const have = physical(bot, name), amount = Math.min(n, have);
        const it = bot.inventory.items().find((i: any) => i.name === name);
        if (it && amount > 0) { await bot.toss(it.type, null, amount).catch(() => {}); given += amount; }
        r.delete(name);
      }
      return `gave back ${given} items to ${a.player}`;
    },
  },

  sleep_near: {
    doc: 'sleep_near {x,y,z} - sleep in a free bed close to this spot (places my own bed there if needed). Sets my spawn there too',
    async run(bot, a, signal) {
      const at = new Vec3(a.x, a.y, a.z);
      const isFreeBed = (b: any) => b?.name?.endsWith('_bed') && !b.getProperties?.().occupied && b.position.distanceTo(at) > 0.5;
      let bed = bot.findBlock({ point: at, matching: (b: any) => isFreeBed(b), maxDistance: 12 });
      if (!bed) {
        const mine = bot.inventory.items().find((i: any) => i.name.endsWith('_bed'));
        if (!mine) return "no free bed near yours, and I don't have one. Place a bed next to yours for me (or give me one)";
        await gotoPos(bot, signal, at, 3);
        // A bed needs 2 free blocks side by side on solid ground next to the player's bed.
        for (const [dx, dz] of [[2, 0], [-2, 0], [0, 2], [0, -2], [2, 1], [-2, 1], [1, 2], [1, -2]]) {
          const spot = at.offset(dx, 0, dz), ground = bot.blockAt(spot.offset(0, -1, 0));
          const free = (v: any) => ['air', 'cave_air', 'short_grass', 'grass'].includes(bot.blockAt(v)?.name);
          if (!ground || ground.boundingBox !== 'block' || !free(spot) || !free(spot.offset(1, 0, 0))) continue;
          try {
            await bot.equip(mine, 'hand');
            await bot.lookAt(spot.offset(1.5, 0, 0.5)); // beds extend in the direction we face
            await bot.placeBlock(ground, new Vec3(0, 1, 0));
            bed = bot.blockAt(spot);
            if (bed?.name.endsWith('_bed')) break;
          } catch {}
        }
        if (!bed?.name.endsWith('_bed')) return "couldn't find room for my bed next to yours";
      }
      await gotoPos(bot, signal, bed.position, 2);
      try { await bot.sleep(bed); } catch (e: any) { return `couldn't sleep: ${e.message}`; }
      // Wait until morning (or until we're woken up).
      await Promise.race([new Promise((r) => bot.once('wake', r)), sleep(30000, signal).catch(() => {})]);
      return 'slept; my spawn point is now next to yours';
    },
  },

  recover: {
    doc: 'recover {x,y,z} - go back to where I died and pick up my dropped items (they vanish after 5 minutes)',
    async run(bot, a, signal) {
      const p = new Vec3(a.x, a.y, a.z);
      let timer: any;
      const limit = new Promise<void>((res) => { timer = setTimeout(() => { bot.pathfinder.stop(); res(); }, 150_000); });
      try { await cancellable(bot, signal, Promise.race([bot.pathfinder.goto(new goals.GoalNear(p.x, p.y, p.z, 2)).catch(() => {}), limit])); }
      finally { clearTimeout(timer); }
      if (bot.entity.position.distanceTo(p) > 12) return `couldn't get back to ${fmt(p)} (${bot.entity.position.distanceTo(p).toFixed(0)} blocks away)`;
      const before = bot.inventory.items().reduce((s: number, i: any) => s + i.count, 0);
      for (let round = 0; round < 3; round++) {
        const drops = Object.values(bot.entities as Record<string, any>).filter((e) => e.name === 'item' && e.position.distanceTo(p) < 10)
          .sort((x, y) => x.position.distanceTo(bot.entity.position) - y.position.distanceTo(bot.entity.position));
        if (!drops.length) break;
        for (const d of drops) {
          await Promise.race([bot.pathfinder.goto(new goals.GoalNear(d.position.x, d.position.y, d.position.z, 0.5)).catch(() => {}), sleep(6000, signal)]).catch(() => {});
        }
      }
      bot.pathfinder.stop();
      const got = bot.inventory.items().reduce((s: number, i: any) => s + i.count, 0) - before;
      return `picked up ${got} items where I died. inventory: ${inventorySummary(bot)}`;
    },
  },

  wait: {
    doc: 'wait {seconds}',
    async run(_bot, a, signal) { await sleep(Math.min(a.seconds ?? 1, 120) * 1000, signal); return 'waited'; },
  },
};
