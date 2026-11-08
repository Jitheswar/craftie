export type Msg = { role: 'user' | 'assistant'; content: string };

/** Every backend (API, subscription CLI, local) reduces to this one call. */
export interface LLM {
  name: string;
  complete(system: string, messages: Msg[], signal?: AbortSignal): Promise<string>;
}

export type ProviderConfig = {
  type: 'openai' | 'anthropic' | 'claude-cli' | 'codex-cli';
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  maxTokens?: number;
  temperature?: number;
  headers?: Record<string, string>;
};

export function resolveKey(c: ProviderConfig): string | undefined {
  return c.apiKey ?? (c.apiKeyEnv ? process.env[c.apiKeyEnv] : undefined);
}
