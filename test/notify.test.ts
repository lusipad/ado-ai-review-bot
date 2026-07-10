import { describe, expect, it, vi } from 'vitest';
import { NotifyDispatcher, type NotifyEvent } from '../src/notify';
import { RocketChatNotifier } from '../src/notify/rocketchat';
import { WeComNotifier } from '../src/notify/wecom';
import type { Config } from '../src/config';
import { truncateUtf8Bytes } from '../src/util';

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

function okFetch(capture: { url?: string; body?: any }): typeof fetch {
  return (async (url: any, init: any) => {
    capture.url = String(url);
    capture.body = JSON.parse(init.body);
    return new Response(JSON.stringify({ errcode: 0 }), { status: 200 });
  }) as typeof fetch;
}

const event: NotifyEvent = {
  type: 'review_completed',
  repoKey: 'Proj/Repo',
  title: 'AI review 完成：my PR',
  text: '发现 2 个问题',
  url: 'https://ado.corp.local/DefaultCollection/Proj/_git/Repo/pullrequest/1',
};

describe('RocketChatNotifier', () => {
  it('POST text 到 webhook URL', async () => {
    const cap: any = {};
    const n = new RocketChatNotifier('https://chat.corp.local/hooks/abc', okFetch(cap));
    await n.send(event);
    expect(cap.url).toBe('https://chat.corp.local/hooks/abc');
    expect(cap.body.text).toContain('AI review 完成：my PR');
    expect(cap.body.text).toContain('pullrequest/1');
  });

  it('HTTP 非 2xx 抛错', async () => {
    const n = new RocketChatNotifier('https://x', (async () => new Response('', { status: 500 })) as typeof fetch);
    await expect(n.send(event)).rejects.toThrow('HTTP 500');
  });
});

describe('WeComNotifier', () => {
  it('key 拼成官方 webhook URL，发 markdown 消息', async () => {
    const cap: any = {};
    const n = new WeComNotifier('my-key-123', okFetch(cap));
    await n.send(event);
    expect(cap.url).toBe('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=my-key-123');
    expect(cap.body.msgtype).toBe('markdown');
    expect(cap.body.markdown.content).toContain('AI review 完成：my PR');
  });

  it('完整 URL 直接使用', async () => {
    const cap: any = {};
    const n = new WeComNotifier('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xyz', okFetch(cap));
    await n.send(event);
    expect(cap.url).toContain('key=xyz');
  });

  it('超长正文按字节截断（不超过企业微信 4096 上限）', async () => {
    const cap: any = {};
    const n = new WeComNotifier('k', okFetch(cap));
    await n.send({ ...event, text: '很长的中文内容。'.repeat(2000) });
    expect(Buffer.byteLength(cap.body.markdown.content, 'utf8')).toBeLessThan(4096);
  });

  it('errcode 非 0 抛错', async () => {
    const n = new WeComNotifier('k', (async () =>
      new Response(JSON.stringify({ errcode: 93000, errmsg: 'invalid webhook url' }), { status: 200 })) as typeof fetch);
    await expect(n.send(event)).rejects.toThrow('93000');
  });
});

describe('truncateUtf8Bytes', () => {
  it('不截断多字节字符中间', () => {
    const s = truncateUtf8Bytes('中文字符串', 8); // 每个汉字 3 字节
    expect(s.endsWith('…')).toBe(true);
    expect(() => Buffer.from(s, 'utf8').toString('utf8')).not.toThrow();
    expect(s).toBe('中…');
  });
});

function makeConfig(notify: Partial<Config['notify']>, repoOverrides: Config['repoOverrides'] = {}): Config {
  return {
    notify: { events: ['review_completed', 'must_fix_found', 'job_failed'], ...notify },
    repoOverrides,
  } as unknown as Config;
}

describe('NotifyDispatcher', () => {
  it('两个适配器同时启用都收到消息', async () => {
    const urls: string[] = [];
    const fetchFn = (async (url: any) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ errcode: 0 }), { status: 200 });
    }) as typeof fetch;
    const d = new NotifyDispatcher(
      makeConfig({ rocketchatWebhookUrl: 'https://chat/hooks/a', wecomWebhookKey: 'k' }),
      silentLogger,
      fetchFn,
    );
    d.dispatch(event);
    await vi.waitFor(() => expect(urls).toHaveLength(2));
  });

  it('事件过滤：不在 events 列表的不发送', async () => {
    const fetchFn = vi.fn();
    const d = new NotifyDispatcher(
      makeConfig({ rocketchatWebhookUrl: 'https://chat/hooks/a', events: ['job_failed'] }),
      silentLogger,
      fetchFn as unknown as typeof fetch,
    );
    d.dispatch(event); // review_completed 被过滤
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('按仓库覆盖 webhook 路由', async () => {
    const urls: string[] = [];
    const fetchFn = (async (url: any) => {
      urls.push(String(url));
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const d = new NotifyDispatcher(
      makeConfig(
        { rocketchatWebhookUrl: 'https://chat/hooks/default' },
        { 'Proj/Repo': { notify: { rocketchatWebhookUrl: 'https://chat/hooks/team-a' } } },
      ),
      silentLogger,
      fetchFn,
    );
    d.dispatch(event);
    await vi.waitFor(() => expect(urls).toEqual(['https://chat/hooks/team-a']));
  });

  it('发送失败不抛出、不影响调用方（fire-and-forget）', async () => {
    const fetchFn = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const errors: unknown[] = [];
    const d = new NotifyDispatcher(
      makeConfig({ rocketchatWebhookUrl: 'https://chat/hooks/a' }),
      { ...silentLogger, error: (o) => errors.push(o) },
      fetchFn,
    );
    expect(() => d.dispatch(event)).not.toThrow();
    // 重试 2 次（间隔 1s+2s）后记录错误日志
    await vi.waitFor(() => expect(errors.length).toBe(1), { timeout: 5000 });
  }, 10000);
});
