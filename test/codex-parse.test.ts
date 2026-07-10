import { describe, expect, it } from 'vitest';
import { parseReviewOutput } from '../src/engine/codex';
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

describe('renderTemplate', () => {
  it('插值 + 缺失变量为空串', () => {
    expect(renderTemplate('a {{x}} b {{ y }} c {{missing}}!', { x: '1', y: '2' })).toBe('a 1 b 2 c !');
  });
});
