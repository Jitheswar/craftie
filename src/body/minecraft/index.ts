import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import collectBlock from 'mineflayer-collectblock';
import pvp from 'mineflayer-pvp';
import armorManager from 'mineflayer-armor-manager';
import { loader as autoEat } from 'mineflayer-auto-eat';
import type { Body, Danger, Death } from '../types.ts';
import { discoverLan } from './lan.ts';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Vec3 } from 'vec3';
import { canUseCommands, describe, vocab } from './perception.ts';
import { equipBest, flyRoute, flyTo, skills, sleep } from './skills.ts';
import './autonomy.ts'; // adds obtain + build to skills
import { nextChore } from './chores.ts';
import { findTreasure } from './treasure.ts';
import { aroundUs, glanceTarget, scan as scanAround } from './awareness.ts';

const { pathfinder, Movements: BaseMovements } = pf as any;

// Blocks that (almost) never generate naturally: someone built them. Never break these to get somewhere.
const PLAYER_MADE = /_planks$|_stairs$|_slab$|glass|_wool$|_carpet$|bricks?$|concrete|_door$|trapdoor|torch|lantern|chest|furnace|crafting_table|_bed$|fence|_wall$|smooth_|polished_|chiseled_|cut_|bookshelf|_sign$|banner|barrel|smoker|anvil|hay_block|glazed|_block$|ladder|scaffolding|rail$|_terracotta$|beacon|enchanting|brewing|jukebox|note_block|lectern|loom|composter|bell$|candle|flower_pot|item_frame|shulker/;

/**
 * The pathfinder thinks you can't climb out of water: when deciding if a jump onto the shore is
 * possible, it measures from the pool floor instead of the surface you're floating at. Swimmers
 * float, so measure from the water surface instead. Everything else is the library's own logic.
 */
class Movements extends BaseMovements {
  getMoveJumpUp(node: any, dir: any, neighbors: any) {
    if (!this.getBlock(node, 0, 0, 0).liquid) return super.getMoveJumpUp(node, dir, neighbors);
    const orig = this.getBlock;
    this.getBlock = (n: any, dx: number, dy: number, dz: number) => {
      const b = orig.call(this, n, dx, dy, dz);
      return n === node && dx === 0 && dy === -1 && dz === 0 ? { ...b, height: node.y } : b;
    };
    try { return super.getMoveJumpUp(node, dir, neighbors); } finally { this.getBlock = orig; }
  }
}
export { Movements as CraftieMovements };

export type MinecraftConfig = {
  /** Server address, or "lan" to auto-find a world opened with "Open to LAN". */
  host: string;
  port?: number;
  username: string;
  /** "microsoft" for premium accounts/online servers, "offline" for cracked/LAN/offline-mode servers. */
  auth?: 'microsoft' | 'offline';
  /** e.g. "1.21.4". Leave unset to auto-detect from the server. */
  version?: string;
  owners: string[];             // who may command the bot; ["*"] = anyone
  prefixes: string[];           // chat must start with one of these (whispers don't need it)
  replyWhisper?: boolean;       // reply via /msg instead of public chat
  viewerPort?: number;          // browser view of what the bot sees
  allowParkour?: boolean;
  canDig?: boolean;             // allow breaking blocks while pathing
  autoReconnect?: boolean;
  /** Extra regexes for servers with custom chat formats. Must capture (name)(message). */
  chatPatterns?: string[];
  /** For cracked servers with login plugins (AuthMe, nLogin...): auto /register and /login. */
  password?: string;
  /** Other Crafties on the team (live list): never fought, even if one hits us by accident. */
  team?: string[];
  /** How far behind the player to walk (helpers keep a bit further back so they don't crowd). */
  followGap?: number;
  /** A helper answers only to its own name (and "team"), not to "craftie"/"ai", and doesn't greet. */
  helper?: boolean;
};

export function createMinecraftBody(cfg: MinecraftConfig): Body {
  let bot: any;
  const commandCbs: ((from: string, text: string, isPrivate: boolean) => void)[] = [];
  const dangerCbs: ((d: Danger) => void)[] = [];
  const deathCbs: ((d: Death) => void)[] = [];
  const playerDeathCbs: ((player: string, d: Death) => void)[] = [];
  const playerSleepCbs: ((player: string, bed: { x: number; y: number; z: number }) => void)[] = [];
  let followTarget: string | null = null;
  const lastSeen = new Map<string, { x: number; y: number; z: number; dim: string }>();
  const outQueue: string[] = [];
  let lastOwner = cfg.owners[0];
  let recent = new Map<string, number>(); // dedupe chat seen via two event paths

  const isOwner = (u: string) => cfg.owners.includes('*') || cfg.owners.some((o) => o.toLowerCase() === u.toLowerCase());
  // The player Craftie belongs to (first owner). Friends may give orders, but only this player is never fought.
  const primary = (cfg.owners.find((o) => o !== '*') ?? '').toLowerCase();
  const isPrimary = (u?: string) => !!u && u.toLowerCase() === primary;
  const isTeam = (u?: string) => !!u && (cfg.team ?? []).some((t) => t.toLowerCase() === u.toLowerCase());
  const isFriendly = (u?: string) => isPrimary(u) || isTeam(u);
  const gap = cfg.followGap ?? 3;

  function handleIncoming(from: string, msg: string, whisper: boolean) {
    if (!bot || from === bot.username || !isOwner(from)) return;
    const key = from + '|' + msg;
    if ((recent.get(key) ?? 0) > Date.now() - 1500) return;
    recent.set(key, Date.now());
    if (recent.size > 100) recent = new Map([...recent].slice(-50));

    let text = msg.trim();
    if (!whisper) {
      // Accept any natural way of addressing the bot: "!ai", "ai", "!craftie", "Craftie,", "@Craftie" ...
      const names = [...new Set([...(cfg.helper ? [] : ['ai', 'craftie']), bot.username.toLowerCase(), ...cfg.prefixes.map((p) => p.replace(/^[!@]/, '').toLowerCase())])]
        .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      const m = text.match(new RegExp(`^[!@/.]?(${names.join('|')})(?![a-z0-9_])[\\s,:!]*`, 'i'));
      if (!m) return;
      text = text.slice(m[0].length);
    }
    if (!text) return;
    lastOwner = from;
    commandCbs.forEach((cb) => cb(from, text, whisper));
  }

  // Send chat slowly so servers don't kick for spam.
  let stopped = false;
  const sendTimer = setInterval(() => {
    const line = outQueue.shift();
    if (line && bot?.entity) bot.chat(line); // private lines are queued as "/msg <player> ..." already
  }, 700);

  // Blocks the player placed, so Craftie never breaks *their* builds (saved per world).
  const ownerBuilt = new Set<string>();
  if (process.env.CRAFTIE_DEBUG) (globalThis as any).__craftieOwnerBuilt = ownerBuilt;

  // Home + chest memory, saved per world (keyed by LAN world name or server address).
  let worldKey = '';
  const memFile = () => join(homedir(), '.craftie', 'worlds', worldKey.replace(/[^\w.-]+/g, '_') + (cfg.helper ? `.${cfg.username}` : '') + '.json');
  const loadMemory = () => {
    try {
      const m = JSON.parse(readFileSync(memFile(), 'utf8'));
      bot.craftieHome = m.home ?? null;
      bot.craftieChests = new Map(Object.entries(m.chests ?? {}));
      ownerBuilt.clear(); for (const k of m.ownerBuilt ?? []) ownerBuilt.add(k);
    } catch {}
  };
  let saveTimer: any;
  const saveMemory = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        mkdirSync(join(homedir(), '.craftie', 'worlds'), { recursive: true });
        writeFileSync(memFile(), JSON.stringify({ home: bot.craftieHome ?? null, chests: Object.fromEntries(bot.craftieChests ?? []), ownerBuilt: [...ownerBuilt].slice(-50000) }));
      } catch {}
    }, 2000);
  };

  async function connect() {
    let host = cfg.host, port = cfg.port ?? 25565;
    if (stopped) return;
    if (host === 'lan') {
      console.log('[mc] looking for a LAN world...');
      try {
        const w = await discoverLan(15000, cfg.owners.find((o) => o !== '*'));
        host = w.host; port = w.port; worldKey = w.motd || `${host}_${port}`;
        console.log(`[mc] found LAN world "${w.motd}" at ${host}:${port}`);
      } catch (e: any) {
        console.log('[mc]', e.message);
        return void (!stopped && setTimeout(connect, 5000));
      }
    }
    bot = mineflayer.createBot({
      host, port, username: cfg.username,
      auth: cfg.auth ?? 'offline', version: cfg.version || undefined,
    } as any);
    if (process.env.CRAFTIE_DEBUG) (globalThis as any).__craftieBot = bot; // tests read air/position directly
    bot.loadPlugin(pathfinder);
    bot.loadPlugin(collectBlock.plugin);
    bot.loadPlugin(pvp.plugin);
    bot.loadPlugin(armorManager);
    bot.loadPlugin(autoEat);

    // Track our op level the same way the real client does.
    bot._client.on('entity_status', (p: any) => {
      if (bot.entity && p.entityId === bot.entity.id && p.entityStatus >= 24 && p.entityStatus <= 28) bot.craftieOpLevel = p.entityStatus - 24;
    });

    if (!worldKey) worldKey = `${host}_${port}`;
    bot.on('craftieMemoryChanged', saveMemory);
    bot.once('spawn', async () => {
      loadMemory();
      console.log(`[mc] spawned as ${bot.username} on ${host}:${port} (MC ${bot.version})`);
      const moves = new Movements(bot);
      moves.allowParkour = cfg.allowParkour ?? true;
      moves.canDig = cfg.canDig ?? true;
      moves.allowSprinting = true;
      moves.liquidCost = 4; // prefer walking around water over swimming through it
      // Blocks it may stack under itself to climb (e.g. to follow you up a pillar). Never planks or ores.
      moves.scafoldingBlocks = ['dirt', 'cobblestone', 'cobbled_deepslate', 'netherrack', 'stone', 'andesite', 'diorite', 'granite', 'tuff', 'blackstone']
        .map((n) => bot.registry.itemsByName[n]?.id).filter((x: any) => x !== undefined);
      moves.allow1by1towers = true;
      // Walking may dig through blocks to reach you, but never through blocks *you* placed.
      // (Other people's blocks don't count: someone could use them to wall Craftie off from you.)
      moves.exclusionAreasBreak.push((blk: any) => (ownerBuilt.has(`${blk.position.x},${blk.position.y},${blk.position.z}`) ? 100 : 0));
      bot.pathfinder.setMovements(moves);
      // Bounded path search: unbounded searches through solid ground can eat gigabytes of memory.
      bot.pathfinder.thinkTimeout = 6000;
      if (process.env.CRAFTIE_DEBUG) {
        bot.on('path_update', (r: any) => { if (r.generatedNodes > 20000) console.log(`[debug] path ${r.status} visited=${r.visitedNodes} generated=${r.generatedNodes} ${Math.round(r.time)}ms`); });
        setInterval(() => console.log(`[debug] heap ${Math.round(process.memoryUsage().heapUsed / 1e6)}MB goal=${bot.pathfinder.goal?.constructor?.name ?? '-'} moving=${bot.pathfinder.isMoving()} mining=${bot.pathfinder.isMining()}`), 3000);
      }
      bot.pathfinder.searchRadius = 48;
      bot.collectBlock.movements = moves;
      bot.autoEat.setOpts({ minHunger: 15 });
      bot.autoEat.enableAuto();
      setTimeout(() => equipBest(bot).catch(() => {}), 2000);
      if (!cfg.helper) outQueue.push(`Hi! I'm ${bot.username}. Type "${cfg.prefixes[0]} <anything>" in chat to give me a job, or "${cfg.prefixes[0]} stop".`);
      if (cfg.viewerPort) {
        try {
          const { mineflayer: viewer } = (await import('prismarine-viewer')).default as any;
          viewer(bot, { port: cfg.viewerPort, firstPerson: false });
          console.log(`[mc] live view: http://localhost:${cfg.viewerPort}`);
        } catch (e: any) { console.log('[mc] viewer unavailable:', e.message); }
      }
    });

    bot.on('chat', (u: string, m: string) => handleIncoming(u, m, false));
    bot.on('whisper', (u: string, m: string) => handleIncoming(u, m, true));
    if (cfg.chatPatterns?.length) {
      const res = cfg.chatPatterns.map((p) => new RegExp(p));
      bot.on('messagestr', (s: string) => {
        for (const r of res) { const m = s.match(r); if (m) return handleIncoming(m[1], m[2], false); }
      });
    }

    // Death: remember where and why, then report once we've respawned (mineflayer respawns by itself).
    let lastDeathMsg = '', died: Death | null = null;
    bot.on('messagestr', (m: string) => { if (bot.username && m.startsWith(bot.username + ' ') && !m.includes('<')) lastDeathMsg = m; });
    bot.on('death', () => {
      const p = bot.entity.position;
      died = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z), cause: '', dimension: bot.game.dimension };
      bot.pathfinder?.stop(); bot.pvp?.stop();
      console.log(`[mc] died at ${died.x},${died.y},${died.z}`);
    });
    bot.on('spawn', () => {
      if (!died) return;
      const d = { ...died, cause: lastDeathMsg.replace(bot.username, '').trim() || 'unknown' };
      died = null; lastDeathMsg = '';
      setTimeout(() => deathCbs.forEach((cb) => cb(d)), 1500); // let the world load around the respawn point
      setTimeout(() => equipBest(bot).catch(() => {}), 2500);
    });

    // Owner deaths: from the death event if we can see them, else from the death message + where we last saw them.
    const recentOwnerDeath = new Map<string, number>();
    const ownerDied = (name: string, pos: { x: number; y: number; z: number }, cause: string) => {
      if ((recentOwnerDeath.get(name) ?? 0) > Date.now() - 5000) return;
      recentOwnerDeath.set(name, Date.now());
      const d: Death = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z), cause, dimension: bot.game.dimension };
      console.log(`[mc] ${name} died at ${d.x},${d.y},${d.z} (${cause})`);
      ownerDiedAt = Date.now();
      playerDeathCbs.forEach((cb) => cb(name, d));
    };
    bot.on('entityMoved', (e: any) => { if (e.type === 'player' && isPrimary(e.username)) lastSeen.set(e.username, { x: e.position.x, y: e.position.y, z: e.position.z, dim: bot.game.dimension }); });
    bot.on('entityDead', (e: any) => { if (e.type === 'player' && isPrimary(e.username)) setTimeout(() => ownerDied(e.username, e.position, lastOwnerDeathMsg.get(e.username) ?? 'died'), 300); });
    const lastOwnerDeathMsg = new Map<string, string>();
    bot.on('messagestr', (m: string, pos: string) => {
      if (pos === 'chat' || m.startsWith('<')) return;
      const name = m.split(' ')[0];
      if (!name || !isPrimary(name)) return;
      if (/ (joined|left) the game| has (made|completed|reached) the | is now | issued server command/.test(m)) return;
      lastOwnerDeathMsg.set(name, m.slice(name.length).trim());
      const seen = lastSeen.get(name);
      if (seen) setTimeout(() => ownerDied(name, seen, m.slice(name.length).trim()), 500);
    });

    bot.on('entitySleep', (e: any) => {
      if (e === bot.entity || e.type !== 'player' || !isPrimary(e.username)) return;
      const p = e.position.floored();
      bot.craftieHome = { x: p.x, y: p.y, z: p.z }; // the player's bed = home (and where they respawn)
      bot.emit('craftieMemoryChanged');
      playerSleepCbs.forEach((cb) => cb(e.username, { x: p.x, y: p.y, z: p.z }));
    });

    // Background follow: keep a safe distance from the player when there's nothing else to do.
    // Reflex: never drown. Low on air in water -> swim straight up, whatever else is going on.
    // Swimming: the bot library sinks and walks along the bottom. Instead, float and swim at the surface
    // (like a player holding space) unless the destination is underwater; and surface when low on air.
    let surfacing = false;
    // Runs every game tick, after the pathfinder (which resets the controls each tick), so it wins.
    bot.on('physicsTick', () => {
      if (!bot.entity) return;
      const air = bot.oxygenLevel ?? 20;
      const inWater = bot.entity.isInWater;
      if (inWater && air < 10 && !surfacing) { surfacing = true; console.log('[mc] low on air, surfacing'); }
      if (surfacing && (!inWater || air >= 19)) surfacing = false;
      // Sprinting in water switches to the horizontal "swimming" pose, which looks like flying.
      // Swim upright like a player holding W + space: no sprint in or just above water.
      const feet = bot.blockAt(bot.entity.position.offset(0, -0.2, 0))?.name;
      if (inWater || feet === 'water') bot.setControlState('sprint', false);
      if (!inWater) return;
      const goal = bot.pathfinder?.goal;
      let goalBelow = goal && typeof goal.y === 'number' && goal.y < bot.entity.position.y - 2;
      // Following someone who's swimming underwater: dive with them while there's plenty of air.
      // (Players dive by holding sneak; the bot's physics ignores sneak in water, so apply the
      //  same downward push directly, the way a sneaking swimmer sinks.)
      if (!goalBelow && followTarget && !goal && !surfacing) {
        const o = Object.values(bot.entities as Record<string, any>).find((x) => x.username === followTarget);
        // Only when they're actually in the water (not just lower down on a beach or hillside).
        const oInWater = o && ['water', 'bubble_column'].includes(bot.blockAt(o.position.offset(0, 0.5, 0))?.name ?? '');
        if (o && oInWater && o.position.y < bot.entity.position.y - 1.2 && air >= 10) {
          goalBelow = true;
          bot.setControlState('jump', false);
          bot.entity.velocity.y = Math.max(bot.entity.velocity.y - 0.04, -0.3);
        }
      }
      // Float at the surface like a player tapping space: push up only while the water is up to
      // the chest, let go once it's lower. Holding jump all the time makes it bob in and out.
      if (surfacing) bot.setControlState('jump', true);
      else if (!goalBelow) {
        const chest = bot.blockAt(bot.entity.position.offset(0, 1.1, 0))?.name === 'water';
        bot.setControlState('jump', chest || bot.entity.isCollidedHorizontally);
      }
    });

    /** Break natural blocks hemming us in (above, and toward the target). Never player-made ones. */
    const breakOut = async (toward: any): Promise<number> => {
      const me = bot.entity.position.floored();
      const d = toward.minus(bot.entity.position); const len = Math.hypot(d.x, d.z) || 1;
      const sx = Math.round(d.x / len), sz = Math.round(d.z / len);
      const spots = [me.offset(0, 2, 0), me.offset(0, 3, 0), me.offset(sx, 1, sz), me.offset(sx, 0, sz), me.offset(sx, 2, sz)];
      let n = 0;
      for (const p of spots) {
        const b = bot.blockAt(p);
        if (!b || b.boundingBox !== 'block' || ownerBuilt.has(`${p.x},${p.y},${p.z}`) || b.name === 'bedrock' || b.hardness < 0) continue;
        try { await bot.dig(b, true); n++; } catch {}
      }
      return n;
    };

    // Creative: fly with the player when they fly (or are far away), land when they land.
    let flying = false, flyBusy = false, flyNote = '', flyFails = 0, noFlyUntil = 0, lastFlyTp = 0;
    const groundBelow = (p: any) => { for (let dy = 0; dy < 6; dy++) { const b = bot.blockAt(p.offset(0, -dy - 0.5, 0)); if (b && b.boundingBox === 'block') return dy; } return 99; };
    setInterval(async () => {
      if (!followTarget || !bot.entity || bot.game.gameMode !== 'creative' || bot.craftiePause || flyBusy || Date.now() < noFlyUntil) {
        if (process.env.CRAFTIE_DEBUG && followTarget && bot.entity && Date.now() % 4000 < 400) console.log(`[mc] fly check: mode=${bot.game.gameMode} target=${followTarget} busy=${flyBusy}`);
        return;
      }
      const e = Object.values(bot.entities as Record<string, any>).find((x) => x.username === followTarget);
      if (!e) { if (process.env.CRAFTIE_DEBUG) console.log('[mc] fly check: player not visible'); return; }
      const airborne = groundBelow(e.position) >= 2, dist = e.position.distanceTo(bot.entity.position);
      const wellAbove = e.position.y - bot.entity.position.y > 2.5; // e.g. standing on a pillar
      if (airborne || wellAbove || (flying && dist > 6) || dist > 24) {
        if (bot.pathfinder.goal) bot.pathfinder.setGoal(null);
        // Aim 3 blocks behind the player, at their height.
        const back = bot.entity.position.minus(e.position); back.y = 0;
        const off = back.norm() > 0.1 ? back.normalize().scaled(3) : new Vec3(3, 0, 0);
        const target = e.position.plus(off).offset(0, 0.5, 0);
        if (target.distanceTo(bot.entity.position) < 2.5) return; // close enough: hold position
        flyBusy = true; flying = true;
        flyNote = `flying to ${target.floored()} (dist ${dist.toFixed(0)}) at ${new Date().toISOString().slice(11, 19)}`;
        // Far away and allowed to: just teleport to them (what a player with cheats would do).
        if (dist > 40 && canUseCommands(bot) && Date.now() - lastFlyTp > 8000) {
          lastFlyTp = Date.now(); flyBusy = false;
          bot.chat(`/tp ${bot.username} ${followTarget}`);
          return;
        }
        // Close: straight there. Far: up over the terrain, across, and down (never through hills).
        const before = bot.entity.position.clone();
        try { if (dist > 8) await flyRoute(bot, target); else await flyTo(bot, target, 2500); } finally { flyBusy = false; }
        // Didn't get anywhere (boxed in, or the server snapped us back): break out, then retry.
        if (bot.entity.position.distanceTo(before) < 1 && target.distanceTo(bot.entity.position) > 3) {
          const dug = await breakOut(target);
          if (dug) { flyNote += ` | broke ${dug} block(s) in the way`; return; }
          if (++flyFails >= 2) {
            flyFails = 0; flying = false; noFlyUntil = Date.now() + 4000; // walk a moment, then fly again
            try { bot.creative.stopFlying(); } catch {}
            console.log('[mc] flying is blocked here; walking for a bit');
          }
        } else flyFails = 0;
      } else if (flying && !airborne && !wellAbove && dist <= 6) {
        // Only land when there's ground right under us; otherwise hover next to the player
        // (stopping in mid-air means falling, then flying back up, over and over).
        if (groundBelow(bot.entity.position) <= 1) { flying = false; try { bot.creative.stopFlying(); } catch {} }
      }
    }, 400);

    let lastTp = 0, ownerDiedAt = 0, gettingBlocks = false;
    // Follow has two modes. "steer": walk/swim straight toward the player like a person would
    // (no pathfinder, nothing to get stuck on). "path": the pathfinder, only for climbing up to
    // them or going around obstacles, and re-planned as soon as they move.
    let glance: { e: any; until: number } | null = null;
    let mode: 'steer' | 'path' = 'steer', stuckSince = 0, lastDist = 0, pathUntil = 0, pathFrom: any = null;
    const ownerEntity = () => Object.values(bot.entities as Record<string, any>).find((x) => x.username === followTarget);
    const isFollowGoal = () => bot.pathfinder.goal instanceof (pf as any).goals.GoalFollow;
    const stopSteer = () => { bot.setControlState('forward', false); bot.setControlState('sprint', false); };
    const solidAt = (v: any) => { const b = bot.blockAt(v); return b && b.boundingBox === 'block'; };
    const dangerAt = (v: any) => /lava|fire|magma|cactus|powder_snow/.test(bot.blockAt(v)?.name ?? '');

    /** Turn the head toward a point gradually (maxStep radians per tick), like a player. */
    const lookSmooth = (p: any, maxStep: number, levelEyes = false) => {
      const eye = bot.entity.position.offset(0, 1.62, 0), d = p.minus(eye);
      const wantYaw = Math.atan2(-d.x, -d.z);
      let wantPitch = Math.atan2(d.y, Math.hypot(d.x, d.z));
      if (levelEyes) wantPitch = Math.max(-0.25, Math.min(0.15, wantPitch * 0.4));
      let dy = wantYaw - bot.entity.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy)); // shortest way round
      const dp = wantPitch - bot.entity.pitch;
      if (Math.abs(dy) < 0.02 && Math.abs(dp) < 0.02) return; // already there: don't jitter
      bot.look(bot.entity.yaw + Math.max(-maxStep, Math.min(maxStep, dy)), bot.entity.pitch + Math.max(-maxStep, Math.min(maxStep, dp)), true);
    };

    // Steering runs every tick, after the pathfinder, while following in steer mode.
    bot.on('physicsTick', () => {
      // Hovering/flying with the player (creative): still look at them.
      if (flying && followTarget && bot.entity && !bot.craftiePause) {
        const o = ownerEntity();
        if (o) lookSmooth(o.position.offset(0, 1.5, 0), 0.1);
        return;
      }
      if (mode !== 'steer' || !followTarget || !bot.entity || bot.craftiePause || flying || gettingBlocks) return;
      if (bot.pathfinder.goal && !isFollowGoal()) return; // a job is using the pathfinder
      const e = ownerEntity();
      if (!e) { stopSteer(); return; }
      const me = bot.entity.position, flat = Math.hypot(e.position.x - me.x, e.position.z - me.z);
      if (flat < gap) {
        stopSteer();
        // Mostly look at you; now and then glance at something interesting nearby, like a person would.
        if (!glance || Date.now() > glance.until) {
          const g = Math.random() < 0.004 ? glanceTarget(bot, followTarget) : null; // ~every 12s on average
          glance = g ? { e: g, until: Date.now() + 1500 + Math.random() * 1500 } : null;
        }
        if (glance && bot.entities[glance.e.id]) lookSmooth(glance.e.position.offset(0, glance.e.height ?? 1, 0), 0.08);
        else lookSmooth(e.position.offset(0, 1.5, 0), 0.08);
        return;
      }
      // Walking: face where we're going, eyes near the horizon (not staring at your face every tick).
      lookSmooth(e.position.offset(0, 1.2, 0), 0.25, true);
      // Look one step ahead: don't walk off a big drop or into lava; hop up single blocks.
      const yaw = bot.entity.yaw, ahead = me.offset(-Math.sin(yaw) * 0.8, 0, -Math.cos(yaw) * 0.8).floored();
      const waterAt = (v: any) => bot.blockAt(v)?.name === 'water';
      // Deep water ahead isn't a cliff: it's somewhere to swim.
      let drop = 0; while (drop < 5 && !solidAt(ahead.offset(0, -drop - 1, 0)) && !waterAt(ahead.offset(0, -drop - 1, 0)) && !waterAt(ahead.offset(0, -drop, 0)) && !bot.entity.isInWater) drop++;
      if ((drop >= 4 && e.position.y > me.y - drop + 1) || dangerAt(ahead) || dangerAt(ahead.offset(0, -1, 0))) { stopSteer(); mode = 'path'; pathUntil = Date.now() + 6000; return; }
      bot.setControlState('forward', true);
      bot.setControlState('sprint', flat > 8 && !bot.entity.isInWater && bot.blockAt(me.offset(0, -0.2, 0))?.name !== 'water');
      if ((solidAt(ahead) && !solidAt(ahead.offset(0, 1, 0)) && !solidAt(me.offset(0, 2, 0).floored())) || bot.entity.isCollidedHorizontally)
        bot.setControlState('jump', true);
      else if (!bot.entity.isInWater) bot.setControlState('jump', false); // in water the float reflex decides
    });

    // Who placed this block? If it appeared next to the player while they held a block, and nobody
    // else was closer, it's theirs. If a remembered block of theirs disappears, forget it.
    bot.on('blockUpdate', (oldB: any, newB: any) => {
      if (!newB || !primary) return;
      const k = `${newB.position.x},${newB.position.y},${newB.position.z}`;
      const wasEmpty = !oldB || ['air', 'cave_air', 'water', 'short_grass', 'grass', 'snow'].includes(oldB.name);
      if (newB.name === 'air' || newB.name === 'cave_air') { if (ownerBuilt.delete(k)) saveMemory(); return; }
      if (!wasEmpty || newB.boundingBox !== 'block') return;
      const center = newB.position.offset(0.5, 0.5, 0.5);
      const players = Object.values(bot.entities as Record<string, any>).filter((e) => e.type === 'player' && e !== bot.entity && e.position.offset(0, 1.6, 0).distanceTo(center) < 6);
      const nearest = players.sort((a, b) => a.position.distanceTo(center) - b.position.distanceTo(center))[0];
      if (!nearest || !isPrimary(nearest.username)) return;
      const held = nearest.heldItem?.name ?? nearest.equipment?.[0]?.name;
      if (held && !bot.registry.blocksByName[held] && !/(_bucket|_seeds|sapling)$/.test(held)) return;
      ownerBuilt.add(k);
      saveMemory();
    });

    // Stuck watchdog: should be moving (following, or a job walking somewhere) but hasn't for ~4s ->
    // look at what's around and take the cheapest way out.
    let lastPos: any = null, stillSince = 0, unsticking = false;
    setInterval(async () => {
      if (!bot.entity || unsticking || bot.craftiePause) return;
      const o = followTarget ? Object.values(bot.entities as Record<string, any>).find((x) => x.username === followTarget) : null;
      // Only while following you (jobs like building handle their own moves and limits; hovering to place blocks isn't "stuck").
      const jobGoal = bot.pathfinder?.goal && !(bot.pathfinder.goal instanceof (pf as any).goals.GoalFollow);
      const wantsToMove = !!o && !flying && !jobGoal && o.position.distanceTo(bot.entity.position) > gap + 3; // standing at our follow distance isn't stuck
      const pos = bot.entity.position;
      if (!wantsToMove || !lastPos || pos.distanceTo(lastPos) > 0.6) { lastPos = pos.clone(); stillSince = Date.now(); return; }
      if (Date.now() - stillSince < 4000) return;
      unsticking = true;
      try {
        const how = await unstick(o?.position ?? (bot.pathfinder?.goal && typeof bot.pathfinder.goal.x === 'number' ? new Vec3(bot.pathfinder.goal.x, bot.pathfinder.goal.y ?? pos.y, bot.pathfinder.goal.z) : null));
        console.log(`[mc] stuck -> ${how}`);
      } catch (e: any) { console.log('[mc] stuck, escape failed:', e.message); }
      finally { unsticking = false; stillSince = Date.now(); lastPos = bot.entity.position.clone(); }
    }, 1000);

    /** Work out why we're stuck and take the cheapest way out. Returns what it did. */
    const unstick = async (toward: any): Promise<string> => {
      const me = bot.entity.position.floored();
      if (bot.vehicle) { bot.dismount(); return 'got out of the vehicle'; }
      // Someone (a teammate, the player, a mob) standing in the way: step around them, never dig.
      const blocker = Object.values(bot.entities as Record<string, any>).find((e) => e !== bot.entity && e.position.distanceTo(bot.entity.position) < 1.5);
      if (blocker) {
        bot.setControlState(Math.random() < 0.5 ? 'left' : 'right', true); bot.setControlState('jump', true);
        await sleep(500); bot.setControlState('left', false); bot.setControlState('right', false); bot.setControlState('jump', false);
        return `stepped around ${blocker.username ?? blocker.name}`;
      }
      const around = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      const solid = (v: any) => { const b = bot.blockAt(v); return !!b && b.boundingBox === 'block'; };
      const mine = (v: any) => ownerBuilt.has(`${v.x},${v.y},${v.z}`);
      // 1. Sticky stuff at our feet/head: break it.
      for (const v of [me, me.offset(0, 1, 0)]) {
        const b = bot.blockAt(v);
        if (b && /cobweb|sweet_berry_bush|powder_snow|vine|kelp|tall_seagrass/.test(b.name)) { await bot.dig(b, true).catch(() => {}); return `broke ${b.name} I was caught in`; }
      }
      // 2. A closed door in the way (toward the target first): open it.
      const dir = toward ? toward.minus(bot.entity.position) : new Vec3(1, 0, 0);
      const order = around.sort(([ax, az], [bx, bz]) => (bx * dir.x + bz * dir.z) - (ax * dir.x + az * dir.z));
      for (const [x, z] of order) for (const y of [0, 1]) {
        const b = bot.blockAt(me.offset(x, y, z));
        if (b && /_door$|_gate$/.test(b.name) && !/iron_/.test(b.name) && !b.getProperties?.().open) { await bot.activateBlock(b).catch(() => {}); return `opened the ${b.name}`; }
      }
      const walls = order.filter(([x, z]) => solid(me.offset(x, 0, z)) || solid(me.offset(x, 1, z))).length;
      const ceiling = solid(me.offset(0, 2, 0));
      // 3. In a pit (walls around, sky above): go up.
      if (walls === 4 && !ceiling) {
        if (bot.game.gameMode === 'creative') { await flyTo(bot, bot.entity.position.offset(0, 3, 0), 2000); return 'flew up out of a pit'; }
        const blk = bot.inventory.items().find((i: any) => bot.pathfinder.movements.scafoldingBlocks.includes(i.type));
        if (blk) {
          await bot.equip(blk, 'hand');
          bot.setControlState('jump', true); await sleep(350);
          try { await bot.placeBlock(bot.blockAt(me.offset(0, -1, 0)), new Vec3(0, 1, 0)); } catch {}
          bot.setControlState('jump', false);
          return 'pillared up out of a pit';
        }
      }
      // 4. Boxed in (or the only ways are blocked): break the fewest blocks toward the target, never the player's own.
      for (const [x, z] of order) {
        const feet = me.offset(x, 0, z), head = me.offset(x, 1, z);
        if (mine(feet) || mine(head)) continue;
        const toBreak = [feet, head].filter((v) => solid(v) && (bot.blockAt(v)?.hardness ?? -1) >= 0);
        if (!toBreak.length) continue;
        for (const v of toBreak) { const b = bot.blockAt(v); if (b) { await bot.tool?.equipForBlock?.(b).catch?.(() => {}); await bot.dig(b, true).catch(() => {}); } }
        return `dug ${toBreak.length} block(s) to get out${toward ? ' toward you' : ''}`;
      }
      if (ceiling && !mine(me.offset(0, 2, 0))) { const b = bot.blockAt(me.offset(0, 2, 0)); if (b && b.hardness >= 0) { await bot.dig(b, true).catch(() => {}); return 'broke the block above me'; } }
      // 5. Nothing obvious: hop and sidestep, then the route gets re-planned.
      bot.pathfinder.setGoal(null);
      bot.setControlState('jump', true); bot.setControlState('left', true); await sleep(500);
      bot.setControlState('jump', false); bot.setControlState('left', false);
      return 'jumped and sidestepped, re-planning';
    };

    // Diagnostics: a small status file, so "where is it / what is it doing" can be answered from outside.
    setInterval(() => {
      if (!bot.entity) return;
      const o = followTarget ? Object.values(bot.entities as Record<string, any>).find((x) => x.username === followTarget) : null;
      const st = {
        at: new Date().toISOString(), pos: bot.entity.position.floored(), mode: bot.game.gameMode, health: bot.health, food: bot.food,
        following: followTarget, followMode: mode, flying, gettingBlocks, playerVisible: !!o,
        playerPos: o?.position.floored() ?? lastSeen.get(followTarget ?? '') ?? null,
        distance: o ? +o.position.distanceTo(bot.entity.position).toFixed(1) : null,
        flyNote, flyBusy, pathGoal: bot.pathfinder?.goal?.constructor?.name ?? null, moving: bot.pathfinder?.isMoving?.() ?? false, paused: !!bot.craftiePause,
      };
      try { writeFileSync(join(homedir(), '.craftie', cfg.helper ? `status-${bot.username}.json` : 'status.json'), JSON.stringify(st, null, 1)); } catch {}
    }, 3000);

    // Match the player's game mode (creative <-> survival) when cheats allow it.
    let toldNoCheats = false, lastModeSwitch = 0;
    setInterval(() => {
      if (!bot.entity || !primary) return;
      const me = Object.values(bot.players as Record<string, any>).find((p) => p.username?.toLowerCase() === primary);
      const want = ({ 0: 'survival', 1: 'creative' } as Record<number, string>)[me?.gamemode];
      if (!want || want === bot.game.gameMode || Date.now() - lastModeSwitch < 5000) return;
      if (!canUseCommands(bot)) {
        if (!toldNoCheats) { toldNoCheats = true; outQueue.push(`/msg ${me.username} You're in ${want} but I can't switch modes (cheats are off in this world).`); }
        return;
      }
      lastModeSwitch = Date.now();
      console.log(`[mc] ${me.username} is in ${want}: switching to ${want} too`);
      bot.chat(`/gamemode ${want}`);
    }, 2000);

    // Gear check while idle: best armor on and best weapon in hand, ready for trouble.
    let gearCheck = 0;
    bot.on('playerCollect', (collector: any) => { if (collector === bot.entity) gearCheck = 0; });
    setInterval(() => {
      if (Date.now() - gearCheck > 10_000 && followTarget && !bot.pathfinder?.goal && !bot.craftiePause && bot.entity && !bot.currentWindow) {
        gearCheck = Date.now();
        equipBest(bot).catch(() => {});
      }
    }, 1000);

    setInterval(() => {
      if (!followTarget || !bot.entity || bot.craftiePause || gettingBlocks || flying) { if (mode === 'steer') stopSteer(); return; }
      if (bot.pathfinder.goal && !isFollowGoal()) return; // a job is using the pathfinder
      const e = ownerEntity();
      if (e) {
        const me = bot.entity.position, dist = e.position.distanceTo(me);
        const above = e.position.y - me.y;
        const needClimb = above > 2.5 && bot.game.gameMode !== 'creative';
        // Steering that isn't getting closer (wall in the way) for 3s -> let the pathfinder route around.
        if (mode === 'steer' && dist > 4) {
          if (dist >= lastDist - 0.3) { stuckSince ||= Date.now(); if (Date.now() - stuckSince > 3000) { mode = 'path'; pathUntil = Date.now() + 8000; stopSteer(); } }
          else stuckSince = 0;
        }
        lastDist = dist;
        const wantPath = needClimb || dist > 12 || Date.now() < pathUntil;
        if (!wantPath) {
          if (mode === 'path') { if (isFollowGoal()) bot.pathfinder.setGoal(null); mode = 'steer'; stuckSince = 0; }
          return;
        }
        mode = 'path';
        if (dist <= gap + 1 && !needClimb) { if (isFollowGoal()) bot.pathfinder.setGoal(null); return; }
        // Climbing toward where they *were*? They moved or came down: drop the old plan right away.
        if (isFollowGoal() && pathFrom && (e.position.distanceTo(pathFrom) > 4 || (above < 1 && bot.pathfinder.isBuilding?.()))) { bot.pathfinder.setGoal(null); pathFrom = null; }
        if (needClimb) {
          const blocks = bot.inventory.items().filter((i: any) => bot.pathfinder.movements.scafoldingBlocks.includes(i.type)).reduce((n: number, i: any) => n + i.count, 0);
          if (blocks < above + 2) {
            // They climbed up and we have nothing to stack: dig a few dirt blocks nearby first.
            gettingBlocks = true;
            const dirt = bot.findBlocks({ matching: ['dirt', 'grass_block'].map((n) => bot.registry.blocksByName[n].id), maxDistance: 8, count: Math.ceil(above + 4) });
            console.log(`[mc] ${followTarget} went up ${Math.round(above)} blocks; grabbing ${dirt.length} dirt to climb after them`);
            // The mining library can wait forever on a drop it can't reach: never let that freeze following.
            const giveUp = new Promise<void>((r) => setTimeout(() => { try { bot.collectBlock.cancelTask?.(); } catch {} bot.pathfinder.stop(); r(); }, 15_000));
            Promise.race([bot.collectBlock.collect(dirt.map((p: any) => bot.blockAt(p)).filter(Boolean), { ignoreNoPath: true }).catch(() => {}), giveUp])
              .finally(() => { gettingBlocks = false; });
            return;
          }
        }
        if (!isFollowGoal()) { bot.pathfinder.setGoal(new (pf as any).goals.GoalFollow(e, gap), true); pathFrom = e.position.clone(); }
        return;
      }
      // Out of sight (far away, e.g. after one of us respawned): teleport if allowed, else walk to where we last saw them.
      if (canUseCommands(bot) && Date.now() - lastTp > 30000) { lastTp = Date.now(); bot.chat(`/tp ${bot.username} ${followTarget}`); return; }
      // They died recently: they respawn at their bed (or the world spawn), not where we last saw them.
      if (Date.now() - ownerDiedAt < 10 * 60_000) {
        const r = bot.craftieHome ?? bot.spawnPoint;
        if (r && bot.entity.position.distanceTo(new Vec3(r.x, r.y, r.z)) > 6) bot.pathfinder.setGoal(new (pf as any).goals.GoalNear(r.x, r.y, r.z, 3));
        return;
      }
      const seen = lastSeen.get(followTarget);
      if (seen && seen.dim === bot.game.dimension && bot.entity.position.distanceTo(new Vec3(seen.x, seen.y, seen.z)) > 8)
        bot.pathfinder.setGoal(new (pf as any).goals.GoalNear(seen.x, seen.y, seen.z, 3));
    }, 1000);

    // Reflex: report being hit so the brain can fight or flee.
    let lastHurt = 0;
    let lastGuard = 0;
    bot.on('entityHurt', (e: any, source?: any) => {
      // Someone hurt the player: defend them.
      if (e !== bot.entity && e?.type === 'player' && isPrimary(e.username)) {
        if (Date.now() - lastGuard < 1000) return;
        let attacker = source && source !== e && source !== bot.entity ? source : null;
        attacker ??= Object.values(bot.entities as Record<string, any>)
          .filter((x) => x !== bot.entity && x !== e && (x.type === 'hostile' || (x.type === 'player' && !isFriendly(x.username))) && x.position.distanceTo(e.position) < 5)
          .sort((a, b) => a.position.distanceTo(e.position) - b.position.distanceTo(e.position))[0];
        if (!attacker || (attacker.type === 'player' && isFriendly(attacker.username)) || attacker.type === 'projectile') return;
        if (attacker.position.distanceTo(bot.entity.position) > 32) return; // too far to help
        lastGuard = Date.now();
        dangerCbs.forEach((cb) => cb({ attacker: attacker.username ?? attacker.name, distance: attacker.position.distanceTo(bot.entity.position), health: bot.health, isPlayer: attacker.type === 'player', protecting: e.username }));
        return;
      }
      if (e !== bot.entity || Date.now() - lastHurt < 1000) return;
      const me = bot.entity.position;
      // 1.20+ says who did it; older versions: the nearest hostile mob or non-owner player.
      let attacker = source && source !== bot.entity ? source : null;
      if (attacker?.type === 'projectile' || attacker?.name === 'arrow') attacker = null;
      attacker ??= Object.values(bot.entities as Record<string, any>)
        .filter((x) => x !== bot.entity && (x.type === 'hostile' || (x.type === 'player' && !isFriendly(x.username))) && x.position.distanceTo(me) < 6)
        .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))[0];
      if (!attacker) return;
      if (attacker.type === 'player' && isFriendly(attacker.username)) return; // never fight back against you (or a teammate)
      lastHurt = Date.now();
      dangerCbs.forEach((cb) => cb({ attacker: attacker.username ?? attacker.name, distance: attacker.position.distanceTo(me), health: bot.health, isPlayer: attacker.type === 'player' }));
    });

    bot.on('kicked', (r: any) => {
      const why = typeof r === 'string' ? r : JSON.stringify(r);
      console.log('[mc] kicked:', why);
      if (/verify username|unverified_username|not authenticated|invalid session/i.test(why))
        console.log('[mc] This game only allows premium accounts. For your own world: Open to LAN with Online Mode OFF ' +
          '(Custom LAN mod). For a server: use "auth": "microsoft" with a real account.');
    });
    bot.on('error', (e: Error) => console.log('[mc] error:', e.message));
    bot.on('end', (why: string) => {
      console.log('[mc] disconnected:', why);
      if (!stopped && (cfg.autoReconnect ?? true)) setTimeout(connect, 5000);
    });
  }
  connect();

  return {
    describeState: () => (bot?.entity ? `${describe(bot)}\n${aroundUs(bot, primary || null)}` : 'not connected yet'),
    skillDocs: () => Object.values(skills).map((s) => '- ' + s.doc).join('\n'),
    async runSkill(name, args, signal) {
      const s = skills[name];
      if (!s) return `unknown skill "${name}"`;
      if (!bot?.entity) return 'not connected';
      return s.run(bot, args ?? {}, signal);
    },
    async interrupt(fn) {
      if (!bot?.entity) return;
      let release!: () => void;
      bot.craftieEpoch = (bot.craftieEpoch ?? 0) + 1;
      bot.craftiePause = new Promise<void>((r) => (release = r));
      bot.collectBlock?.cancelTask?.().catch?.(() => {});
      bot.pathfinder?.stop(); bot.pathfinder?.setGoal(null);
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 45000);
      try { await fn(ctl.signal); } catch {} finally { clearTimeout(timer); bot.craftiePause = null; release(); }
    },
    interruptCount: () => bot?.craftieEpoch ?? 0,
    waitIfPaused: async () => { while (bot?.craftiePause) await bot.craftiePause; },
    halt() {
      bot?.collectBlock?.cancelTask?.().catch?.(() => {});
      bot?.pathfinder?.stop(); bot?.pathfinder?.setGoal(null);
      bot?.pvp?.stop(); bot?.stopDigging?.(); bot?.clearControlStates?.();
    },
    say(text, privateTo) {
      const to = privateTo ?? (cfg.replyWhisper ? lastOwner : null);
      const room = to ? 220 - to.length : 240; // "/msg name " eats into the chat length limit
      for (const para of text.split('\n')) for (let i = 0; i < para.length; i += room) {
        const piece = para.slice(i, i + room);
        outQueue.push(to ? `/msg ${to} ${piece}` : piece);
      }
    },
    vocab: () => (bot?.entity ? vocab(bot) : { blocks: [], items: [], mobs: [], players: [] }),
    quit() { stopped = true; clearInterval(sendTimer); try { bot?.quit(); } catch {} },
    onCommand: (cb) => void commandCbs.push(cb),
    onDanger: (cb) => void dangerCbs.push(cb),
    onDeath: (cb) => void deathCbs.push(cb),
    onPlayerDeath: (cb) => void playerDeathCbs.push(cb),
    onPlayerSleep: (cb) => void playerSleepCbs.push(cb),
    nextChore: (skip) => (bot?.entity ? nextChore(bot, skip) : null),
    findTreasure: (owner) => (bot?.entity ? findTreasure(bot, owner) : null),
    scanAround: (owner) => (bot?.entity ? scanAround(bot, owner) : []),
    isNear: (player, blocks) => {
      const e = bot?.entity && Object.values(bot.entities as Record<string, any>).find((x) => x.username === player);
      return Boolean(e && e.position.distanceTo(bot.entity.position) <= blocks);
    },
    setFollow(player) {
      followTarget = player;
      if (!player && bot) { bot.pathfinder?.setGoal(null); bot.setControlState('forward', false); bot.setControlState('sprint', false); }
    },
  };
}
