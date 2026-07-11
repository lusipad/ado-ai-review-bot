import type { Logger } from '../types';
import type { Config, NotifyConfig } from '../config';
import { RocketChatNotifier } from './rocketchat';
import { WeComNotifier } from './wecom';
import { inQuietHours, msUntilQuietEnd, sleep } from '../util';

export type NotifyEventType = 'review_completed' | 'must_fix_found' | 'job_failed' | 'weekly_report';

export interface NotifyEvent {
  type: NotifyEventType;
  /** project/repoName，用于按仓库路由 */
  repoKey: string;
  title: string;
  text: string;
  url?: string;
  /** 需要 @ 的 RocketChat 用户名（不含 @；企业微信暂不支持 markdown @） */
  mentionUsernames?: string[];
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
  /** 静默时段积压的通知（进程内，重启丢弃可接受） */
  private quietQueue: NotifyEvent[] = [];
  private quietFlushTimer?: NodeJS.Timeout;

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
    private readonly fetchFn: FetchFn = fetch,
    /** 可注入的时钟（测试用） */
    private readonly now: () => Date = () => new Date(),
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

  /** 同步返回，不 await：通知在后台发送；静默时段入队，结束时汇总 */
  dispatch(event: NotifyEvent): void {
    const { notifiers, events } = this.resolveFor(event.repoKey);
    if (!events.includes(event.type)) return;

    const q = this.config.quietHours;
    if (q && inQuietHours(this.now(), q)) {
      if (this.quietQueue.length < 200) this.quietQueue.push(event);
      if (!this.quietFlushTimer) {
        this.quietFlushTimer = setTimeout(() => this.flushQuietQueue(), msUntilQuietEnd(this.now(), q));
        this.quietFlushTimer.unref?.();
      }
      return;
    }
    for (const n of notifiers) {
      void this.sendWithRetry(n, event);
    }
  }

  /** 静默结束：按仓库分组汇总成一条消息发出（测试可直接调用） */
  flushQuietQueue(): void {
    clearTimeout(this.quietFlushTimer);
    this.quietFlushTimer = undefined;
    const queued = this.quietQueue.splice(0);
    if (queued.length === 0) return;

    const byRepo = new Map<string, NotifyEvent[]>();
    for (const e of queued) {
      const list = byRepo.get(e.repoKey) ?? [];
      list.push(e);
      byRepo.set(e.repoKey, list);
    }
    for (const [repoKey, events] of byRepo) {
      const mentions = [...new Set(events.flatMap((e) => e.mentionUsernames ?? []))];
      const lines = events.map((e) => `- ${e.title}${e.url ? `（${e.url}）` : ''}`);
      const digest: NotifyEvent = {
        type: events[0].type,
        repoKey,
        title: `🌙 静默期间的 ${events.length} 条通知汇总`,
        text: lines.join('\n'),
        mentionUsernames: mentions.length ? mentions : undefined,
      };
      const { notifiers } = this.resolveFor(repoKey);
      for (const n of notifiers) void this.sendWithRetry(n, digest);
    }
    this.logger.info({ count: queued.length, repos: byRepo.size }, '静默期通知已汇总发出');
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
