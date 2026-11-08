// Client for TypeSafe's System One API (Jev). Jev doesn't write text: it answers
// typed questions (noul = probability of yes, choice = one of your options)
// about a `state` you send. Docs: https://docs.typesafe.ai/go/api.md
export type NoulQ = { type: 'noul'; instructions: string; criteria?: { true?: string; false?: string } };
export type ChoiceQ = { type: 'choice'; instructions: string; criteria: Record<string, string | null> };
export type Question = NoulQ | ChoiceQ;

export type Answer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> };

export type JevConfig = { apiKey?: string; model?: string; baseUrl?: string; timeoutMs?: number };

export class Jev {
  private cfg: JevConfig;
  constructor(cfg: JevConfig) { this.cfg = cfg; }

  /** Throws on any failure: a failed call must never be read as a "no". */
  async ask(state: unknown, questions: Record<string, Question>): Promise<Record<string, Answer>> {
    const key = this.cfg.apiKey || process.env.TYPESAFE_API_KEY;
    if (!key) throw new Error('no TypeSafe API key');
    const res = await fetch(`${this.cfg.baseUrl ?? 'https://api.typesafe.ai'}/v1/systemone`, {
      method: 'POST',
      signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 3000),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: this.cfg.model ?? 'jev-latest', state, questions }),
    });
    if (!res.ok) throw new Error(`Jev HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return (await res.json()).answers;
  }
}

export const noul = (a: Answer | undefined) => (a?.type === 'noul' ? a.noul : NaN);
export const choice = (a: Answer | undefined) => (a?.type === 'choice' ? a.choice : undefined);
