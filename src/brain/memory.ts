// Craftie's memory: everything is kept in SQLite (~/.craftie/craftie.db), but each request
// only gets a small, relevant slice, so requests stay cheap no matter how long you play.
//
//   turns     every chat line, grouped into sessions (a new session after 20 idle minutes)
//   summaries a few sentences per session for the older lines (folded with one small call)
//   activity  one line per finished job ("built cottage at 1,2,3 -> done")
//   facts     short lasting facts the AI chose to remember ("likes spruce builds")
//   mem_fts   full-text index over all of the above, for "find what's relevant to this message"
//
// Facts are free: the AI adds "remember"/"forget" inside its normal reply.
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { LLM } from '../llm/index.ts';

const MAX_UNFOLDED = 16;   // when a session has more unsummarised lines than this...
const KEEP_RECENT = 6;     // ...fold all but the newest few into the session summary
const SESSION_GAP = 20 * 60_000;
const MAX_FACTS = 200;     // stored; only the relevant/newest few are ever sent

const ago = (t: number) => { const m = Math.round((Date.now() - t) / 60_000); return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };

let shared: DatabaseSync | null = null;
function open(): DatabaseSync {
  if (shared) return shared;
  const dir = join(homedir(), '.craftie');
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, 'craftie.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS turns (id INTEGER PRIMARY KEY, player TEXT, session INTEGER, who TEXT, text TEXT, at INTEGER, folded INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS summaries (player TEXT, session INTEGER, text TEXT, at INTEGER, PRIMARY KEY (player, session));
    CREATE TABLE IF NOT EXISTS activity (id INTEGER PRIMARY KEY, player TEXT, text TEXT, at INTEGER);
    CREATE TABLE IF NOT EXISTS facts (id INTEGER PRIMARY KEY, player TEXT, text TEXT, at INTEGER, UNIQUE (player, text));
    CREATE VIRTUAL TABLE IF NOT EXISTS mem_fts USING fts5(kind UNINDEXED, ref UNINDEXED, player UNINDEXED, text);
    CREATE INDEX IF NOT EXISTS turns_ps ON turns (player, session, folded);
  `);
  return (shared = db);
}

/** Turn a message into a safe full-text query: its meaningful words, OR-ed. */
function ftsQuery(text: string): string | null {
  const stop = new Set(['the', 'and', 'you', 'are', 'was', 'what', 'where', 'did', 'have', 'has', 'for', 'with', 'that', 'this', 'can', 'craftie', 'please', 'pls', 'your', 'my', 'me']);
  const words = [...new Set(text.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? [])].filter((w) => !stop.has(w)).slice(0, 12);
  return words.length ? words.map((w) => `"${w}"`).join(' OR ') : null;
}

export class Memory {
  private db = open();
  private player: string;
  private llm: LLM;
  private session = 0;
  private folding = false;
  /** When the AI is paused to save usage, don't spend a call on folding (it waits until resume). */
  paused = false;

  constructor(player: string, llm: LLM) {
    this.player = player || 'player';
    this.llm = llm;
    this.importOldJson();
    const last = this.db.prepare('SELECT session, MAX(at) at FROM turns WHERE player = ?').get(this.player) as any;
    // Continue the last session only if it was recent; otherwise this is a new one.
    this.session = last?.session != null && Date.now() - last.at < SESSION_GAP ? last.session : (last?.session ?? 0) + 1;
  }

  private index(kind: string, ref: number | bigint, text: string) {
    this.db.prepare('INSERT INTO mem_fts (kind, ref, player, text) VALUES (?, ?, ?, ?)').run(kind, Number(ref), this.player, text);
  }

  /** One-time import of the older JSON memory file. */
  private importOldJson() {
    const f = join(homedir(), '.craftie', 'memory', `${this.player.replace(/[^\w.-]+/g, '_')}.json`);
    if (!existsSync(f)) return;
    try {
      const d = JSON.parse(readFileSync(f, 'utf8'));
      for (const x of d.facts ?? []) this.remember([x.text]);
      for (const a of d.activity ?? []) { const r = this.db.prepare('INSERT INTO activity (player, text, at) VALUES (?, ?, ?)').run(this.player, a.text, a.at); this.index('activity', r.lastInsertRowid, a.text); }
      if (d.summary || d.lastSummary) this.db.prepare('INSERT OR REPLACE INTO summaries VALUES (?, 0, ?, ?)').run(this.player, d.summary || d.lastSummary, Date.now());
      renameSync(f, f + '.imported');
    } catch {}
  }

  private touchSession() {
    const last = this.db.prepare('SELECT MAX(at) at FROM turns WHERE player = ? AND session = ?').get(this.player, this.session) as any;
    if (last?.at && Date.now() - last.at > SESSION_GAP) this.session++; // long pause: start a new session
  }

  addTurn(who: string, text: string) {
    this.touchSession();
    const t = text.slice(0, 300);
    const r = this.db.prepare('INSERT INTO turns (player, session, who, text, at) VALUES (?, ?, ?, ?, ?)').run(this.player, this.session, who, t, Date.now());
    this.index('turn', r.lastInsertRowid, `${who}: ${t}`);
    const n = (this.db.prepare('SELECT COUNT(*) n FROM turns WHERE player = ? AND session = ? AND folded = 0').get(this.player, this.session) as any).n;
    if (n > MAX_UNFOLDED && !this.paused) this.fold().catch(() => {});
  }

  /** Squeeze older lines of this session into its summary. The lines stay on disk (still searchable). */
  private async fold() {
    if (this.folding) return;
    this.folding = true;
    try {
      const rows = this.db.prepare('SELECT id, who, text FROM turns WHERE player = ? AND session = ? AND folded = 0 ORDER BY id').all(this.player, this.session) as any[];
      const old = rows.slice(0, rows.length - KEEP_RECENT);
      if (!old.length) return;
      const prev = (this.db.prepare('SELECT text FROM summaries WHERE player = ? AND session = ?').get(this.player, this.session) as any)?.text ?? '';
      const out = await this.llm.complete(
        'You compress chat logs. Reply with 1-3 plain sentences keeping only what matters later (decisions, requests, promises, names, places). No preamble.',
        [{ role: 'user', content: `Summary so far: ${prev || '(none)'}\n\nNew lines:\n${old.map((t) => `${t.who}: ${t.text}`).join('\n')}\n\nUpdated summary:` }],
        AbortSignal.timeout(60_000),
      );
      const text = out.trim().replace(/^["']|["']$/g, '').slice(0, 700);
      this.db.prepare('INSERT OR REPLACE INTO summaries VALUES (?, ?, ?, ?)').run(this.player, this.session, text, Date.now());
      this.db.prepare(`UPDATE turns SET folded = 1 WHERE id IN (${old.map((t) => t.id).join(',')})`).run();
    } finally { this.folding = false; }
  }

  setLLM(llm: LLM) { this.llm = llm; }

  /** What Craftie did, in one line. Lets it answer "what were you doing?". */
  logActivity(text: string) {
    const t = text.slice(0, 160);
    const r = this.db.prepare('INSERT INTO activity (player, text, at) VALUES (?, ?, ?)').run(this.player, t, Date.now());
    this.index('activity', r.lastInsertRowid, t);
  }

  remember(facts: unknown) {
    if (!Array.isArray(facts)) return;
    for (const f of facts) {
      const text = String(f).trim().slice(0, 160);
      if (!text) continue;
      const had = this.db.prepare('SELECT id FROM facts WHERE player = ? AND text = ?').get(this.player, text) as any;
      if (had) { this.db.prepare('UPDATE facts SET at = ? WHERE id = ?').run(Date.now(), had.id); continue; } // already known: just refresh
      const r = this.db.prepare('INSERT INTO facts (player, text, at) VALUES (?, ?, ?)').run(this.player, text, Date.now());
      this.index('fact', r.lastInsertRowid, text);
    }
    // Over the cap: drop the facts confirmed longest ago.
    this.db.prepare(`DELETE FROM facts WHERE player = ? AND id NOT IN (SELECT id FROM facts WHERE player = ? ORDER BY at DESC LIMIT ${MAX_FACTS})`).run(this.player, this.player);
  }

  forget(patterns: unknown) {
    if (!Array.isArray(patterns)) return;
    for (const p of patterns) {
      const q = String(p).toLowerCase().trim();
      if (!q) continue;
      const gone = this.db.prepare('SELECT id FROM facts WHERE player = ? AND LOWER(text) LIKE ?').all(this.player, `%${q}%`) as any[];
      for (const g of gone) {
        this.db.prepare('DELETE FROM facts WHERE id = ?').run(g.id);
        this.db.prepare("DELETE FROM mem_fts WHERE kind = 'fact' AND ref = ?").run(g.id);
      }
    }
  }

  /** Best matches for this message across all of history (BM25 ranked). */
  private search(query: string | null, kind: string, limit: number): { ref: number; text: string }[] {
    if (!query) return [];
    try {
      return this.db.prepare('SELECT ref, text FROM mem_fts WHERE mem_fts MATCH ? AND kind = ? AND player = ? ORDER BY bm25(mem_fts) LIMIT ?')
        .all(query, kind, this.player, limit) as any[];
    } catch { return []; }
  }

  /** The compact block sent with a request: recent context plus what's relevant to `message`. */
  block(message = ''): string {
    const q = ftsQuery(message);
    const parts: string[] = [];

    // Facts: relevant ones first, then the newest, max 10.
    const rel = this.search(q, 'fact', 6).filter((r) => this.db.prepare('SELECT 1 FROM facts WHERE id = ?').get(r.ref)).map((r) => r.text);
    const recentFacts = (this.db.prepare('SELECT text FROM facts WHERE player = ? ORDER BY at DESC LIMIT 6').all(this.player) as any[]).map((r) => r.text);
    const facts = [...new Set([...rel, ...recentFacts])].slice(0, 10);
    if (facts.length) parts.push('LONG-TERM MEMORY:\n' + facts.map((f) => `- ${f}`).join('\n'));

    // Activity: newest 5, plus older ones that match the message.
    const recentAct = this.db.prepare('SELECT id, text, at FROM activity WHERE player = ? ORDER BY id DESC LIMIT 5').all(this.player) as any[];
    const ids = new Set(recentAct.map((a) => a.id));
    const oldAct = this.search(q, 'activity', 3).filter((r) => !ids.has(r.ref))
      .map((r) => this.db.prepare('SELECT text, at FROM activity WHERE id = ?').get(r.ref) as any).filter(Boolean);
    const acts = [...recentAct, ...oldAct];
    if (acts.length) parts.push('WHAT I DID (newest first):\n' + acts.map((a) => `- ${ago(a.at)}: ${a.text}`).join('\n'));

    // Summaries: this session's, or the last session's when we've just started a new one.
    const cur = this.db.prepare('SELECT text FROM summaries WHERE player = ? AND session = ?').get(this.player, this.session) as any;
    const unfolded = this.db.prepare('SELECT who, text FROM turns WHERE player = ? AND session = ? AND folded = 0 ORDER BY id DESC LIMIT 8').all(this.player, this.session) as any[];
    if (cur?.text) parts.push(`EARLIER THIS SESSION: ${cur.text}`);
    else if (unfolded.length < 3) {
      const prev = this.db.prepare('SELECT text FROM summaries WHERE player = ? AND session < ? ORDER BY session DESC LIMIT 1').get(this.player, this.session) as any;
      if (prev?.text) parts.push(`LAST SESSION: ${prev.text}`);
    }

    // Older chat lines that match this message (from any session).
    const seen = new Set(unfolded.map((t) => `${t.who}: ${t.text}`));
    const oldChat = this.search(q, 'turn', 3).map((r) => r.text).filter((t) => !seen.has(t));
    if (oldChat.length) parts.push('RELATED OLDER CHAT:\n' + oldChat.map((t) => `- ${t}`).join('\n'));

    if (unfolded.length) parts.push('RECENT CHAT:\n' + unfolded.reverse().map((t) => `${t.who}: ${t.text}`).join('\n'));
    return parts.join('\n\n') || 'MEMORY: (nothing yet)';
  }
}
