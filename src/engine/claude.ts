import { spawn } from 'node:child_process';
import type { Logger } from '../types';
import type { CodexRunResult } from './codex';

/**
 * Claude Code（claude -p 无头模式）作为 review 引擎。
 * 与 codex 的差异映射：
 * - 沙箱 → 工具白名单：read-only = 只读工具 + git 只读子命令；workspace-write（/fix）
 *   额外允许编辑类工具，但不放开任意 Bash（Claude Code 无 OS 级沙箱，保守处理）；
 * - 图片 → 追加到提示词让 agent 用 Read 工具查看（Read 原生支持图片）；
 * - 模型 → --model（profile 名即模型别名，如 claude:opus）。
 */
export interface ClaudeOptions {
  bin: string;
  timeoutMs: number;
  extraArgs: string[];
  /** 'workspace-write' = /fix 写模式；其余一律按只读处理 */
  sandbox: string;
  /** --model 的别名/全名；空 = 部署账号的默认模型 */
  model?: string;
  images?: string[];
  logger: Logger;
}

const READ_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  // 项目技能：bot 在 worktree 里工作，.claude/skills/ 会被 Claude Code 原生发现，
  // 放开 Skill 工具才能调用（技能内的动作仍受本白名单约束）
  'Skill',
  'Bash(git log:*)',
  'Bash(git show:*)',
  'Bash(git blame:*)',
  'Bash(git diff:*)',
  'Bash(git status:*)',
  'Bash(git branch:*)',
];
const WRITE_TOOLS = [...READ_TOOLS, 'Edit', 'Write', 'MultiEdit'];

export function buildClaudeArgs(opts: Pick<ClaudeOptions, 'sandbox' | 'model' | 'extraArgs'>): string[] {
  const tools = opts.sandbox === 'workspace-write' ? WRITE_TOOLS : READ_TOOLS;
  return [
    '-p',
    '--output-format',
    'json',
    '--allowedTools',
    ...tools,
    ...(opts.model && opts.model !== 'default' ? ['--model', opts.model] : []),
    ...opts.extraArgs,
  ];
}

export function buildClaudePrompt(prompt: string, images?: string[]): string {
  if (!images?.length) return prompt;
  return `${prompt}\n\n## 附件图片\n\n请先用 Read 工具查看以下图片再回答：\n${images.map((i) => `- ${i}`).join('\n')}`;
}

/** 解析 claude -p --output-format json 的 stdout */
export function parseClaudeJson(stdout: string): CodexRunResult {
  try {
    const obj = JSON.parse(stdout);
    if (obj && typeof obj === 'object' && typeof obj.result === 'string') {
      if (obj.is_error) return { ok: false, output: obj.result, error: `claude 报错: ${obj.result.slice(0, 500)}` };
      return { ok: true, output: obj.result };
    }
    return { ok: false, output: '', error: `claude 输出缺少 result 字段（subtype=${obj?.subtype}）` };
  } catch {
    return { ok: false, output: '', error: `claude 输出不是 JSON: ${stdout.slice(0, 300)}` };
  }
}

export async function runClaude(
  opts: ClaudeOptions,
  worktree: string,
  prompt: string,
): Promise<CodexRunResult> {
  const args = buildClaudeArgs(opts);
  const fullPrompt = buildClaudePrompt(prompt, opts.images);

  try {
    const { code, timedOut, stdout, stderr } = await new Promise<{
      code: number | null;
      timedOut: boolean;
      stdout: string;
      stderr: string;
    }>((resolve, reject) => {
      const child = spawn(opts.bin, args, { cwd: worktree, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, opts.timeoutMs);
      child.stdout.on('data', (d) => {
        if (out.length < 4_000_000) out += String(d);
      });
      child.stderr.on('data', (d) => {
        if (err.length < 20_000) err += String(d);
      });
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on('close', (c) => {
        clearTimeout(timer);
        resolve({ code: c, timedOut, stdout: out, stderr: err });
      });
      child.stdin.write(fullPrompt);
      child.stdin.end();
    });

    if (timedOut) return { ok: false, output: '', error: `claude 超时（${opts.timeoutMs}ms）` };
    if (code !== 0) {
      // 真实错误在 stderr 末尾（同 codex 的经验）
      return { ok: false, output: '', error: `claude 退出码 ${code}: ${stderr.slice(-1000)}` };
    }
    return parseClaudeJson(stdout);
  } catch (err) {
    return { ok: false, output: '', error: `claude 启动失败: ${String(err)}` };
  }
}
