// OpenAI-compatible chat API. Covers OpenAI, OpenRouter, DeepSeek, Groq,
// Ollama, LM Studio, llama.cpp, vLLM and anything else that speaks /chat/completions.
import { type LLM, type Msg, type ProviderConfig, resolveKey } from './types.ts';

export function openaiLLM(name: string, c: ProviderConfig): LLM {
  const base = (c.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  return {
    name,
    async complete(system: string, messages: Msg[], signal?: AbortSignal) {
      const key = resolveKey(c);
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/json',
          ...(key ? { authorization: `Bearer ${key}` } : {}),
          ...c.headers,
        },
        body: JSON.stringify({
          model: c.model,
          temperature: c.temperature ?? 0.2,
          max_tokens: c.maxTokens ?? 1024,
          messages: [{ role: 'system', content: system }, ...messages],
        }),
      });
      if (!res.ok) throw new Error(`${name}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
      const data: any = await res.json();
      return data.choices?.[0]?.message?.content ?? '';
    },
  };
}
