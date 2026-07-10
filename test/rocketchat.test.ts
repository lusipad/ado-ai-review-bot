import { describe, expect, it } from 'vitest';
import { RocketChatClient } from '../src/rocketchat';
import { isStructuredCommand, resolveRepoForChat } from '../src/chatops';

function mockFetch(responses: Array<{ status?: number; json?: unknown }>) {
  const calls: Array<{ url: string; body: any }> = [];
  const fetchFn = (async (url: any, init: any) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)] ?? {};
    return new Response(JSON.stringify(r.json ?? { success: true }), { status: r.status ?? 200 });
  }) as typeof fetch;
  return { calls, fetchFn };
}

describe('RocketChatClient', () => {
  it('postMessage 带线程 tmid、updateMessage、createDiscussion', async () => {
    const { calls, fetchFn } = mockFetch([
      { json: { success: true, message: { _id: 'm1' } } },
      { json: { success: true } },
      { json: { success: true, discussion: { _id: 'd1' } } },
    ]);
    const rc = new RocketChatClient({ baseUrl: 'http://rc.local', userId: 'u1', token: 't1', fetchFn });

    const m = await rc.postMessage('room1', '你好', 'msg-42');
    expect(m.msgId).toBe('m1');
    expect(calls[0].url).toBe('http://rc.local/api/v1/chat.postMessage');
    expect(calls[0].body).toEqual({ roomId: 'room1', text: '你好', tmid: 'msg-42' });

    await rc.updateMessage('room1', 'm1', '改后');
    expect(calls[1].body).toEqual({ roomId: 'room1', msgId: 'm1', text: '改后' });

    const d = await rc.createDiscussion('room1', '分析：某问题');
    expect(d.roomId).toBe('d1');
    expect(calls[2].body.prid).toBe('room1');
  });

  it('API success=false 抛错', async () => {
    const { fetchFn } = mockFetch([{ json: { success: false, error: 'room not found' } }]);
    const rc = new RocketChatClient({ baseUrl: 'http://rc.local', userId: 'u', token: 't', fetchFn });
    await expect(rc.postMessage('x', 'y')).rejects.toThrow('room not found');
  });
});

describe('isStructuredCommand', () => {
  it('结构化命令识别；自由问题走另一条路', () => {
    for (const t of ['状态', '统计 30', '待处理', '架构 test/test', '记忆 test/test', '帮助', 'stats 7']) {
      expect(isStructuredCommand(t)).toBe(true);
    }
    for (const t of ['结算模块有没有并发风险？', '讨论 帮我全面分析下', '为什么用轮询', '状态机是怎么实现的']) {
      expect(isStructuredCommand(t)).toBe(false);
    }
  });
});

describe('resolveRepoForChat', () => {
  const known = ['test/test', 'Proj/Repo'];
  it('问题里显式写了仓库 → 用它', () => {
    expect(resolveRepoForChat('看下 proj/repo 的网关', 'dev', known, {})).toEqual({ repoKey: 'Proj/Repo' });
  });
  it('频道绑定次之', () => {
    expect(resolveRepoForChat('网关有风险吗', 'dev', known, { dev: 'test/test' })).toEqual({ repoKey: 'test/test' });
  });
  it('全局唯一仓库兜底；定不了给 hint', () => {
    expect(resolveRepoForChat('网关', 'x', ['only/one'], {})).toEqual({ repoKey: 'only/one' });
    const r = resolveRepoForChat('网关', 'x', known, {});
    expect(r.repoKey).toBeUndefined();
    expect(r.hint).toContain('test/test');
  });
});
