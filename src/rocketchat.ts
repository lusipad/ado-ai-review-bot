import type { FetchFn } from './ado/client';

/**
 * Rocket.Chat REST 客户端（bot 用户身份）。
 * 有它 bot 才能主动发消息、在线程里回复、创建讨论——出站 webhook 的同步应答做不到这些。
 */
export class RocketChatClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly fetchFn: FetchFn;

  constructor(opts: { baseUrl: string; userId: string; token: string; fetchFn?: FetchFn }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.headers = {
      'X-Auth-Token': opts.token,
      'X-User-Id': opts.userId,
      'content-type': 'application/json',
    };
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await this.fetchFn(`${this.baseUrl}/api/v1/${path}`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as T & { success?: boolean; error?: string };
    if (!res.ok || json.success === false) {
      throw new Error(`RC API ${path} 失败: ${json.error ?? `HTTP ${res.status}`}`);
    }
    return json;
  }

  /** 发消息；tmid 指定则回复到该消息的线程里 */
  async postMessage(roomId: string, text: string, tmid?: string): Promise<{ msgId: string }> {
    const r = await this.post<{ message: { _id: string } }>('chat.postMessage', {
      roomId,
      text,
      ...(tmid ? { tmid } : {}),
    });
    return { msgId: r.message._id };
  }

  /** 编辑已发消息（占位 → 结果） */
  async updateMessage(roomId: string, msgId: string, text: string): Promise<void> {
    await this.post('chat.update', { roomId, msgId, text });
  }

  /** 在父频道下创建讨论，返回讨论房间 id */
  async createDiscussion(parentRoomId: string, title: string): Promise<{ roomId: string }> {
    const r = await this.post<{ discussion: { _id: string } }>('rooms.createDiscussion', {
      prid: parentRoomId,
      t_name: title.slice(0, 100),
    });
    return { roomId: r.discussion._id };
  }
}
