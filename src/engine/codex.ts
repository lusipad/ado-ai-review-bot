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
