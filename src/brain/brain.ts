import type { Body, Danger } from '../body/types.ts';
import type { LLM, Msg } from '../llm/index.ts';
import { type Action, runActions } from './executor.ts';
import { Memory } from './memory.ts';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { rmSync as require_rm } from 'node:fs';
import type { JevRouter } from './router.ts';

export type BrainConfig = {
  maxSteps?: number; historyLimit?: number; verbose?: boolean; onSettings?: () => void;
  /** The player Craftie belongs to: it follows them when idle and rescues their items when they die. */
  owner?: string;
  /** "craftie restart": restart the whole program (reloads code and settings). */
  onRestart?: () => void;
};

type Plan = { say?: string; actions?: Action[]; done?: boolean };

const system = (skillDocs: string) => `You are Craftie, an AI that fully controls a Minecraft player.
The player talks to you through game chat. You act through SKILLS that run fast native code.

Reply with ONLY a JSON object, no markdown:
{"say": "<reply>", "actions": [{"skill": "<name>", "args": {...}, "fallback": [<optional actions if this one fails>]}], "done": <bool>,
 "remember": ["<optional short lasting fact>"], "forget": ["<optional words of facts that are now wrong>"]}

TALKING: you're the player's friendly coworker. Minecraft chat is tiny: ONE short line, ideally under 80 characters,
never over 120. No lists, no markdown. Answer questions directly from memory, WHAT I DID and STATE.
For jobs, a few words is enough ("On it, building a cottage.").
MEMORY: use "remember" only for things worth knowing in future sessions (their preferences, names, important
places, plans, promises). One short fact each, no duplicates of LONG-TERM MEMORY. Use "forget" when a fact changed.

Common failures (nothing nearby, out of reach, missing materials, fights) are fixed automatically without asking you.
You only hear back when the plan itself needs to change, so plan the whole job at once and add a "fallback" where
there's an obvious plan B (e.g. use spruce if there's no oak, build somewhere else, smelt instead of mine).

SKILLS:
${skillDocs}

HOW TO BE OPTIMAL:
- You are an autonomous agent: turn one goal into a complete plan and carry it out without asking the player for steps.
- Prefer the big skills. "obtain" does a whole resource chain by itself (trees -> planks -> tools -> stone -> furnace -> iron...),
  and "build" gathers every material it needs and builds the whole structure. One obtain/build beats ten collect/craft calls.
- Send several actions per reply; they run in order and you get all results back at once.
- Set "done": true when the task is finished once these actions succeed. If any action fails you get another turn anyway.
- Use exact Minecraft ids (oak_log, oak_planks, stick, crafting_table, iron_pickaxe, cobblestone, raw_iron, iron_ingot).
- Questions or chat with no action needed: answer in "say", "actions": [], "done": true.
- Never invent coordinates you weren't given; use goto {block} / {player} or explore.

BUILD QUALITY (the player wants builds that look good, not boxes):
- For a house/home/base, use build {blueprint:"house"}. Size it to the request (small: 5x5, normal: 7x9, big: 9x11).
- Pick a palette with contrast: stone base (cobblestone/stone_bricks), log pillars, plank walls, darker stairs roof.
  Match the biome: spruce in snow/taiga, sandstone in desert, oak/birch in plains/forest.
- For anything without a preset (bridge, farm, statue, shop...), design it as blueprint "custom": think in layers,
  use depth (pillars, overhangs, stairs/slabs for roofs and trims), windows, lighting, and avoid flat single-material walls.
  Give stairs a facing. Keep custom designs under ~600 blocks unless the player asks for big.

THE PLAYER'S ITEMS: if STATE shows items held for the player, never use, store or drop them; only return_items gives them back.

GAME MODE RULES (see the GAME MODE line in STATE):
- If I am in creative: get every item with get_item. Never mine, smelt or craft just to obtain materials. Breaking blocks is instant and I can't take damage.
- If I am in survival or adventure: play fair. Gather, craft and smelt to get things. Watch health and food, and avoid lava and long falls.
- Use cheat commands (get_item in survival, /time, /weather, /tp, /gamemode) only when "commands allowed" is yes AND the player asks for it.
- Match the player: if they are in survival, assume they want a fair survival game.`;

// Small prompt for plain chat (no skill docs): far fewer tokens per message.
const CHAT_SYSTEM = `You are Craftie, a friendly AI coworker who plays Minecraft alongside the player.
Reply with ONLY JSON: {"say": "<ONE short line, ideally under 80 characters>", "remember": ["<optional lasting fact>"], "forget": ["<optional>"]}
Minecraft chat is tiny: no lists, no markdown, no long explanations. Be warm and direct.
Answer "what were you doing / where is X / what did I ask" from WHAT I DID, MY CHESTS and memory. "remember" only things worth keeping for future sessions.`;

/** Keep chat to one line: cut at a sentence end before ~150 characters. */
function short(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= 150) return t;
  const cut = t.slice(0, 150), end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return end > 40 ? cut.slice(0, end + 1) : cut.slice(0, cut.lastIndexOf(' ')) + '…';
}

function parsePlan(text: string): Plan {
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s >= 0 && e > s) { try { return JSON.parse(text.slice(s, e + 1)); } catch {} }
  return { say: text.trim().slice(0, 200), actions: [], done: true };
}

export class Brain {
  private controller: AbortController | null = null;
  private queue: { from: string; text: string }[] = [];
  private current: string | null = null;
  private memory: string[] = []; // short log of finished tasks, so follow-ups like "do it again" work

  private body: Body;
  private llm: LLM;
  private router: JevRouter | null;
  private cfg: BrainConfig;

  constructor(body: Body, llm: LLM, router: JevRouter | null, cfg: BrainConfig = {}) {
    this.body = body; this.llm = llm; this.router = router; this.cfg = cfg;
    body.onCommand((from, text, isPrivate) => {
      this.privateTo = isPrivate ? from : null;
      this.onCommand(from, text).catch((e) => console.error('[brain]', e));
    });
    this.memory2 = new Memory(cfg.owner ?? 'player', llm);
    this.memory2.paused = this.aiPaused;
    body.onDanger((d) => this.onDanger(d).catch((e) => console.error('[brain]', e)));
    body.onDeath((d) => this.onDeath(d).catch((e) => console.error('[brain]', e)));
    body.onPlayerDeath((p, d) => this.onPlayerDeath(p, d).catch((e) => console.error('[brain]', e)));
    body.onPlayerSleep((p, bed) => this.onPlayerSleep(p, bed).catch((e) => console.error('[brain]', e)));
    this.owner = cfg.owner ?? '';
    if (this.owner) setTimeout(() => this.idle(), 3000);
    setInterval(() => this.maybeChore().catch((e) => console.error('[brain]', e)), 15000);
    // Chores never drag Craftie away: if the player walks off, drop the chore and follow.
    setInterval(() => {
      const leash = this.current?.startsWith('chore: treasure') ? 24 : 40;
      if (this.current?.startsWith('chore:') && this.owner && !this.body.isNear(this.owner, leash)) { this.log('player moved away -> dropping chore'); this.abort(); }
    }, 3000);
  }

  private log(...a: any[]) { if (this.cfg.verbose ?? true) console.log('[brain]', ...a); }

  /** Instant commands handled with zero AI calls. */
  private reflex(from: string, text: string): boolean {
    const t = text.toLowerCase().replace(/[!.?]+$/, '').trim();
    // Personal commands (follow/stay/stop/relax/settings/my stuff) belong to the player only, not friends.
    const me = !this.cfg.owner || from === this.cfg.owner || from.startsWith('console');
    if (!me && /^(follow|come with|keep up|stay|wait|don'?t follow|stop|cancel|halt|freeze|nvm|never ?mind|pause|resume|unpause|restart|reboot|reload|relax|take a break|chill|get to work|work|back to work|keep busy|\/?(mod-)?(settings|setup|options|config))\b/.test(t)) {
      this.say(`Sorry ${from}, only ${this.cfg.owner} can tell me that.`);
      return true;
    }
    if (/^\/?(mod-)?(settings|setup|options|config)$/.test(t)) {
      if (this.cfg.onSettings) { this.cfg.onSettings(); this.say('Opening settings on the Craftie PC.'); }
      else this.say('Settings page is only available when started with the start file.');
      return true;
    }
    if (/^(stop|cancel|halt|freeze|nvm|never ?mind)$/.test(t)) { this.abort(); this.queue = []; this.say('Stopped.'); return true; }
    if (/^(come( here)?|come to me|tp to me)$/.test(t)) { this.startTask(from, `goto player ${from}`, [{ skill: 'goto', args: { player: from } }]); return true; }
    if (/^(follow( me)?|come with me|keep up)$/.test(t)) { this.abort(); this.following = true; this.body.setFollow(this.owner || from); this.say("Following you."); return true; }
    if (/^(restart|reboot|reload|restart yourself)$/.test(t)) {
      if (!this.cfg.onRestart) { this.say('Restart only works when I was started with the start file.'); return true; }
      this.say('Restarting, back in a few seconds.');
      setTimeout(() => this.cfg.onRestart!(), 1500); // let the chat line go out first
      return true;
    }
    if (/^(pause|pause ai|save usage|low usage|go quiet|quiet mode)$/.test(t)) { this.abort(); this.setAiPaused(true); this.say("Paused my AI to save usage. I'll still follow, defend and do simple commands."); return true; }
    if (/^(resume|unpause|ai on|wake up|back on)$/.test(t)) { this.setAiPaused(false); this.say('AI back on. What do you need?'); return true; }
    if (/^(relax|take a break|stop working|chill)$/.test(t)) { this.working = false; this.abort(); this.say("OK, I'll just hang out."); return true; }
    if (/^(get to work|work|back to work|keep busy)$/.test(t)) { this.working = true; this.say("On it. I'll keep myself useful."); return true; }
    if (/^(stay|stay (here|there|put)|wait( here)?|don'?t follow( me)?|stop following( me)?)$/.test(t)) { this.abort(); this.following = false; this.body.setFollow(null); this.say("OK, I'll stay here."); return true; }
    if (/\b(give|return|hand)\b.*\b(my|me)\b.*\b(stuff|items?|things|loot|gear|inventory)\b|\bmy (stuff|items|things) back\b/.test(t)) {
      this.startTask(from, 'give the player their items back', [{ skill: 'return_items', args: { player: from } }], true); return true;
    }
    if (/^(status|where are you|pos|inv|inventory)$/.test(t)) { this.say(this.body.describeState().split('\n').slice(0, 3).join(' | ')); return true; }
    return false;
  }

  private abort() {
    if (this.current) this.memory.push(`"${this.current}" -> interrupted`);
    this.controller?.abort(); this.controller = null; this.current = null; this.body.halt();
    setTimeout(() => this.idle(), 500); // back to following unless something new starts
  }

  private async onCommand(from: string, text: string) {
    this.log(`${from}: ${text}`);
    const isMe = !this.cfg.owner || from === this.cfg.owner || from.startsWith('console');
    // Friends never interrupt the player's own job: their orders wait in line.
    if (!isMe && this.current && (this.currentFrom === this.cfg.owner || this.currentFrom === 'self' && !this.current.startsWith('chore:'))) {
      this.queue.push({ from, text });
      this.say(`Busy with ${this.cfg.owner}'s job, ${from}. I'll do yours after.`);
      return;
    }
    if (this.current?.startsWith('chore:')) { this.controller?.abort(); this.controller = null; this.current = null; this.body.halt(); } // your orders come first
    if (this.reflex(from, text)) return;

    if (this.current && this.aiPaused && !this.current.startsWith('chore:')) { this.pausedReply(); return; }
    if (this.current) {
      // Busy: work out what the new message means. Jev if available, otherwise word rules.
      let choice = /^(then|after|also|and then|next)\b/i.test(text) ? 'queue' : /\?$/.test(text) ? 'answer' : 'replace';
      if (this.router) {
        try { choice = await this.router.whileBusy(text, this.current); }
        catch (e: any) { this.log('Jev failed, using word rules:', e.message); }
      }
      this.log('busy ->', choice);
      if (choice === 'stop') { this.abort(); this.queue = []; this.say('Stopped.'); return; }
      if (choice === 'queue') { this.queue.push({ from, text }); this.say('Queued.'); return; }
      if (choice === 'answer') {
        this.memory2.addTurn(from, text);
        const r = parsePlan(await this.llm.complete(system(this.body.skillDocs()), [{ role: 'user', content:
          `${this.memory2.block(text)}\n\nSTATE:\n${this.body.describeState()}\nCURRENT TASK: ${this.current}\nQUESTION from ${from} (answer only, no actions): ${text}` }]));
        if (r.say) { this.say(r.say); this.memory2.addTurn('Craftie', r.say); }
        this.memory2.remember((r as any).remember); this.memory2.forget((r as any).forget);
        return;
      }
      this.abort();
    }

    // Fast path: simple one-step commands skip the main AI entirely.
    if (this.router) {
      const t0 = Date.now();
      try {
        const r = await this.router.route(text, from, this.body.vocab());
        this.log(`Jev ${Date.now() - t0}ms ->`, r ? JSON.stringify(r) : 'needs main AI');
        if (r && 'special' in r) {
          if (r.special === 'chat') return void (this.aiPaused ? this.pausedReply() : this.chat(from, text));
          if (r.special === 'stop') { this.abort(); this.queue = []; this.say('Stopped.'); }
          else this.say(this.body.describeState().split('\n').slice(0, 3).join(' | '));
          return;
        }
        if (r) return void this.startTask(from, text, [r], true);
      } catch (e: any) { this.log('Jev failed, using main AI:', e.message); }
    }
    if (this.aiPaused) return void this.pausedReply();
    this.startTask(from, text);
  }

  private owner = '';
  private currentFrom = ''; // who gave the job that's running
  private privateTo: string | null = null; // replies go privately while the player is whispering
  /** "craftie pause": no main-AI calls at all (saves usage). Code-only behavior keeps working. Survives restarts. */
  private pausedFile = join(homedir(), '.craftie', 'paused');
  private get aiPaused() { return existsSync(this.pausedFile); }
  private setAiPaused(on: boolean) {
    try { mkdirSync(join(homedir(), '.craftie'), { recursive: true }); if (on) writeFileSync(this.pausedFile, String(Date.now())); else require_rm(this.pausedFile, { force: true }); } catch {}
    this.memory2.paused = on;
  }
  private pausedReply() { this.say("I'm paused to save usage. Simple commands still work; say \"craftie resume\" for the rest."); }
  private memory2: Memory;
  /** Chat to the player, privately if that's how they're talking to us. */
  private say(text: string) { this.body.say(short(text), this.privateTo); }
  private following = true; // follow the owner when there's no job ("stay" turns it off)
  private working = true;   // do chores for itself when idle ("relax" turns it off)
  private choreSkip = new Map<string, number>(); // chores that just failed: don't retry for a while

  /**
   * Like a coworker: when there's no job from the player, get what Craftie itself needs
   * (food, tools, weapon, armor, a bed, supplies), staying near the player.
   */
  private announcedStash = false;

  private async maybeChore() {
    // Holding the player's things and they're right here: let them know (once).
    const holding = /held for the player/.test(this.body.describeState());
    if (!holding) this.announcedStash = false;
    else if (!this.announcedStash && this.owner && this.body.isNear(this.owner, 10)) {
      this.announcedStash = true;
      this.say(`${this.owner}, I've got your stuff from when you died. Say "give me my stuff back" whenever you want it.`);
    }
    if (!this.working || this.current || this.fighting || !this.owner || !this.body.isNear(this.owner, 32)) return;
    const now = Date.now();
    // Treasure first: valuables right here are worth a quick detour; deep/risky ones get reported.
    const t = this.body.findTreasure(this.owner);
    if (t?.kind === 'report') {
      const name = t.block.replace(/^deepslate_|_ore$/g, '').replace(/_/g, ' ');
      this.say(`Found ${name} at ${t.x} ${t.y} ${t.z} (${t.why}). Say "get the ${name}" if you want it.`);
      this.memory2.remember([`${name} spotted at ${t.x} ${t.y} ${t.z} (${t.why})`]);
      this.memory2.logActivity(`spotted ${name} at ${t.x} ${t.y} ${t.z}`);
      return;
    }
    if (t?.kind === 'grab' || t?.kind === 'item') {
      const what = t.kind === 'item' ? t.item : t.block;
      if (t.kind === 'grab' && t.rare) this.say(`Ooh, ${what.replace(/^deepslate_|_ore$/g, '').replace(/_/g, ' ')} here, grabbing it.`);
      const act = t.kind === 'item'
        ? { skill: 'goto', args: { x: Math.floor(t.x), y: Math.floor(t.y), z: Math.floor(t.z), range: 0 } }
        : { skill: 'dig', args: { x: t.x, y: t.y, z: t.z } };
      await this.startTask('self', `chore: treasure ${what}`, [act], false, true);
      return;
    }
    const skip = new Set([...this.choreSkip].filter(([, until]) => until > now).map(([k]) => k));
    const chore = this.body.nextChore(skip);
    if (!chore) return;
    this.say(`Making myself ${chore.why}.`);
    const act = chore.item === '__tidy' ? { skill: 'tidy', args: {} } : { skill: 'obtain', args: { item: chore.item, count: chore.count, nearby: true } };
    await this.startTask('self', `chore: ${chore.why} (${chore.item})`, [act], false, true);
    if (!/-> done$/.test(this.memory.at(-1) ?? '')) this.choreSkip.set(chore.item, now + 10 * 60_000);
  }

  /** Nothing to do: keep near the owner at a safe distance (unless told to stay). */
  private idle() { if (!this.current && this.following && this.owner) this.body.setFollow(this.owner); }

  /**
   * The owner went to bed. The night only skips when every player sleeps, so pause the job and sleep
   * next to them; that also puts Craftie's spawn point right next to theirs.
   */
  private async onPlayerSleep(player: string, bed: { x: number; y: number; z: number }) {
    if (player !== this.owner) return;
    this.log(`${player} went to bed -> sleeping next to them`);
    await this.body.interrupt(async (signal) => {
      const r = await this.body.runSkill('sleep_near', bed, signal);
      this.log('   ' + r);
      if (/^no free bed|couldn't/.test(r)) {
        this.say(r.includes('Place a bed') ? 'I need a bed next to yours so the night can skip (and so we respawn together).' : r);
        // Fallback when cheats are on: let the night skip with just the player asleep.
        await this.body.runSkill('command', { text: 'gamerule playersSleepingPercentage 50' }, signal).catch(() => {});
      }
    });
  }

  /** The owner died: their items vanish in 5 minutes, so drop everything and go get them. */
  private async onPlayerDeath(player: string, d: { x: number; y: number; z: number; cause: string }) {
    const job = this.current && !/^(recover|fetch)/.test(this.current) ? this.current : null;
    this.abort();
    this.say(`Oh no, ${player}! I'll get your stuff from ${d.x} ${d.y} ${d.z} and keep it safe. Say "give me my stuff back" when you want it.`);
    if (job) this.queue.unshift({ from: player, text: job });
    await this.startTask('self', `fetch ${player}'s items after they died`, [{ skill: 'collect_player_items', args: { player, x: d.x, y: d.y, z: d.z } }], true);
  }

  /** Died: tell the player, fetch the dropped items if it's safe, then carry on with the job. */
  private async onDeath(d: { x: number; y: number; z: number; cause: string }) {
    const job = this.current && !/^(recover|defend)/.test(this.current) ? this.current : null;
    this.log(`died (${d.cause}) during: ${job ?? 'nothing'}`);
    this.abort();
    // Going back into lava or the void would just kill us again.
    const unsafe = /lava|fell out of the world|burn|fire|suffocat|drown/i.test(d.cause);
    this.say(`I died (${d.cause}) at ${d.x} ${d.y} ${d.z}. ${unsafe ? "Not safe to go back for my items." : 'Going back for my items.'}`);
    if (unsafe && this.owner && /commands allowed: yes/.test(this.body.describeState())) await this.body.runSkill('command', { text: `tp @s ${this.owner}` }, new AbortController().signal).catch(() => {});
    if (job) this.queue.unshift({ from: this.owner || 'self', text: `${job} (carry on after dying: check what's still in my inventory first)` });
    if (!unsafe) await this.startTask('self', 'recover items after dying', [{ skill: 'recover', args: { x: d.x, y: d.y, z: d.z } }], true);
    else { const next = this.queue.shift(); if (next) this.startTask(next.from, next.text); }
  }

  private fighting = false;

  /** Being attacked pauses the current job (it isn't cancelled), handles it, then the job carries on. */
  private async onDanger(d: Danger) {
    if (this.fighting) return;
    this.fighting = true;
    // Plain numbers, so code decides (no AI needed). Mobs: fight when healthy, back off when hurt.
    // Players who attack Craftie: no mercy, fight to the end; only run when about to die.
    // Defending the player: always fight unless about to die.
    const choice = d.isPlayer || d.protecting ? (d.health > 4 ? 'fight' : 'flee') : (d.health >= 8 ? 'fight' : 'flee');
    this.log(`${d.protecting ? `${d.protecting} attacked by` : 'attacked by'} ${d.attacker}${d.isPlayer ? ' (player)' : ''} -> ${choice}${this.current ? ' (pausing current job)' : ''}`);
    if (choice === 'fight' && d.isPlayer) this.say(d.protecting ? `Leave ${d.protecting} alone, ${d.attacker}!` : `You attacked me, ${d.attacker}. Bad idea.`);
    try {
      await this.body.interrupt((signal) => choice === 'fight'
        ? this.body.runSkill('attack', { target: d.attacker, chase: d.isPlayer || !!d.protecting }, signal)
        : this.body.runSkill('explore', { distance: 16 }, signal));
    } finally { this.fighting = false; }
  }

  /** Runs one task. `preset` actions skip the first AI call. */
  /** presetOnly: run just the given actions; if they fail, stop (no AI re-planning). Used for chores. */
  private async startTask(from: string, text: string, preset?: Plan['actions'], reportResult = false, presetOnly = false) {
    // One job at a time: starting a new one cleanly stops whatever was running.
    if (this.controller) { this.controller.abort(); this.body.halt(); }
    this.body.setFollow(null); // don't wander after the player mid-job
    this.currentFrom = from;
    const ctl = new AbortController();
    this.controller = ctl;
    this.current = text;
    const sys = system(this.body.skillDocs());
    if (from !== 'self') this.memory2.addTurn(from, text);
    const history: Msg[] = [{ role: 'user', content:
      `${this.memory2.block(text)}\n\nRECENT TASKS:\n${this.memory.slice(-5).join('\n') || 'none'}\n\nSTATE:\n${this.body.describeState()}\n\nMESSAGE from ${from}: ${text}` }];
    let outcome = 'unfinished';
    let lastResult = '';

    try {
      for (let step = 0; step < (this.cfg.maxSteps ?? 20); step++) {
        let plan: Plan;
        if (step === 0 && preset) plan = { actions: preset, done: true };
        else {
          const t0 = Date.now();
          const raw = await this.llm.complete(sys, history, ctl.signal);
          this.log(`${this.llm.name} ${Date.now() - t0}ms:`, raw.replace(/\s+/g, ' ').slice(0, 300));
          history.push({ role: 'assistant', content: raw });
          plan = parsePlan(raw);
        }
        if (ctl.signal.aborted) return;
        if (plan.say) { this.say(plan.say); this.memory2.addTurn('Craftie', plan.say); }
        this.memory2.remember((plan as any).remember);
        this.memory2.forget((plan as any).forget);

        const ran = await runActions(this.body, this.router, plan.actions ?? [], ctl.signal, (...a) => this.log(...a));
        const { results, failed, localFixes } = ran;
        lastResult = (results.at(-1) ?? '').replace(/^.*?-> /, '').replace(/\. inventory:.*$/, '').slice(0, 90);
        if (localFixes) this.log(`   ${localFixes} problem(s) fixed without asking ${this.llm.name}`);
        if ((presetOnly || this.aiPaused) && step === 0 && preset) { outcome = failed ? 'failed' : 'done'; return; }
        if (plan.done && !failed) {
          outcome = 'done';
          if ((plan.actions ?? []).some((a) => a.skill === 'build' || a.skill === 'obtain') && this.working)
            this.queue.push({ from: 'self', text: '__tidy' });
          if (reportResult && results.length) this.say(results.at(-1)!.replace(/^.*?-> /, '').slice(0, 200));
          return;
        }
        history.push({ role: 'user', content: `RESULTS (automatic fixes were already tried for failures):\n${results.join('\n') || '(no actions)'}\n\nSTATE:\n${this.body.describeState()}` });
        const lim = this.cfg.historyLimit ?? 14;
        if (history.length > lim) history.splice(1, history.length - lim); // keep the original command + recent turns
      }
      this.say('Hit the step limit for this task.');
    } catch (e: any) {
      if (!ctl.signal.aborted) {
        outcome = 'error: ' + e.message;
        if (/usage limit|rate.?limit|quota|limit reached|429|insufficient_quota|credit balance/i.test(e.message)) {
          this.setAiPaused(true);
          this.say("I hit the AI usage limit, so I've paused my AI. I'll keep following and defending. Say \"craftie resume\" later.");
        } else this.say('AI error: ' + e.message.slice(0, 120));
        console.error(e);
      }
    } finally {
      if (this.controller === ctl) {
        this.controller = null;
        this.current = null;
        this.memory.push(`"${text}" -> ${outcome}`);
        if (text !== '__tidy') this.memory2.logActivity(`${text.replace(/^chore: /, 'for myself: ')} -> ${outcome}${lastResult ? ` (${lastResult})` : ''}`);
        let next = this.queue.shift();
        if (next?.text === '__tidy') {
          // Only tidy if the bag is getting full; otherwise skip straight on.
          if (this.body.nextChore(new Set())?.item === '__tidy') this.startTask('self', 'chore: tidy up', [{ skill: 'tidy', args: {} }]);
          else { next = this.queue.shift(); next ? this.startTask(next.from, next.text) : this.idle(); }
        } else if (next) this.startTask(next.from, next.text);
        else this.idle();
      }
    }
  }

  /** Plain conversation: small prompt, memory included, no actions. */
  private async chat(from: string, text: string) {
    this.memory2.addTurn(from, text);
    const state = this.body.describeState().split('\n');
    const status = [...state.slice(0, 3), ...state.filter((l) => /^(my chests|home|held for)/.test(l))].join('\n');
    const t0 = Date.now();
    const raw = await this.llm.complete(CHAT_SYSTEM, [{ role: 'user', content:
      `${this.memory2.block(text)}\n\nMY STATUS:\n${status}${this.current ? `\nCURRENTLY DOING: ${this.current}` : ''}\n\n${from}: ${text}` }]);
    this.log(`${this.llm.name} chat ${Date.now() - t0}ms:`, raw.replace(/\s+/g, ' ').slice(0, 200));
    const r = parsePlan(raw);
    if (r.say) { this.say(r.say); this.memory2.addTurn('Craftie', r.say); }
    this.memory2.remember((r as any).remember); this.memory2.forget((r as any).forget);
  }

  /** Swap the AI (provider/model/keys) or Jev without stopping anything. */
  setAI(llm: LLM, router: JevRouter | null) { this.llm = llm; this.router = router; this.memory2.setLLM(llm); }

  shutdown() { this.queue = []; this.abort(); }

  /** Commands typed in the terminal count as coming from the first owner. */
  command(from: string, text: string) { this.onCommand(from, text).catch((e) => console.error(e)); }
}
