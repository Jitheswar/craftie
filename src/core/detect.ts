// Figure out which AIs this PC can already use, so the user just picks one.
import { execFile } from 'node:child_process';

export type DetectedAI = { id: string; label: string; ready: boolean; note: string; models?: string[] };

const has = (cmd: string) => new Promise<boolean>((res) =>
  execFile(cmd, ['--version'], { timeout: 8000, shell: process.platform === 'win32' }, (err) => res(!err)));

async function getJson(url: string): Promise<any> {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(1500) }); return r.ok ? await r.json() : null; } catch { return null; }
}

export async function detectAIs(): Promise<DetectedAI[]> {
  const [claude, codex, ollama, lms] = await Promise.all([
    has('claude'), has('codex'),
    getJson('http://localhost:11434/api/tags'),
    getJson('http://localhost:1234/v1/models'),
  ]);
  const env = (k: string) => Boolean(process.env[k]);
  return [
    { id: 'claude-sub', label: 'Claude (my subscription)', ready: claude,
      note: claude ? 'Claude Code found on this PC' : 'Install Claude Code and log in with your Claude account' },
    { id: 'codex-sub', label: 'ChatGPT / Codex (my subscription)', ready: codex,
      note: codex ? 'Codex found on this PC' : 'Install Codex CLI and log in with your ChatGPT account' },
    { id: 'ollama', label: 'Free local AI (Ollama)', ready: Boolean(ollama?.models?.length),
      note: ollama ? (ollama.models.length ? 'Running on this PC' : 'Running, but no models yet: run "ollama pull qwen3:8b"') : 'Install Ollama from ollama.com (free, runs offline)',
      models: ollama?.models?.map((m: any) => m.name) },
    { id: 'lmstudio', label: 'Local AI (LM Studio)', ready: Boolean(lms?.data?.length),
      note: lms ? 'Running on this PC' : 'Start LM Studio\'s local server', models: lms?.data?.map((m: any) => m.id) },
    { id: 'claude-api', label: 'Claude API key', ready: env('ANTHROPIC_API_KEY'), note: 'Paste a key from console.anthropic.com' },
    { id: 'openai', label: 'OpenAI API key', ready: env('OPENAI_API_KEY'), note: 'Paste a key from platform.openai.com' },
    { id: 'openrouter', label: 'OpenRouter API key', ready: env('OPENROUTER_API_KEY'), note: 'One key, hundreds of models (openrouter.ai)' },
    { id: 'deepseek', label: 'DeepSeek API key', ready: env('DEEPSEEK_API_KEY'), note: 'Cheap and capable (platform.deepseek.com)' },
    { id: 'custom', label: 'Other (any OpenAI-compatible URL)', ready: false, note: 'For advanced users' },
  ];
}
