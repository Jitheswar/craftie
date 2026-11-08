// The two "do the whole job" skills. Kept apart from skills.ts so the planner and
// builder can use the basic skills without a circular import.
import { build } from './builder.ts';
import { newPlan, obtain } from './planner.ts';
import { Vec3 } from 'vec3';
import { chests, count, gotoPos, homeOf, invLock, inventorySummaryShort, rememberChest, reserved, skills } from './skills.ts';

skills.obtain = {
  doc: 'obtain {item, count} - get ANY item by doing the whole chain automatically: finds trees/ores, makes the right tools, crafts, smelts. Use this instead of many collect/craft steps',
  async run(bot, a, signal) {
    const plan = newPlan(signal, a.nearby ? 32 : undefined);
    try { await obtain(bot, a.item, (a.count ?? 1), plan); }
    catch (e: any) { if (signal.aborted) throw e; return `ERROR: couldn't get ${a.item}: ${e.message}. have ${count(bot, a.item)}`; }
    if (/_(helmet|chestplate|leggings|boots)$/.test(a.item)) await bot.armorManager?.equipAll?.().catch?.(() => {}); // wear it
    return `have ${count(bot, a.item)} ${a.item} (${plan.log.length} steps). inventory: ${inventorySummaryShort(bot)}`;
  },
};

skills.build = {
  doc: 'build {blueprint, width?, depth?, height?, walls?, pillars?, base?, roof?, windows?, furnish?, lights?} - build a quality structure and gather ALL materials automatically. ' +
    'blueprint: house (cottage: stone base, log pillars, plank walls, glass windows, pitched stair roof, door, torches, crafting table/furnace/chest) | hut (small) | tower | wall | platform | custom. ' +
    'Palette values are block ids or "planks"/"log"/"stairs" (= local wood). ' +
    'custom: {layers: [[row strings per z] per y, bottom first], legend: {char: "block_id" or "oak_stairs[facing=east,half=bottom]"}}, "_" = keep clear, "." = ignore',
  async run(bot, a, signal) { return build(bot, a, signal); },
};

// What Craftie always carries; everything else goes into its home chest.
const KEEP_ALWAYS = /_(sword|pickaxe|axe|shovel|helmet|chestplate|leggings|boots|bed)$|^(shield|bow|crossbow|arrow|crafting_table)$/;
const KEEP_SOME: Record<string, number> = { torch: 32, cobblestone: 32 }; // handy amounts for the road
const FOOD = /^(cooked_|bread$|baked_potato$|golden_carrot$|apple$)/;

skills.tidy = {
  doc: 'tidy {} - store everything I don\'t need to carry in my home chest (keeps tools, weapon, armor, bed, some food/torches, and your items)',
  async run(bot, _a, signal) {
    if (bot.game.gameMode === 'creative') return 'nothing to tidy in creative';
    const home = homeOf(bot) ?? bot.entity.position.floored();
    // Prefer a chest we know near home; else place one there.
    let best = [...chests(bot).values()].filter((c) => home.distanceTo(new Vec3(c.x, c.y, c.z)) < 10)
      .sort((a, b) => Object.keys(a.items).length - Object.keys(b.items).length)[0];
    let block = best && bot.blockAt(new Vec3(best.x, best.y, best.z));
    if (!block || !/chest|barrel/.test(block.name)) {
      await gotoPos(bot, signal, home, 3);
      block = bot.findBlock({ matching: (b: any) => /^(chest|barrel)$/.test(b.name), maxDistance: 8 });
      if (!block) {
        const plan = newPlan(signal);
        try { await obtain(bot, 'chest', 1, plan); } catch (e: any) { if (signal.aborted) throw e; return `couldn't make a chest: ${e.message}`; }
        await skills.place.run(bot, { item: 'chest' }, signal);
        block = bot.findBlock({ matching: (b: any) => b.name === 'chest', maxDistance: 6 });
        if (!block) return 'couldn\'t place a chest';
      }
    }
    await gotoPos(bot, signal, block.position, 2);
    let stored = 0;
    await invLock(bot, async () => {
      const w = await bot.openContainer(block);
      try {
        const res = reserved(bot);
        let food = 0;
        for (const it of bot.inventory.items()) {
          if (KEEP_ALWAYS.test(it.name) || res.has(it.name)) continue;
          if (FOOD.test(it.name)) { if (food + it.count <= 16) { food += it.count; continue; } }
          const keep = KEEP_SOME[it.name] ?? 0;
          const extra = count(bot, it.name) - keep;
          if (extra <= 0) continue;
          const n = Math.min(extra, it.count);
          try { await w.deposit(it.type, null, n); stored += n; } catch { break; } // chest full
        }
        rememberChest(bot, block, w);
      } finally { w.close(); }
    });
    const free = bot.inventory.emptySlotCount?.() ?? 0;
    return `stored ${stored} items in my chest at ${block.position.x},${block.position.y},${block.position.z}; ${free} free slots now`;
  },
};
