import { describe, expect, it } from 'vitest';
import { buildClaudeArgs, buildClaudePrompt, parseClaudeJson } from '../src/engine/claude';
import { parseEngineProfile } from '../src/pipeline';

describe('buildClaudeArgs', () => {
  it('只读模式：headless JSON + 只读工具白名单，无任意 Bash', () => {
    const args = buildClaudeArgs({ sandbox: 'read-only', extraArgs: [] });
    expect(args.slice(0, 3)).toEqual(['-p', '--output-format', 'json']);
    expect(args).toContain('Read');
    expect(args).toContain('Bash(git log:*)');
    expect(args).not.toContain('Edit');
    expect(args.some((a) => a === 'Bash' || a === 'Bash(*)')).toBe(false);
  });

  it('写模式（/fix）：允许编辑工具，仍不放开任意 Bash', () => {
    const args = buildClaudeArgs({ sandbox: 'workspace-write', extraArgs: [] });
    expect(args).toContain('Edit');
    expect(args).toContain('Write');
    expect(args.some((a) => a === 'Bash' || a === 'Bash(*)')).toBe(false);
  });

  it('model 与 extraArgs：default 不传 --model', () => {
    expect(buildClaudeArgs({ sandbox: 'read-only', extraArgs: [] })).not.toContain('--model');
    expect(buildClaudeArgs({ sandbox: 'read-only', model: 'default', extraArgs: [] })).not.toContain('--model');
    const args = buildClaudeArgs({ sandbox: 'read-only', model: 'opus', extraArgs: ['--max-turns', '30'] });
    expect(args.join(' ')).toContain('--model opus');
    expect(args.join(' ')).toContain('--max-turns 30');
  });
});

describe('buildClaudePrompt', () => {
  it('图片经 Read 工具查看的提示追加', () => {
    expect(buildClaudePrompt('问题', [])).toBe('问题');
    const p = buildClaudePrompt('问题', ['C:\\tmp\\a.png']);
    expect(p).toContain('Read 工具');
    expect(p).toContain('a.png');
  });
});

describe('parseClaudeJson', () => {
  it('成功结果取 result', () => {
    const r = parseClaudeJson(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '回答内容' }));
    expect(r).toEqual({ ok: true, output: '回答内容' });
  });

  it('is_error → 失败并带信息', () => {
    const r = parseClaudeJson(JSON.stringify({ type: 'result', is_error: true, result: '额度用尽' }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain('额度用尽');
  });

  it('缺 result / 非 JSON → 失败', () => {
    expect(parseClaudeJson('{"subtype":"error_max_turns"}').ok).toBe(false);
    expect(parseClaudeJson('not json').ok).toBe(false);
  });
});

describe('parseEngineProfile', () => {
  it('engine 前缀解析与默认引擎回退', () => {
    expect(parseEngineProfile(undefined, 'codex')).toEqual({ engine: 'codex' });
    expect(parseEngineProfile('default', 'claude')).toEqual({ engine: 'claude' });
    expect(parseEngineProfile('deepseek', 'codex')).toEqual({ engine: 'codex', name: 'deepseek' });
    expect(parseEngineProfile('claude', 'codex')).toEqual({ engine: 'claude', name: undefined });
    expect(parseEngineProfile('claude:opus', 'codex')).toEqual({ engine: 'claude', name: 'opus' });
    expect(parseEngineProfile('codex:deepseek', 'claude')).toEqual({ engine: 'codex', name: 'deepseek' });
  });
});
