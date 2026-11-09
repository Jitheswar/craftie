// obtain(item, count): get any item by working out the whole chain itself.
// Mine it, smelt it, or craft it from ingredients (recursively), and get the
// right pickaxe first when a block needs one. Everything already in the
// inventory is used before gathering more. No AI calls: this is plain code.
import { cancellable, chests, count, epoch, findOrPlace, gotoPos, invLock, pauseGate, rememberChest, skills, sleep } from './skills.ts';
import pf from 'mineflayer-pathfinder';
const { goals } = pf as any;

// Items that come from mining a different block (item <- blocks that drop it).
const DROPS: Record<string, string[]> = {
  cobblestone: ['stone', 'cobblestone'], cobbled_deepslate: ['deepslate', 'cobbled_deepslate'],
  coal: ['coal_ore', 'deepslate_coal_ore'], // charcoal is the fallback via the torch recipe that uses it raw_iron: ['iron_ore', 'deepslate_iron_ore'],
  raw_copper: ['copper_ore', 'deepslate_copper_ore'], raw_gold: ['gold_ore', 'deepslate_gold_ore'],
  diamond: ['diamond_ore', 'deepslate_diamond_ore'], emerald: ['emerald_ore', 'deepslate_emerald_ore'],
  redstone: ['redstone_ore', 'deepslate_redstone_ore'], lapis_lazuli: ['lapis_ore', 'deepslate_lapis_ore'],
  dirt: ['dirt', 'grass_block'], clay_ball: ['clay'], flint: ['gravel'], snowball: ['snow_block', 'snow'],
  wheat_seeds: ['short_grass', 'tall_grass'], string: ['cobweb'],
};

// Items that come from animals/mobs (item <- creatures that drop it). Got by hunting.
const MOB_DROPS: Record<string, string[]> = {
  white_wool: ['sheep'], mutton: ['sheep'], beef: ['cow'], leather: ['cow'], porkchop: ['pig'],
  chicken: ['chicken'], feather: ['chicken'], rabbit: ['rabbit'], rabbit_hide: ['rabbit'],
  string: ['spider'], spider_eye: ['spider'], bone: ['skeleton'], arrow: ['skeleton'], gunpowder: ['creeper'], rotten_flesh: ['zombie'],
};

// Items that come out of a furnace (output <- input).
const SMELT: Record<string, string> = {
  iron_ingot: 'raw_iron', gold_ingot: 'raw_gold', copper_ingot: 'raw_copper', glass: 'sand', stone: 'cobblestone',
  smooth_stone: 'stone', brick: 'clay_ball', charcoal: 'oak_log', terracotta: 'clay', cooked_beef: 'beef',
  cooked_porkchop: 'porkchop', cooked_chicken: 'chicken', cooked_mutton: 'mutton', baked_potato: 'potato', cooked_rabbit: 'rabbit',
};

const PICKAXES = ['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe'];

/** radius: only look this far and never explore (chores near the player). */
export type Plan = { log: string[]; signal: AbortSignal; depth: number; stack: Set<string>; radius?: number };

const say = (p: Plan, s: string) => { p.log.push(s); console.log('[plan]', s); };

/** Which log type to use for "any wood" recipes: one we have, else the nearest tree. */
function preferredWood(bot: any): string {
  const have = bot.inventory.items().find((i: any) => i.name.endsWith('_log') || i.name.endsWith('_planks'));
  if (have) return have.name.replace(/_(log|planks)$/, '');
  const ids = Object.values(bot.registry.blocksByName as Record<string, any>).filter((b) => b.name.endsWith('_log') && !b.name.startsWith('stripped')).map((b) => b.id);
  const near = bot.findBlock({ matching: ids, maxDistance: 64 });
  return near ? near.name.replace(/_log$/, '') : 'oak';
}

/** Lowest pickaxe that can harvest this block, or null if any tool (or a hand) works. */
function pickaxeFor(bot: any, blockName: string): string | null {
  const b = bot.registry.blocksByName[blockName];
  if (!b?.harvestTools) return null;
  const ok = new Set(Object.keys(b.harvestTools).map(Number));
  return PICKAXES.find((p) => ok.has(bot.registry.itemsByName[p]?.id)) ?? null;
}

function hasToolFor(bot: any, blockName: string): boolean {
  const b = bot.registry.blocksByName[blockName];
  if (!b?.harvestTools) return true;
  const ok = new Set(Object.keys(b.harvestTools).map(Number));
  return bot.inventory.items().some((i: any) => ok.has(i.type));
}

/** Rough cost of getting an ingredient: 0 if we have it, low if it's nearby, high otherwise. */
function cost(bot: any, name: string, need: number): number {
  const have = count(bot, name);
  if (have >= need) return 0;
  // Wood products are only cheap if their tree grows nearby.
  const wood = name.match(/^(.*)_(planks|stairs|slab|fence|door)$/);
  if (wood && bot.registry.itemsByName[`${wood[1]}_log`]) return 1 + cost(bot, `${wood[1]}_log`, Math.ceil((need - have) / 4));
  const src = DROPS[name] ?? (bot.registry.blocksByName[name] ? [name] : null);
  if (src) {
    const ids = src.map((n) => bot.registry.blocksByName[n]?.id).filter((x) => x !== undefined);
    return bot.findBlock({ matching: ids, maxDistance: 48 }) ? need - have : 10 * (need - have);
  }
  return 3 * (need - have); // has to be crafted/smelted
}

/** Walk over dropped items of this kind nearby (e.g. logs that fell out of a tall tree). */
async function pickUpDrops(bot: any, item: string, signal: AbortSignal, max = 4) {
  const me = bot.entity.position;
  const drops = Object.values(bot.entities as Record<string, any>)
    .filter((e) => e.name === 'item' && e.position.distanceTo(me) < 12 && e.getDroppedItem?.()?.name === item)
    .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me)).slice(0, max);
  for (const d of drops) {
    const p = d.position;
    const go = bot.pathfinder.goto(new (await import('mineflayer-pathfinder')).default.goals.GoalNear(p.x, p.y, p.z, 0.5));
    await Promise.race([go, new Promise((r) => setTimeout(r, 8000))]).catch(() => {});
    if (signal.aborted) return;
  }
  bot.pathfinder.stop();
}

/**
 * Take what's needed from Craftie's chests (only what's needed) before gathering or crafting.
 * Uses its memory of chest contents; the memory is refreshed every time a chest is opened.
 */
async function fromChests(bot: any, item: string, need: number, p: Plan): Promise<void> {
  if (need <= 0) return;
  const target = count(bot, item) + need;
  const me = bot.entity.position;
  const options = [...chests(bot).values()].filter((c) => (c.items[item] ?? 0) > 0 && me.distanceTo({ x: c.x, y: c.y, z: c.z } as any) < 96)
    .sort((a, b) => me.distanceTo(a as any) - me.distanceTo(b as any));
  for (const c of options) {
    const left = target - count(bot, item);
    if (left <= 0) return;
    const block = bot.blockAt(new (bot.entity.position.constructor)(c.x, c.y, c.z));
    if (!block || !/chest|barrel/.test(block.name)) { chests(bot).delete(`${c.x},${c.y},${c.z}`); continue; }
    say(p, `taking ${Math.min(left, c.items[item])} ${item} from my chest at ${c.x},${c.y},${c.z}`);
    try {
      await gotoPos(bot, p.signal, block.position, 2);
      await invLock(bot, async () => {
        const w = await bot.openContainer(block);
        try {
          const have = w.containerItems().filter((i: any) => i.name === item).reduce((s: number, i: any) => s + i.count, 0);
          const it = w.containerItems().find((i: any) => i.name === item);
          if (it && have > 0) await w.withdraw(it.type, null, Math.min(left, have)); // only what's needed
          rememberChest(bot, block, w);
        } finally { w.close(); }
      });
    } catch (e: any) { if (p.signal.aborted) throw e; }
  }
}

// Low-value stuff that's fine to drop when the bag is full (keeping a little of each).
const JUNK: Record<string, number> = {
  dirt: 16, gravel: 0, sand: 16, rotten_flesh: 0, poisonous_potato: 0, spider_eye: 0, wheat_seeds: 0, beetroot_seeds: 0,
  andesite: 0, diorite: 0, granite: 0, tuff: 0, cobbled_deepslate: 32, netherrack: 16, flint: 0, bone: 4, string: 8, stick: 16,
};

/**
 * Make room in a full inventory before picking more up: store extras in the home chest if it
 * can, otherwise drop junk. Throws only if there's truly no room left.
 */
export async function makeRoom(bot: any, signal: AbortSignal, p?: Plan): Promise<void> {
  if ((bot.inventory.emptySlotCount?.() ?? 1) > 0 || bot.craftieMakingRoom) return;
  bot.craftieMakingRoom = true; // never re-enter (storing must not itself need bag space)
  try {
    if (p) say(p, 'my bag is full, making room');
    // 1. Drop junk first: instant, needs nothing.
    for (const [name, keep] of Object.entries(JUNK)) {
      const extra = count(bot, name) - keep;
      const it = bot.inventory.items().find((i: any) => i.name === name);
      if (it && extra > 0) { try { await bot.toss(it.type, null, Math.min(extra, it.count)); } catch {} }
    }
    if (bot.inventory.emptySlotCount() > 2) return;
    // 2. Store extras, but only in a chest that already exists nearby or that we're carrying
    //    (making a new chest would need bag space we don't have).
    const knownChest = bot.findBlock({ matching: (b: any) => b.name === 'chest' || b.name === 'barrel', maxDistance: 32 });
    if (knownChest || count(bot, 'chest') > 0) { try { await skills.tidy.run(bot, {}, signal); } catch (e: any) { if (signal.aborted) throw e; } }
    if (bot.inventory.emptySlotCount() > 0) return;
    throw new Error('my inventory is full and there was nothing safe to store or drop');
  } finally { bot.craftieMakingRoom = false; }
}

/** Hunt the nearest creature that drops this item until we have enough. */
async function hunt(bot: any, item: string, want: number, p: Plan): Promise<void> {
  const kinds = MOB_DROPS[item];
  let misses = 0;
  while (count(bot, item) < want) {
    if (p.signal.aborted) throw new Error('aborted');
    await pauseGate(bot);
    const me = bot.entity.position;
    const target = Object.values(bot.entities as Record<string, any>)
      .filter((e) => kinds.includes(e.name) && e.position.distanceTo(me) < (p.radius ?? 48))
      .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))[0];
    if (!target) {
      if (p.radius || ++misses > 3) throw new Error(`couldn't find any ${kinds.join('/')} nearby to get ${item}`);
      say(p, `no ${kinds[0]} nearby, looking around...`);
      await skills.explore.run(bot, { distance: 60 }, p.signal).catch((e: any) => { if (p.signal.aborted) throw e; });
      continue;
    }
    await makeRoom(bot, p.signal, p);
    say(p, `hunting ${target.name} for ${item} (${count(bot, item)}/${want})`);
    const before = count(bot, item);
    await skills.attack.run(bot, { target: target.name }, p.signal).catch((e: any) => { if (p.signal.aborted) throw e; });
    await pickUpDrops(bot, item, p.signal);
    if (count(bot, item) === before && ++misses > 6) throw new Error(`hunting isn't giving ${item}`);
  }
}

async function gather(bot: any, item: string, want: number, p: Plan): Promise<void> {
  const sources = DROPS[item] ?? [item];
  const ids = sources.map((n) => bot.registry.blocksByName[n]?.id).filter((x) => x !== undefined);
  if (!ids.length) throw new Error(`don't know where ${item} comes from`);
  const tool = pickaxeFor(bot, sources[0]);
  if (tool && !hasToolFor(bot, sources[0])) {
    say(p, `need a ${tool} to mine ${sources[0]}`);
    await obtain(bot, tool, 1, p);
  }
  let explores = 0, misses = 0;
  // Blocks we couldn't reach (e.g. logs high up a tree) are skipped for 5 minutes.
  const bad: Map<string, number> = (bot.craftieUnreachable ??= new Map());
  const keyOf = (v: any) => `${v.x},${v.y},${v.z}`;
  while (count(bot, item) < want) {
    if (p.signal.aborted) throw new Error('aborted');
    await pauseGate(bot);
    const me = bot.entity.position;
    const exposed = (pos: any) => [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]].some(([x, y, z]) => {
      const n = bot.blockAt(pos.offset(x, y, z)); return n && (n.name === 'air' || n.name === 'cave_air');
    });
    const now = Date.now();
    const theirs = (v: any) => bot.craftieOwnerBuilt?.has(`${v.x},${v.y},${v.z}`); // never take the player's own blocks
    const near = bot.findBlocks({ matching: ids, maxDistance: p.radius ?? 40, count: 300 }).filter((v: any) => (bad.get(keyOf(v)) ?? 0) < now && !theirs(v));
    // Nearest first; no climbing; and don't go deep: a cave wall 25 blocks down is where Craftie gets killed,
    // while stone a few blocks under the grass is a short safe dig. Blocks already touching air save a little digging.
    const score = (v: any) => v.distanceTo(me) + Math.max(0, v.y - me.y - 1) * 4 + Math.max(0, me.y - v.y - 4) * 3 - (exposed(v) ? 3 : 0);
    const target = [...near].sort((x: any, y: any) => score(x) - score(y))[0];
    if (!target || misses > 8) {
      if (p.radius) throw new Error(`couldn't find any reachable ${sources.join('/')} close by`);
      if (++explores > 4) throw new Error(`couldn't find any reachable ${sources.join('/')} nearby after exploring`);
      say(p, `no reachable ${sources[0]} nearby, exploring...`);
      misses = 0;
      await skills.explore.run(bot, { distance: 80 }, p.signal).catch((e: any) => { if (p.signal.aborted) throw e; });
      continue;
    }
    await makeRoom(bot, p.signal, p);
    const e0 = epoch(bot);
    try {
      const block = bot.blockAt(target);
      if (count(bot, item) % 8 === 0) say(p, `mining ${block?.name} for ${item} (${count(bot, item)}/${want})`);
      // Never wait forever on one block (e.g. a drop that can't be picked up).
      let timer: any;
      const limit = new Promise((_, rej) => { timer = setTimeout(() => { bot.collectBlock.cancelTask?.().catch?.(() => {}); bot.pathfinder.stop(); rej(new Error('took too long')); }, 45_000); });
      const before = count(bot, item);
      // Buried block: the mining helper needs to *see* it, which it can't until something is dug.
      // So dig down next to it first, like a player would, then mine it.
      if (!exposed(target)) {
        await cancellable(bot, p.signal, Promise.race([bot.pathfinder.goto(new goals.GoalNear(target.x, target.y + 1, target.z, 1)), limit])).catch((e: any) => { if (p.signal.aborted) throw e; });
      }
      try { await cancellable(bot, p.signal, Promise.race([bot.collectBlock.collect(bot.blockAt(target) ?? block, { ignoreNoPath: false }), limit])); }
      finally { clearTimeout(timer); }
      // Trees: fell the rest of the trunk from right here (no walking per log), then pick it all up at once.
      if (/_log$/.test(item) && count(bot, item) < want) {
        let felled = 0;
        for (let k = 0; k < 10 && count(bot, item) + felled < want; k++) {
          const next = bot.findBlocks({ matching: ids, maxDistance: 6, count: 30 }).map((v: any) => bot.blockAt(v))
            .filter((b: any) => b && !theirs(b.position) && bot.canDigBlock(b)).sort((a: any, b: any) => a.position.y - b.position.y)[0];
          if (!next) break;
          try { await bot.tool?.equipForBlock?.(next); await cancellable(bot, p.signal, bot.dig(next)); felled++; }
          catch (e: any) { if (p.signal.aborted) throw e; break; }
        }
        if (felled) { await sleep(400); await pickUpDrops(bot, item, p.signal, 12); }
      }
      if (count(bot, item) === before) await pickUpDrops(bot, item, p.signal);
    } catch (e: any) {
      if (p.signal.aborted) throw e;
      if (epoch(bot) !== e0) { await pauseGate(bot); continue; } // a fight interrupted us: just carry on
      bad.set(keyOf(target), now + 5 * 60_000);
      misses++;
      say(p, `skipping a ${sources[0]} I can't reach (${e.message})`);
    }
  }
}

export async function obtain(bot: any, item: string, want: number, p: Plan): Promise<void> {
  if (count(bot, item) >= want) return;
  if (p.signal.aborted) throw new Error('aborted');
  if (p.depth > 14 || p.stack.has(item)) throw new Error(`can't work out how to get ${item}`);
  const info = bot.registry.itemsByName[item];
  if (!info) throw new Error(`unknown item "${item}"`);

  if (bot.game.gameMode === 'creative') {
    say(p, `taking ${want - count(bot, item)} ${item} from creative inventory`);
    await skills.get_item.run(bot, { item, count: want }, p.signal);
    return;
  }

  p.stack.add(item); p.depth++;
  try {
    // Already stored somewhere? Take just what's needed instead of making more.
    if (item !== 'chest') { await fromChests(bot, item, want - count(bot, item), p); if (count(bot, item) >= want) return; }
    const need = want - count(bot, item);

    // 0. Hunt it (wool, leather, raw meat, string...).
    if (MOB_DROPS[item] && (!bot.recipesAll(info.id, null, true).length || item.endsWith('_wool'))) return await hunt(bot, item, want, p);

    // 1. Mine it directly (logs, dirt, ores, cobblestone...).
    if (DROPS[item] || (bot.registry.blocksByName[item] && !bot.recipesAll(info.id, null, true).length && !SMELT[item])) {
      return await gather(bot, item, want, p);
    }

    // 2. Smelt it.
    if (SMELT[item]) {
      let input = SMELT[item];
      if (item === 'charcoal') input = `${preferredWood(bot)}_log`;
      await obtain(bot, input, count(bot, input) + need, p);
      const fuel = count(bot, 'coal') || count(bot, 'charcoal') ? null : `${preferredWood(bot)}_planks`;
      if (fuel) await obtain(bot, fuel, Math.ceil(need / 1.5) + 1, p);
      if (!bot.findBlock({ matching: bot.registry.blocksByName.furnace.id, maxDistance: 32 })) await obtain(bot, 'furnace', 1, p);
      say(p, `smelting ${need} ${input} into ${item}`);
      const r = await skills.smelt.run(bot, { item: input, count: need, fuel: fuel ?? undefined }, p.signal);
      if (count(bot, item) < want) throw new Error(r);
      return;
    }

    // 3. Craft it. Pick the recipe that is cheapest with what we have and what's nearby.
    const recipes = bot.recipesAll(info.id, null, true);
    if (!recipes.length) {
      if (bot.registry.blocksByName[item]) return await gather(bot, item, want, p);
      throw new Error(`no way to get ${item} (it must be found, traded or looted)`);
    }
    const wood = preferredWood(bot);
    const scored = recipes.map((r: any) => {
      const times = Math.ceil(need / r.result.count);
      const ings = r.delta.filter((d: any) => d.count < 0).map((d: any) => ({ name: bot.registry.items[d.id].name, n: -d.count * times }));
      let c = ings.reduce((s: number, i: any) => s + cost(bot, i.name, i.n), 0);
      if (ings.some((i: any) => /_(log|planks)$/.test(i.name) && !i.name.startsWith(wood))) c += 50; // stick to one wood type
      return { r, times, ings, c };
    }).sort((a: any, b: any) => a.c - b.c);
    // Try recipes from cheapest to dearest. Only switch recipe when the ingredients
    // can't be found (e.g. coal out of reach -> charcoal torches), and only to recipes
    // whose ingredients are actually around; crafting glitches just retry below.
    let best = scored[0];
    const viable = scored.filter((x: any, i: number) => i === 0 || x.c < 10 * Math.max(1, need));
    for (let i = 0; i < viable.length; i++) {
      best = viable[i];
      try {
        for (const ing of best.ings) await obtain(bot, ing.name, ing.n, p);
        break;
      } catch (e: any) {
        const notFound = /couldn't find|no way to get|don't know where|can't work out/.test(e.message);
        if (p.signal.aborted || !notFound || i === viable.length - 1 || i >= 2) throw e;
        say(p, `${e.message}; trying another recipe for ${item}`);
      }
    }

    // Table first: making it uses planks we'd otherwise count as ingredients.
    if (best.r.requiresTable && !bot.findBlock({ matching: bot.registry.blocksByName.crafting_table.id, maxDistance: 32 }) && !count(bot, 'crafting_table'))
      await obtain(bot, 'crafting_table', 1, p);
    // Getting one ingredient can use up another (sticks eat planks), so top up until all are there at once.
    for (let round = 0; best.ings.some((i: any) => count(bot, i.name) < i.n); round++) {
      if (round > 4) throw new Error(`couldn't collect all ingredients for ${item}`);
      for (const ing of best.ings) await obtain(bot, ing.name, ing.n, p);
    }

    say(p, `crafting ${item} x${need}`);
    // One craft per call: the library is unreliable when told to repeat a craft many times.
    // On a failure, top up only what the remaining crafts need, then carry on.
    const perCraft = best.ings.map((i: any) => ({ name: i.name, n: i.n / best.times }));
    let failures = 0;
    while (count(bot, item) < want) {
      if (p.signal.aborted) throw new Error('aborted');
      await pauseGate(bot);
      const e0 = epoch(bot);
      const crafts = Math.ceil((want - count(bot, item)) / best.r.result.count);
      try {
        for (const ing of perCraft) if (count(bot, ing.name) < ing.n) throw new Error(`missing ${ing.name}`);
        let table = null;
        if (best.r.requiresTable) table = await findOrPlace(bot, p.signal, 'crafting_table');
        if (best.r.requiresTable && !table) throw new Error('no crafting table');
        const recipe = bot.recipesFor(info.id, null, 1, table)[0] ?? best.r;
        await invLock(bot, () => bot.craft(recipe, 1, table)); // never cut a craft off midway: it leaves items in the grid
      } catch (e: any) {
        if (p.signal.aborted) throw e;
        if (epoch(bot) === e0 && ++failures > 5) throw new Error(`crafting ${item} kept failing: ${e.message}`);
        await new Promise((r) => setTimeout(r, 300)); // let the inventory catch up with the server
        for (const ing of perCraft) await obtain(bot, ing.name, Math.ceil(ing.n * crafts), p);
      }
    }
  } finally {
    p.stack.delete(item); p.depth--;
  }
}

/**
 * How many logs it takes to make n of an item (planks, stairs, slabs, doors, sticks, chests...),
 * following real recipes. 0 for things that don't come from wood.
 */
export function logsFor(bot: any, item: string, n: number, depth = 0): number {
  if (n <= 0 || depth > 6) return 0;
  if (/_log$/.test(item)) return n;
  if (count(bot, item) >= n && depth > 0) return 0;
  const info = bot.registry.itemsByName[item];
  const r = info && bot.recipesAll(info.id, null, true)[0];
  if (!r) return 0;
  const crafts = Math.ceil((n - (depth > 0 ? count(bot, item) : 0)) / r.result.count);
  let logs = 0;
  for (const d of r.delta) if (d.count < 0) logs += logsFor(bot, bot.registry.items[d.id].name, -d.count * crafts, depth + 1);
  return logs;
}

export function newPlan(signal: AbortSignal, radius?: number): Plan { return { log: [], signal, depth: 0, stack: new Set(), radius }; }
