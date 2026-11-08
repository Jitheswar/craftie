// Subscription backends: drive the official `claude` and `codex` CLIs, which
// use whatever plan you're logged into (Claude Pro/Max, ChatGPT Plus/Pro).
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LLM, Msg, ProviderConfig } from './types.ts';

// On Windows, npm-installed CLIs are .cmd files that must go through cmd.exe, with every argument quoted.
const winQuote = (a: string) => `"${a.replace(/"/g, '""')}"`;

function run(cmd: string, args: string[], input: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = process.platform === 'win32'
      ? spawn('cmd.exe', ['/d', '/s', '/c', `"${[cmd, ...args].map(winQuote).join(' ')}"`], { stdio: ['pipe', 'pipe', 'pipe'], signal, windowsVerbatimArguments: true })
      : spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], signal });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}: ${err.slice(0, 300)}`))));
    p.stdin.end(input);
  });
}

// The CLIs are one-shot, so the conversation is flattened into one prompt.
function transcript(messages: Msg[]): string {
  return messages.map((m) => `### ${m.role.toUpperCase()}\n${m.content}`).join('\n\n') + '\n\n### ASSISTANT\n';
}

export function claudeCliLLM(name: string, c: ProviderConfig): LLM {
  return {
    name,
    async complete(system, messages, signal) {
      // Windows only: long text with quotes/newlines doesn't survive its command line, so use a file there.
      const win = process.platform === 'win32';
      const dir = win ? mkdtempSync(join(tmpdir(), 'craftie-claude-')) : '';
      if (win) writeFileSync(join(dir, 'system.txt'), system);
      const args = [
        '-p', '--output-format', 'json',
        ...(win ? ['--system-prompt-file', join(dir, 'system.txt')] : ['--system-prompt', system]),
        '--tools', '',               // no file/shell tools: we only want text back
        '--strict-mcp-config',
        '--setting-sources', '',
        '--no-session-persistence',
      ];
      if (c.model) args.push('--model', c.model);
      try {
        const raw = await run('claude', args, transcript(messages), signal);
        try { return JSON.parse(raw).result ?? raw; } catch { return raw; }
      } finally { if (dir) rmSync(dir, { recursive: true, force: true }); }
    },
  };
}

export function codexCliLLM(name: string, c: ProviderConfig): LLM {
  return {
    name,
    async complete(system, messages, signal) {
      const dir = mkdtempSync(join(tmpdir(), 'craftie-codex-'));
      const outFile = join(dir, 'last.txt');
      try {
        const args = ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '-C', dir, '--output-last-message', outFile];
        if (c.model) args.push('-m', c.model);
        args.push('-');  // read prompt from stdin
        await run('codex', args, `${system}\n\n${transcript(messages)}`, signal);
        return readFileSync(outFile, 'utf8');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
