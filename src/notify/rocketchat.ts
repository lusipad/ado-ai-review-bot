import type { Notifier, NotifyEvent, FetchFn } from './index';

const EMOJI: Record<NotifyEvent['type'], string> = {
  review_completed: '✅',
  must_fix_found: '🔴',
  job_failed: '⚠️',
  weekly_report: '📊',
};

/** RocketChat Incoming Webhook Integration */
export class RocketChatNotifier implements Notifier {
  readonly name = 'rocketchat';

  constructor(
    private readonly webhookUrl: string,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  async send(event: NotifyEvent): Promise<void> {
    const mention = event.mentionUsernames?.length
      ? event.mentionUsernames.map((u) => `@${u}`).join(' ') + ' '
      : '';
    const lines = [`${mention}${EMOJI[event.type]} **${event.title}**`, event.text];
    if (event.url) lines.push(`[打开 PR](${event.url})`);
    const res = await this.fetchFn(this.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: lines.filter(Boolean).join('\n') }),
    });
    if (!res.ok) throw new Error(`RocketChat webhook HTTP ${res.status}`);
  }
}
