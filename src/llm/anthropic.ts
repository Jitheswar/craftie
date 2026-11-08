// Claude API (pay-per-use key from console.anthropic.com).
import { type LLM, type Msg, type ProviderConfig, resolveKey } from './types.ts';

export function anthropicLLM(name: string, c: ProviderConfig): LLM {
  const base = (c.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '');
  return {
    name,
    async complete(system: string, messages: Msg[], signal?: AbortSignal) {
      const res = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': resolveKey(c) ?? '',
          'anthropic-version': '2023-06-01',
          ...c.headers,
        },
        body: JSON.stringify({
          model: c.model ?? 'claude-sonnet-5-5',
          max_tokens: c.maxTokens ?? 1024,
          // Cache the long, unchanging system prompt to cut cost and latency.
          system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
          messages,
        }),
      });
      if (!res.ok) throw new Error(`${name}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
      const data: any = await res.json();
      return (data.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
    },
  };
}
