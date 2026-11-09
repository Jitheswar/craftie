// Several Crafties in one world: the main one plus helpers. Plain in-process registry, no AI:
// the main Craftie's AI can hand a job to a helper, and project steps are shared out between everyone.
export type Member = { name: string; helper: boolean; busy: () => boolean; command: (from: string, text: string) => void };

export class Team {
  private members = new Map<string, Member>();
  /** Live list of every Craftie's username (the bodies use it to never fight each other). */
  readonly names: string[] = [];

  add(m: Member) { this.members.set(m.name.toLowerCase(), m); if (!this.names.includes(m.name)) this.names.push(m.name); }
  remove(name: string) { this.members.delete(name.toLowerCase()); const i = this.names.indexOf(name); if (i >= 0) this.names.splice(i, 1); }
  helpers(): Member[] { return [...this.members.values()].filter((m) => m.helper); }

  /** Give a job to a helper by name, or "any" = the first free one. Returns who got it, or null. */
  send(to: string, from: string, task: string): string | null {
    const m = /^(any|anyone|helper)$/i.test(to) ? this.helpers().find((h) => !h.busy()) ?? this.helpers()[0] : this.members.get(to.toLowerCase());
    if (!m || !m.helper) return null;
    m.command(from, task);
    return m.name;
  }

  /** One line for the main AI's prompt. */
  line(): string {
    const hs = this.helpers();
    return hs.length ? `TEAM: ${hs.map((h) => `${h.name} (${h.busy() ? 'busy' : 'free'})`).join(', ')}` : '';
  }
}
