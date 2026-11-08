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
import { skills } from './skills.ts';
import './autonomy.ts'; // adds obtain + build to skills
import { nextChore } from './chores.ts';

const { pathfinder, Movements } = pf as any;

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

  function handleIncoming(from: string, msg: string, whisper: boolean) {
    if (!bot || from === bot.username || !isOwner(from)) return;
    const key = from + '|' + msg;
    if ((recent.get(key) ?? 0) > Date.now() - 1500) return;
    recent.set(key, Date.now());
    if (recent.size > 100) recent = new Map([...recent].slice(-50));

    let text = msg.trim();
    if (!whisper) {
      // Accept any natural way of addressing the bot: "!ai", "ai", "!craftie", "Craftie,", "@Craftie" ...
      const names = [...new Set(['ai', 'craftie', bot.username.toLowerCase(), ...cfg.prefixes.map((p) => p.replace(/^[!@]/, '').toLowerCase())])]
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

  // Home + chest memory, saved per world (keyed by LAN world name or server address).
  let worldKey = '';
  const memFile = () => join(homedir(), '.craftie', 'worlds', worldKey.replace(/[^\w.-]+/g, '_') + '.json');
  const loadMemory = () => {
    try {
      const m = JSON.parse(readFileSync(memFile(), 'utf8'));
      bot.craftieHome = m.home ?? null;
      bot.craftieChests = new Map(Object.entries(m.chests ?? {}));
    } catch {}
  };
  let saveTimer: any;
  const saveMemory = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        mkdirSync(join(homedir(), '.craftie', 'worlds'), { recursive: true });
        writeFileSync(memFile(), JSON.stringify({ home: bot.craftieHome ?? null, chests: Object.fromEntries(bot.craftieChests ?? []) }, null, 1));
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
      outQueue.push(`Hi! I'm ${bot.username}. Type "${cfg.prefixes[0]} <anything>" in chat to give me a job, or "${cfg.prefixes[0]} stop".`);
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
    let surfacing = false, floating = false;
    setInterval(() => {
      if (!bot.entity) return;
      const air = bot.oxygenLevel ?? 20;
      const inWater = bot.entity.isInWater;
      if (inWater && air < 10 && !surfacing) { surfacing = true; console.log('[mc] low on air, surfacing'); }
      if (surfacing && (!inWater || air >= 19)) surfacing = false;
      const head = bot.blockAt(bot.entity.position.offset(0, 1.6, 0));
      const goal = bot.pathfinder?.goal;
      const goalBelow = goal && typeof goal.y === 'number' && goal.y < bot.entity.position.y - 2;
      const wantFloat = surfacing || (inWater && !goalBelow && (head?.name === 'water' || bot.pathfinder?.isMoving() || followTarget));
      if (wantFloat !== floating) { floating = !!wantFloat; bot.setControlState('jump', floating); }
      if (floating && inWater) bot.setControlState('sprint', true); // sprint-swim: faster, like players
    }, 150);

    // Creative: fly with the player when they fly (or are far away), land when they land.
    let flying = false, flyBusy = false;
    const groundBelow = (p: any) => { for (let dy = 0; dy < 6; dy++) { const b = bot.blockAt(p.offset(0, -dy - 0.5, 0)); if (b && b.boundingBox === 'block') return dy; } return 99; };
    setInterval(async () => {
      if (!followTarget || !bot.entity || bot.game.gameMode !== 'creative' || bot.craftiePause || flyBusy) {
        if (process.env.CRAFTIE_DEBUG && followTarget && bot.entity && Date.now() % 4000 < 400) console.log(`[mc] fly check: mode=${bot.game.gameMode} target=${followTarget} busy=${flyBusy}`);
        return;
      }
      const e = Object.values(bot.entities as Record<string, any>).find((x) => x.username === followTarget);
      if (!e) { if (process.env.CRAFTIE_DEBUG) console.log('[mc] fly check: player not visible'); return; }
      const airborne = groundBelow(e.position) >= 2, dist = e.position.distanceTo(bot.entity.position);
      if (airborne || (flying && dist > 6) || dist > 24) {
        if (bot.pathfinder.goal) bot.pathfinder.setGoal(null);
        // Aim 3 blocks behind the player, at their height.
        const back = bot.entity.position.minus(e.position); back.y = 0;
        const off = back.norm() > 0.1 ? back.normalize().scaled(3) : new Vec3(3, 0, 0);
        const target = e.position.plus(off).offset(0, 0.5, 0);
        if (target.distanceTo(bot.entity.position) < 2) return;
        flyBusy = true; flying = true;
        try { await bot.creative.flyTo(target); } catch (err: any) { if (process.env.CRAFTIE_DEBUG) console.log('[mc] flyTo failed:', err.message); } finally { flyBusy = false; }
      } else if (flying && !airborne && dist <= 6) {
        flying = false;
        try { bot.creative.stopFlying(); } catch {}
      }
    }, 400);

    let lastTp = 0, ownerDiedAt = 0, gettingBlocks = false;
    setInterval(() => {
      if (!followTarget || !bot.entity || bot.craftiePause || gettingBlocks || flying) return;
      // A follow goal that's stuck (e.g. couldn't climb) gets re-planned; other goals belong to a job.
      if (bot.pathfinder.isMoving() || (bot.pathfinder.goal && !(bot.pathfinder.goal instanceof (pf as any).goals.GoalFollow))) return;
      if (bot.pathfinder.goal && bot.pathfinder.goal.isEnd?.(bot.entity.position.floored())) return;
      const e = Object.values(bot.entities as Record<string, any>).find((x) => x.username === followTarget);
      if (e) {
        if (e.position.distanceTo(bot.entity.position) <= 5) return;
        const above = e.position.y - bot.entity.position.y;
        const blocks = bot.inventory.items().filter((i: any) => bot.pathfinder.movements.scafoldingBlocks.includes(i.type)).reduce((n: number, i: any) => n + i.count, 0);
        if (above > 3 && blocks < above + 2 && bot.game.gameMode !== 'creative' && !gettingBlocks) {
          // They climbed up and we have nothing to stack: dig a few dirt blocks nearby first.
          gettingBlocks = true;
          const dirt = bot.findBlocks({ matching: ['dirt', 'grass_block'].map((n) => bot.registry.blocksByName[n].id), maxDistance: 8, count: Math.ceil(above + 4) });
          console.log(`[mc] ${followTarget} went up ${Math.round(above)} blocks; grabbing ${dirt.length} dirt to climb after them`);
          bot.collectBlock.collect(dirt.map((p: any) => bot.blockAt(p)).filter(Boolean), { ignoreNoPath: true }).catch(() => {}).finally(() => { gettingBlocks = false; });
          return;
        }
        bot.pathfinder.setGoal(new (pf as any).goals.GoalFollow(e, 3), true);
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
          .filter((x) => x !== bot.entity && x !== e && (x.type === 'hostile' || (x.type === 'player' && !isPrimary(x.username))) && x.position.distanceTo(e.position) < 5)
          .sort((a, b) => a.position.distanceTo(e.position) - b.position.distanceTo(e.position))[0];
        if (!attacker || (attacker.type === 'player' && isPrimary(attacker.username)) || attacker.type === 'projectile') return;
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
        .filter((x) => x !== bot.entity && (x.type === 'hostile' || (x.type === 'player' && !isPrimary(x.username))) && x.position.distanceTo(me) < 6)
        .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))[0];
      if (!attacker) return;
      if (attacker.type === 'player' && isPrimary(attacker.username)) return; // never fight back against you
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
    describeState: () => (bot?.entity ? describe(bot) : 'not connected yet'),
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
    isNear: (player, blocks) => {
      const e = bot?.entity && Object.values(bot.entities as Record<string, any>).find((x) => x.username === player);
      return Boolean(e && e.position.distanceTo(bot.entity.position) <= blocks);
    },
    setFollow(player) { followTarget = player; if (!player) { bot?.pathfinder?.setGoal(null); } },
  };
}
