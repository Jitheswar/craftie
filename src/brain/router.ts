// Optional fast path using Jev. Jev makes small judgments about a chat message;
// the tables in code below turn them into what the bot does. ALL question
// wording lives in this file so it's easy to review and tune.
//
// Without Jev, the brain falls back to simple word rules + the main AI.
import { type Answer, choice, Jev, noul } from '../llm/jev.ts';

export type Vocab = { blocks: string[]; items: string[]; mobs: string[]; players: string[]; creative?: boolean };
export type Routed = { skill: string; args: Record<string, any> } | { special: 'stop' | 'status' | 'chat' };
export type BusyAction = 'stop' | 'answer' | 'queue' | 'replace';
export type Cause = 'nothing_nearby' | 'out_of_reach' | 'missing_tool' | 'missing_ingredients' | 'interrupted' | 'unknown_name' | 'other';
/** ok = fully done; partial = some done; failed = nothing useful; unsure = Jev couldn't settle it (code decides). */
export type StepVerdict = { status: 'ok' | 'partial' | 'failed' | 'unsure'; cause: Cause };

// Why a step stopped. Descriptions go to Jev as criteria.
const CAUSES: Record<Cause, string> = {
  nothing_nearby: 'the block, item or creature it needed could not be found nearby',
  out_of_reach: 'it was found, but could not be reached: no path led to it, or finding a path took too long',
  missing_tool: 'a better tool was needed, like a stone pickaxe to mine iron',
  missing_ingredients: 'materials or ingredients were missing',
  interrupted: 'it was cut off partway by a fight, or by the player stopping it',
  unknown_name: 'a block, item or player name was not recognised',
  other: 'some other reason, or no reason is given',
};

const YES = 0.7; // above = yes; below 0.3 = no; between = unsure, treated as "not settled"

// Actions simple enough to run without the main AI. Descriptions go to Jev as criteria.
const ACTIONS: Record<string, string> = {
  come: 'walk over to the person who sent the message',
  follow: 'keep following the person who sent the message around',
  stop: 'stop or cancel whatever the bot is doing',
  collect: 'mine, chop or gather a kind of block, like wood, stone, dirt or an ore',
  give: 'hand an item the bot already has to the person who sent the message',
  craft: 'craft one specific item',
  attack: 'fight or kill a mob or creature',
  explore: 'wander off to find a new area',
  sleep: 'go to sleep in a bed',
  eat: 'eat some food now',
  status: 'tell the sender where the bot is, its health, or what it is carrying',
};

const asMap = (names: string[]) => Object.fromEntries(names.slice(0, 255).map((n) => [n, n.replace(/_/g, ' ')]));

export class JevRouter {
  private jev: Jev;
  constructor(jev: Jev) { this.jev = jev; }

  /** Returns a skill to run directly, or null to hand the message to the main AI. */
  async route(message: string, sender: string, v: Vocab): Promise<Routed | null> {
    const state: Record<string, unknown> = { message, sender };
    if (v.blocks.length) state.blocks_near_bot = v.blocks;
    if (v.items.length) state.bot_inventory = v.items;
    if (v.mobs.length) state.creatures_near_bot = v.mobs;

    const q: Record<string, any> = {
      needs_planning: { type: 'noul', instructions: 'Does `message` ask for something that needs several different steps first, like making tools, crafting or building?',
        criteria: { true: 'Things like "make an iron pickaxe", "build a house" or "set up a farm"; also chat, questions and jokes',
                    false: 'One kind of action, even if repeated: gathering one kind of block ("get 10 oak logs", "chop some wood"), coming, following, attacking, handing something over' } },
      // A choice always picks something, so this yes/no tells code whether any action was asked for at all.
      asks_action: { type: 'noul', instructions: 'Does `message` ask the bot to do something or to report on itself?',
        criteria: { true: 'An order or request, like "come here", "get wood" or "where are you?"', false: 'Chat, jokes, thanks, compliments, or general game questions' } },
      action: { type: 'choice', instructions: 'Which action does `message` ask the bot to do?', criteria: ACTIONS },
    };
    // Speculative questions: asked now, read by code only if `action` needs them.
    if (v.blocks.length) {
      q.block = { type: 'choice', instructions: 'Which block in `blocks_near_bot` does `message` ask the bot to gather?', criteria: asMap(v.blocks) };
      q.block_listed = { type: 'noul', instructions: 'Does `message` ask for a block that appears in `blocks_near_bot`?' };
    }
    if (v.items.length) {
      q.item = { type: 'choice', instructions: 'Which item in `bot_inventory` does `message` ask the bot to hand over?', criteria: asMap(v.items) };
      q.item_listed = { type: 'noul', instructions: 'Does `message` ask for an item that appears in `bot_inventory`?' };
    }
    if (v.mobs.length) {
      q.mob = { type: 'choice', instructions: 'Which creature in `creatures_near_bot` does `message` ask the bot to attack?', criteria: asMap(v.mobs) };
    }

    const a = await this.jev.ask(state, q);
    // Only clear "no planning needed" answers take the fast path; unsure ones go to the main AI.
    if (noul(a.asks_action) < 0.3) return { special: 'chat' }; // just talking: a small, cheap chat reply is enough
    if (!(noul(a.needs_planning) < 0.3) || !(noul(a.asks_action) > YES)) return null;

    const n = Number(message.match(/\b(\d{1,4})\b/)?.[1]) || undefined; // numbers: code, not the model
    const gatherCount = n ?? (/\b(a|one|an)\s+(single\s+)?\w+$/i.test(message.trim()) ? 1 : 8); // "some wood" = a useful amount
    switch (choice(a.action)) {
      case 'stop': return { special: 'stop' };
      case 'status': return { special: 'status' };
      case 'come': return { skill: 'goto', args: { player: sender } };
      case 'follow': return { skill: 'follow', args: { player: sender } };
      case 'explore': return { skill: 'explore', args: {} };
      case 'sleep': return { skill: 'sleep', args: {} };
      case 'eat': return { skill: 'eat', args: {} };
      case 'collect':
        if (!(noul(a.block_listed) > YES && choice(a.block))) return null;
        // Creative: no need to mine, just take it from the creative inventory.
        return v.creative ? { skill: 'get_item', args: { item: choice(a.block), count: gatherCount } }
          : { skill: 'collect', args: { block: choice(a.block), count: gatherCount } };
      case 'give':
        return noul(a.item_listed) > YES && choice(a.item) ? { skill: 'give', args: { player: sender, item: choice(a.item), count: n } } : null;
      case 'attack':
        return choice(a.mob) ? { skill: 'attack', args: { target: choice(a.mob) } } : null;
      default: return null; // craft and anything else: the main AI knows recipes
    }
  }

  /** Judge what happened in one plan step, so code can fix common failures without the main AI. */
  async judgeStep(skill: string, args: unknown, result: string): Promise<StepVerdict> {
    const a = await this.jev.ask({ step: `${skill} ${JSON.stringify(args)}`, result }, {
      done: { type: 'noul', instructions: 'Does `result` show that `step` was fully completed?',
        criteria: { true: 'It did everything asked, like "collected 10 oak_log" for a step asking for 10',
                    false: 'It stopped early, got less than asked, or reported an error' } },
      progress: { type: 'noul', instructions: 'Does `result` show that some of `step` got done before it stopped?',
        criteria: { true: 'Part of it happened, like "collected 4/10" or "placed 80 blocks, 12 couldn\'t be placed"', false: 'Nothing useful happened' } },
      cause: { type: 'choice', instructions: 'What stopped `step` from finishing?', criteria: CAUSES },
    });
    const done = noul(a.done), progress = noul(a.progress);
    const cause = (choice(a.cause) ?? 'other') as Cause;
    // Truth table. The band between 0.3 and 0.7 means "not settled": code's own check decides then.
    if (done > YES) return { status: 'ok', cause };
    if (done < 0.3) return { status: progress > YES ? 'partial' : 'failed', cause };
    return { status: 'unsure', cause };
  }

  /** The bot is busy and a new message arrived. */
  async whileBusy(message: string, currentTask: string): Promise<BusyAction> {
    const a: Record<string, Answer> = await this.jev.ask({ message, current_task: currentTask }, {
      stop: { type: 'noul', instructions: 'Does `message` tell the bot to stop or cancel what it is doing?' },
      question: { type: 'noul', instructions: 'Is `message` a question the sender wants answered?',
        criteria: { true: 'Asks for information, like "how many logs do you have?"', false: 'Asks the bot to do something, like "get some stone"' } },
      later: { type: 'noul', instructions: 'Does `message` ask for something to be done after `current_task` is finished?',
        criteria: { true: 'Uses words like "then", "after that", "when you\'re done"', false: 'Wants it done now' } },
    });
    // Truth table, checked in order.
    if (noul(a.stop) > YES) return 'stop';
    if (noul(a.question) > YES) return 'answer';
    if (noul(a.later) > YES) return 'queue';
    return 'replace';
  }
}
