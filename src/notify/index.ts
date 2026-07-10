import type { Logger } from '../types';
import type { Config, NotifyConfig } from '../config';
import { RocketChatNotifier } from './rocketchat';
import { WeComNotifier } from './wecom';
import { sleep } from '../util';

export type NotifyEventType = 'review_completed' | 'must_fix_found' | 'job_failed';

export interface NotifyEvent {
  type: NotifyEventType;
  /** project/repoName，用于按仓库路由 */
  repoKey: string;
  title: string;
  text: string;
  url?: string;
}

export interface Notifier {
  readonly name: string;
  send(event: NotifyEvent): Promise<void>;
}

export type FetchFn = typeof fetch;

/**
 * 通知分发：按仓库覆盖 → 事件过滤 → 各适配器 fire-and-forget（重试 2 次），
 * 任何失败只记日志，绝不影响 review 流水线。
 */
export class NotifyDispatcher {
  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  private resolveFor(repoKey: string): { notifiers: Notifier[]; events: NotifyConfig['events'] } {
    const override = this.config.repoOverrides[repoKey]?.notify;
    const merged: NotifyConfig = {
      rocketchatWebhookUrl:
        override?.rocketchatWebhookUrl ?? this.config.notify.rocketchatWebhookUrl,
      wecomWebhookKey: override?.wecomWebhookKey ?? this.config.notify.wecomWebhookKey,
      events: override?.events ?? this.config.notify.events,
    };
    const notifiers: Notifier[] = [];
    if (merged.rocketchatWebhookUrl)
      notifiers.push(new RocketChatNotifier(merged.rocketchatWebhookUrl, this.fetchFn));
    if (merged.wecomWebhookKey)
      notifiers.push(new WeComNotifier(merged.wecomWebhookKey, this.fetchFn));
    return { notifiers, events: merged.events };
  }

  /** 同步返回，不 await：通知在后台发送 */
  dispatch(event: NotifyEvent): void {
    const { notifiers, events } = this.resolveFor(event.repoKey);
    if (!events.includes(event.type)) return;
    for (const n of notifiers) {
      void this.sendWithRetry(n, event);
    }
  }

  private async sendWithRetry(notifier: Notifier, event: NotifyEvent): Promise<void> {
    for (let attempt = 0; attempt <= 2; attempt++) {
      try {
        await notifier.send(event);
        return;
      } catch (err) {
        if (attempt === 2) {
          this.logger.error(
            { notifier: notifier.name, event: event.type, err: String(err) },
            'IM 通知发送失败（已重试 2 次，放弃）',
          );
          return;
        }
        await sleep(1000 * (attempt + 1));
      }
    }
  }
}
