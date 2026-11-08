import { anthropicLLM } from './anthropic.ts';
import { claudeCliLLM, codexCliLLM } from './cli.ts';
import { openaiLLM } from './openai.ts';
import type { LLM, ProviderConfig } from './types.ts';

export function makeLLM(name: string, c: ProviderConfig): LLM {
  switch (c.type) {
    case 'openai': return openaiLLM(name, c);
    case 'anthropic': return anthropicLLM(name, c);
    case 'claude-cli': return claudeCliLLM(name, c);
    case 'codex-cli': return codexCliLLM(name, c);
    default: throw new Error(`Unknown provider type "${(c as any).type}" for "${name}"`);
  }
}

export type { LLM, Msg, ProviderConfig } from './types.ts';
