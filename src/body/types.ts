// A "body" is any game the brain can drive. Minecraft Java (via Mineflayer) is
// the first one; Bedrock or a totally different game can be added by
// implementing this same interface.
export type Danger = { attacker: string; distance: number; health: number; isPlayer: boolean; protecting?: string };
export type Death = { x: number; y: number; z: number; cause: string; dimension: string };

export interface Body {
  /** Short text snapshot of the world the AI needs to decide its next step. */
  describeState(): string;
  /** Documentation of every skill, shown to the AI in its system prompt. */
  skillDocs(): string;
  runSkill(name: string, args: Record<string, any>, signal: AbortSignal): Promise<string>;
  /** Cancel every movement/action immediately. */
  halt(): void;
  /** Chat. With `privateTo`, it goes as a private message only that player sees. */
  say(text: string, privateTo?: string | null): void;
  /** Pause whatever is running, do fn (e.g. a fight), then let the paused job carry on. */
  interrupt(fn: (signal: AbortSignal) => Promise<unknown>): Promise<void>;
  /** Number of interrupts so far; tells the brain an action failed only because it was paused. */
  interruptCount(): number;
  waitIfPaused(): Promise<void>;
  /** Disconnect for good. */
  quit(): void;

  /** Names of things around the bot, used as exact options for the fast router. */
  vocab(): { blocks: string[]; items: string[]; mobs: string[]; players: string[]; creative?: boolean };

  /** private = it came as a private message (/msg), so replies should be private too. */
  onCommand(cb: (from: string, text: string, isPrivate: boolean) => void): void;
  onDanger(cb: (d: Danger) => void): void;
  /** Fires when an owner (player) dies: where, so their items can be fetched. */
  onPlayerDeath(cb: (player: string, d: Death) => void): void;
  /** Fires when an owner gets into bed (so the bot can sleep too: night only skips when everyone sleeps). */
  onPlayerSleep(cb: (player: string, bed: { x: number; y: number; z: number }) => void): void;
  /** The next thing Craftie should get for itself (food, tools, armor, a bed...), or null if all set. */
  nextChore(skip: Set<string>): { item: string; count: number; why: string } | null;
  /** Something valuable nearby: grab it (safe and close) or report it (deep/risky). */
  findTreasure(owner: string | null): any;
  /** Is this player close by (so chores don't drag Craftie away from them)? */
  isNear(player: string, blocks: number): boolean;
  /** Keep near this player at a safe distance in the background (null = stop). */
  setFollow(player: string | null): void;
  /** Fires after the bot dies and has respawned. */
  onDeath(cb: (d: Death) => void): void;
}
