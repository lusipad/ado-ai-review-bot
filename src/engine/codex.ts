import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Finding, Logger, ReviewOutput, Severity } from '../types';

export interface CodexOptions {
  bin: string;
  sandbox: string;
  timeoutMs: number;
  extraArgs: string[];
  /** codex config.toml 里的 profile 名；'default' 或空 = 不传 -p（用默认配置） */
  profile?: string;
  /** 附加图片文件路径（codex -i，需模型支持视觉） */
  images?: string[];
  /** 在非 git 目录运行（dream 整理等纯文本任务） */
  skipGitCheck?: boolean;
  logger: Logger;
}

export interface CodexRunResult {
  ok: boolean;
  /** --output-last-message 文件内容（模型最终答复） */
  output: string;
  error?: string;
}

/**
 * codex exec 无头模式封装。提示词经 stdin 传入（避免命令行长度限制与转义问题），
 * 结果从 --output-last-message 指定的文件读取。
 */
export async function runCodex(
  opts: CodexOptions,
  worktree: string,
  prompt: string,
): Promise<CodexRunResult> {
  const outFile = path.join(
    os.tmpdir(),
    `codex-out-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
  );
  const args = [
    'exec',
    '--sandbox',
    opts.sandbox,
    '-C',
    worktree,
    '--output-last-message',
    outFile,
    ...(opts.profile && opts.profile !== 'default' ? ['-p', opts.profile] : []),
    ...(opts.skipGitCheck ? ['--skip-git-repo-check'] : []),
    ...(opts.images ?? []).flatMap((img) => ['-i', img]),
    ...opts.extraArgs,
    '-', // 从 stdin 读提示词
  ];

  try {
    const exitInfo = await new Promise<{ code: number | null; timedOut: boolean; stderr: string }>(
      (resolve, reject) => {
        const child = spawn(opts.bin, args, { stdio: ['pipe', 'ignore', 'pipe'] });
        let stderr = '';
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, opts.timeoutMs);
        child.stderr.on('data', (d) => {
          if (stderr.length < 20_000) stderr += String(d);
        });
        child.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          resolve({ code, timedOut, stderr });
        });
        child.stdin.write(prompt);
        child.stdin.end();
      },
    );

    const output = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : '';
    if (exitInfo.timedOut) return { ok: false, output, error: `codex 超时（${opts.timeoutMs}ms）` };
    if (exitInfo.code !== 0)
      return {
        ok: false,
        output,
        // stderr 开头是 codex 的 banner 和提示词回显，真实错误在末尾
        error: `codex 退出码 ${exitInfo.code}: ${exitInfo.stderr.slice(-1000)}`,
      };
    if (!output.trim()) return { ok: false, output, error: 'codex 没有产生输出' };
    return { ok: true, output };
  } catch (err) {
    return { ok: false, output: '', error: `codex 启动失败: ${String(err)}` };
  } finally {
    fs.rmSync(outFile, { force: true });
  }
}

const SEVERITIES: Severity[] = ['must-fix', 'suggestion', 'nit'];

/** JSON 候选：```json 围栏块（后出现的优先）→ 整体就是 JSON → 最后一个平衡的 {...} */
function jsonCandidates(raw: string): string[] {
  const candidates: string[] = [];
  const fenceMatches = [...raw.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)];
  for (const m of fenceMatches.reverse()) candidates.push(m[1]);
  candidates.push(raw.trim());
  const lastBrace = extractLastJsonObject(raw);
  if (lastBrace) candidates.push(lastBrace);
  return candidates;
}

/**
 * 从模型输出中提取结构化 review 结果。
 * 全部候选解析失败 → degraded 模式，原文作为 summary。
 */
export function parseReviewOutput(raw: string): ReviewOutput {
  for (const c of jsonCandidates(raw)) {
    try {
      const obj = JSON.parse(c);
      if (obj && typeof obj === 'object' && typeof obj.summary === 'string') {
        return {
          summary: obj.summary,
          walkthrough: typeof obj.walkthrough === 'string' ? obj.walkthrough : undefined,
          riskLevel: typeof obj.riskLevel === 'string' ? obj.riskLevel : undefined,
          reviewerGuide: typeof obj.reviewerGuide === 'string' ? obj.reviewerGuide : undefined,
          repoMemories: sanitizeMemories(obj.repoMemories),
          findings: sanitizeFindings(obj.findings),
          resolvedThreadIds: Array.isArray(obj.resolvedThreadIds)
            ? obj.resolvedThreadIds.filter((n: unknown) => Number.isInteger(n))
            : [],
          degraded: false,
        };
      }
    } catch {
      // 尝试下一个候选
    }
  }

  return { summary: raw.trim(), findings: [], resolvedThreadIds: [], degraded: true };
}

export type ChallengeVerdict = {
  index: number;
  verdict: 'confirmed' | 'uncertain' | 'wrong';
  reason?: string;
};

/**
 * 解析质疑 pass 的输出：{"verdicts":[{index, verdict, reason}]}。
 * 解析失败返回 undefined（调用方 fail-open：保留全部 findings）。
 */
export function parseChallengeVerdicts(raw: string): ChallengeVerdict[] | undefined {
  const VERDICTS = ['confirmed', 'uncertain', 'wrong'];
  for (const c of jsonCandidates(raw)) {
    try {
      const obj = JSON.parse(c);
      if (obj && typeof obj === 'object' && Array.isArray(obj.verdicts)) {
        const out: ChallengeVerdict[] = [];
        for (const v of obj.verdicts) {
          if (!v || typeof v !== 'object') continue;
          const index = Number(v.index);
          if (!Number.isInteger(index) || index < 0) continue;
          if (!VERDICTS.includes(v.verdict)) continue;
          out.push({
            index,
            verdict: v.verdict,
            reason: typeof v.reason === 'string' ? v.reason : undefined,
          });
        }
        return out;
      }
    } catch {
      // 尝试下一个候选
    }
  }
  return undefined;
}

function sanitizeMemories(input: unknown): Array<{ type?: string; text: string }> | undefined {
  if (!Array.isArray(input)) return undefined;
  const out: Array<{ type?: string; text: string }> = [];
  for (const m of input.slice(0, 3)) {
    if (typeof m === 'string' && m.trim()) out.push({ text: m.trim() });
    else if (
      m &&
      typeof m === 'object' &&
      typeof (m as { text?: unknown }).text === 'string' &&
      (m as { text: string }).text.trim()
    ) {
      const o = m as { type?: unknown; text: string };
      out.push({ type: typeof o.type === 'string' ? o.type : undefined, text: o.text.trim() });
    }
  }
  return out.length ? out : undefined;
}

function sanitizeFindings(input: unknown): Finding[] {
  if (!Array.isArray(input)) return [];
  const out: Finding[] = [];
  for (const f of input) {
    if (!f || typeof f !== 'object') continue;
    const { file, line, endLine, severity, title, detail } = f as Record<string, unknown>;
    if (typeof file !== 'string' || !file) continue;
    if (typeof title !== 'string' || !title) continue;
    const lineNum = Number(line);
    out.push({
      file: file.replace(/^\.?\//, ''),
      line: Number.isInteger(lineNum) && lineNum > 0 ? lineNum : 1,
      endLine: Number.isInteger(Number(endLine)) && Number(endLine) > 0 ? Number(endLine) : undefined,
      severity: SEVERITIES.includes(severity as Severity) ? (severity as Severity) : 'suggestion',
      title,
      detail: typeof detail === 'string' ? detail : '',
    });
  }
  return out;
}

export interface DreamOutput {
  memories: Array<{ type?: string; text: string; date?: string }>;
  /** 给团队的规范建议（markdown，可为空） */
  teamSuggestions?: string;
}

/** 解析 dream 整理输出；失败返回 undefined（保留原记忆不动） */
export function parseDreamOutput(raw: string): DreamOutput | undefined {
  for (const c of jsonCandidates(raw)) {
    try {
      const obj = JSON.parse(c);
      if (obj && typeof obj === 'object' && Array.isArray(obj.memories)) {
        const memories: DreamOutput['memories'] = [];
        for (const m of obj.memories) {
          if (m && typeof m === 'object' && typeof m.text === 'string' && m.text.trim()) {
            memories.push({
              type: typeof m.type === 'string' ? m.type : undefined,
              text: m.text.trim(),
              date: typeof m.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(m.date) ? m.date : undefined,
            });
          }
        }
        return {
          memories,
          teamSuggestions:
            typeof obj.teamSuggestions === 'string' && obj.teamSuggestions.trim()
              ? obj.teamSuggestions.trim()
              : undefined,
        };
      }
    } catch {
      // 尝试下一个候选
    }
  }
  return undefined;
}

/** 提取文本中最后一个平衡的顶层 {...} */
function extractLastJsonObject(text: string): string | undefined {
  const end = text.lastIndexOf('}');
  if (end === -1) return undefined;
  let depth = 0;
  let inString = false;
  for (let i = end; i >= 0; i--) {
    const ch = text[i];
    // 反向扫描无法完全正确处理转义引号，这里做尽力而为的平衡匹配
    if (ch === '"' && text[i - 1] !== '\\') inString = !inString;
    if (inString) continue;
    if (ch === '}') depth++;
    if (ch === '{') {
      depth--;
      if (depth === 0) return text.slice(i, end + 1);
    }
  }
  return undefined;
}
