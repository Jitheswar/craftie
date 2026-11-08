// What Craftie should do for itself when the player hasn't given it a job: a fixed
// priority list (plain code, no AI). The first unmet need becomes the next chore.
import { count } from './skills.ts';

export type Chore = { item: string; count: number; why: string };

const TIERS = ['netherite', 'diamond', 'iron', 'stone', 'wooden'];
const FOODS = ['cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken', 'cooked_rabbit', 'bread', 'baked_potato', 'golden_carrot'];
const has = (bot: any, item: string) => count(bot, item) > 0 || Object.values(bot.inventory.slots).some((s: any) => s?.name === item);
const bestTier = (bot: any, tool: string) => TIERS.findIndex((t) => has(bot, `${t}_${tool}`)); // -1 = none

export function nextChore(bot: any, skip: Set<string>): Chore | null {
  if (bot.game.gameMode === 'creative' || bot.game.gameMode === 'spectator') return null;
  const ironOk = count(bot, 'iron_ingot') + count(bot, 'raw_iron') >= 3 || bestTier(bot, 'pickaxe') !== -1 && bestTier(bot, 'pickaxe') <= 3;
  const list: Chore[] = [];
  if ((bot.inventory.emptySlotCount?.() ?? 36) <= 5) list.push({ item: '__tidy', count: 0, why: 'room in my bag (storing extras in my chest)' });
  const food = FOODS.reduce((s, f) => s + count(bot, f), 0);
  // Any meat will do: if there are no cows, the next one is tried.
  if (food < 8) for (const f of ['cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken']) list.push({ item: f, count: count(bot, f) + (8 - food), why: 'food' });

  const pick = bestTier(bot, 'pickaxe'), sword = bestTier(bot, 'sword'), axe = bestTier(bot, 'axe');
  if (pick === -1) list.push({ item: 'wooden_pickaxe', count: 1, why: 'a pickaxe' });
  if (pick === -1 || pick > 3) list.push({ item: 'stone_pickaxe', count: 1, why: 'a stone pickaxe' });
  if (sword === -1 || sword > 3) list.push({ item: 'stone_sword', count: 1, why: 'a weapon' });
  if (axe === -1 || axe > 3) list.push({ item: 'stone_axe', count: 1, why: 'an axe' });
  if (!Object.values(bot.inventory.slots).some((s: any) => s?.name?.endsWith('_bed')))
    list.push({ item: 'white_bed', count: 1, why: 'a bed, so I can sleep next to you' });
  if (count(bot, 'torch') < 16) list.push({ item: 'torch', count: 16, why: 'torches' });

  // Iron gear once the basics are done: pickaxe, sword, then armor.
  if (ironOk) {
    if (pick > 2) list.push({ item: 'iron_pickaxe', count: 1, why: 'an iron pickaxe' });
    if (sword > 2) list.push({ item: 'iron_sword', count: 1, why: 'an iron sword' });
    for (const piece of ['chestplate', 'leggings', 'helmet', 'boots'])
      if (!has(bot, `iron_${piece}`) && !has(bot, `diamond_${piece}`)) list.push({ item: `iron_${piece}`, count: 1, why: `iron ${piece}` });
  }
  // Building stock for your projects.
  if (count(bot, 'cobblestone') < 64) list.push({ item: 'cobblestone', count: 64, why: 'stone to build with' });
  return list.find((c) => !skip.has(c.item)) ?? null;
}
