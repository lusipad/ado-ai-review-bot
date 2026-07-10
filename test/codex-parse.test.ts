import { describe, expect, it } from 'vitest';
import { parseReviewOutput, parseChallengeVerdicts, parseDreamOutput } from '../src/engine/codex';
import { renderTemplate } from '../src/engine/prompts';

describe('parseReviewOutput', () => {
  it('解析 ```json 围栏块', () => {
    const raw = `这是我的分析……\n\n\`\`\`json\n{"summary":"整体不错","walkthrough":"- a.ts — 加了缓存","riskLevel":"low","findings":[{"file":"src/a.ts","line":10,"severity":"must-fix","title":"空指针","detail":"x 可能为 null"}],"resolvedThreadIds":[7]}\n\`\`\`\n`;
    const out = parseReviewOutput(raw);
    expect(out.degraded).toBe(false);
    expect(out.summary).toBe('整体不错');
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]).toMatchObject({ file: 'src/a.ts', line: 10, severity: 'must-fix' });
    expect(out.resolvedThreadIds).toEqual([7]);
  });

  it('多个围栏块取最后一个', () => {
    const raw = '```json\n{"summary":"first","findings":[]}\n```\n中间文字\n```json\n{"summary":"last","findings":[]}\n```';
    expect(parseReviewOutput(raw).summary).toBe('last');
  });

  it('整体就是裸 JSON', () => {
    const out = parseReviewOutput('{"summary":"ok","findings":[]}');
    expect(out.degraded).toBe(false);
    expect(out.summary).toBe('ok');
  });

  it('文字后跟裸 JSON 对象（无围栏）', () => {
    const out = parseReviewOutput('分析如下\n{"summary":"ok","findings":[{"file":"a.ts","line":1,"severity":"nit","title":"t","detail":"d"}]}');
    expect(out.degraded).toBe(false);
    expect(out.findings).toHaveLength(1);
  });

  it('畸形输出 → 降级为原文 summary', () => {
    const raw = '模型跑偏了，输出了一堆散文，没有 JSON。';
    const out = parseReviewOutput(raw);
    expect(out.degraded).toBe(true);
    expect(out.summary).toBe(raw);
    expect(out.findings).toEqual([]);
  });

  it('JSON 结构不完整（缺 summary）→ 降级', () => {
    expect(parseReviewOutput('{"findings":[]}').degraded).toBe(true);
  });

  it('清洗非法 finding：缺 file/title 丢弃、非法 severity 归为 suggestion、非法行号归 1', () => {
    const raw = JSON.stringify({
      summary: 's',
      findings: [
        { file: 'a.ts', line: 'x', severity: 'CRITICAL', title: 't', detail: 'd' },
        { file: '', line: 1, severity: 'nit', title: 't' },
        { line: 1, severity: 'nit', title: 't' },
        { file: './b.ts', line: 3, severity: 'nit', title: 't2', detail: 'd2' },
      ],
    });
    const out = parseReviewOutput(raw);
    expect(out.findings).toHaveLength(2);
    expect(out.findings[0]).toMatchObject({ file: 'a.ts', line: 1, severity: 'suggestion' });
    expect(out.findings[1]).toMatchObject({ file: 'b.ts', line: 3 });
  });

  it('resolvedThreadIds 过滤非整数', () => {
    const out = parseReviewOutput('{"summary":"s","findings":[],"resolvedThreadIds":[1,"x",2.5,3]}');
    expect(out.resolvedThreadIds).toEqual([1, 3]);
  });
});

describe('repoMemories 与 parseDreamOutput', () => {
  it('review 输出的 repoMemories：最多 3 条、清洗畸形项', () => {
    const out = parseReviewOutput(JSON.stringify({
      summary: 's',
      findings: [],
      repoMemories: [
        { type: '坑', text: '金额单位是分' },
        '字符串形式也接受',
        { text: '' },
        { type: '约定', text: '第四条被截掉' },
      ],
    }));
    expect(out.repoMemories).toHaveLength(2);
    expect(out.repoMemories![0]).toEqual({ type: '坑', text: '金额单位是分' });
    expect(out.repoMemories![1]).toEqual({ text: '字符串形式也接受' });
  });

  it('parseDreamOutput：memories + teamSuggestions + 日期校验', () => {
    const d = parseDreamOutput('整理过程……\n```json\n{"memories":[{"type":"约定","text":"合并后的","date":"2026-07-01"},{"text":"无日期","date":"07-01"}],"teamSuggestions":"- 建议写入 AGENTS.md"}\n```')!;
    expect(d.memories).toHaveLength(2);
    expect(d.memories[0].date).toBe('2026-07-01');
    expect(d.memories[1].date).toBeUndefined(); // 非法日期丢弃
    expect(d.teamSuggestions).toContain('AGENTS.md');
  });

  it('parseDreamOutput 解析失败 → undefined（原记忆不动）', () => {
    expect(parseDreamOutput('散文')).toBeUndefined();
  });
});

describe('parseChallengeVerdicts', () => {
  it('解析围栏 JSON 的 verdicts', () => {
    const raw = '核实过程……\n```json\n{"verdicts":[{"index":0,"verdict":"confirmed","reason":"caller.ts:20 确实未更新"},{"index":1,"verdict":"wrong","reason":"上游已判空"}]}\n```';
    const v = parseChallengeVerdicts(raw)!;
    expect(v).toHaveLength(2);
    expect(v[0]).toMatchObject({ index: 0, verdict: 'confirmed' });
    expect(v[1]).toMatchObject({ index: 1, verdict: 'wrong', reason: '上游已判空' });
  });

  it('清洗非法项：负 index、未知 verdict 丢弃', () => {
    const v = parseChallengeVerdicts(
      '{"verdicts":[{"index":-1,"verdict":"wrong"},{"index":0,"verdict":"maybe"},{"index":2,"verdict":"uncertain"}]}',
    )!;
    expect(v).toEqual([{ index: 2, verdict: 'uncertain', reason: undefined }]);
  });

  it('无法解析 → undefined（fail-open）', () => {
    expect(parseChallengeVerdicts('一段散文')).toBeUndefined();
    expect(parseChallengeVerdicts('{"summary":"不是 verdicts 结构"}')).toBeUndefined();
  });
});

describe('renderTemplate', () => {
  it('插值 + 缺失变量为空串', () => {
    expect(renderTemplate('a {{x}} b {{ y }} c {{missing}}!', { x: '1', y: '2' })).toBe('a 1 b 2 c !');
  });
});
