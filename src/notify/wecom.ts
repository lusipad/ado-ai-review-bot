import { truncateUtf8Bytes } from '../util';
import type { Notifier, NotifyEvent, FetchFn } from './index';

const WECOM_WEBHOOK_BASE = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=';
/** 企业微信 markdown content 上限 4096 字节，留余量给链接行 */
const MAX_BODY_BYTES = 3800;

const COLOR: Record<NotifyEvent['type'], string> = {
  review_completed: 'info',
  must_fix_found: 'warning',
  job_failed: 'warning',
};

/** 企业微信群机器人 */
export class WeComNotifier implements Notifier {
  readonly name = 'wecom';
  private readonly webhookUrl: string;

  /** keyOrUrl：机器人 key 或完整 webhook URL */
  constructor(
    keyOrUrl: string,
    private readonly fetchFn: FetchFn = fetch,
  ) {
    this.webhookUrl = keyOrUrl.startsWith('http') ? keyOrUrl : WECOM_WEBHOOK_BASE + keyOrUrl;
  }

  async send(event: NotifyEvent): Promise<void> {
    const body = truncateUtf8Bytes(event.text, MAX_BODY_BYTES);
    const lines = [
      `**${event.title}** <font color="${COLOR[event.type]}">[${event.type}]</font>`,
      body,
    ];
    if (event.url) lines.push(`[打开 PR](${event.url})`);
    const res = await this.fetchFn(this.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        msgtype: 'markdown',
        markdown: { content: lines.filter(Boolean).join('\n') },
      }),
    });
    if (!res.ok) throw new Error(`企业微信 webhook HTTP ${res.status}`);
    const data = (await res.json().catch(() => ({}))) as { errcode?: number; errmsg?: string };
    if (data.errcode && data.errcode !== 0)
      throw new Error(`企业微信 webhook errcode ${data.errcode}: ${data.errmsg}`);
  }
}
