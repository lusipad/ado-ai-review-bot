import type { Logger } from '../types';

export type ReviewKind = 'full' | 'incremental';

export interface SchedulerOptions {
  reviewConcurrency: number;
  qaConcurrency: number;
  debounceMs: number;
  logger: Logger;
}

interface PendingReview {
  kind: ReviewKind;
  run: (kind: ReviewKind) => Promise<void>;
}

/**
 * 调度规则：
 * - 每 PR 串行：同一 prKey 同时只有一个 review 在跑；
 * - 待执行任务合并：全量吞并增量、重复触发只留一个；
 * - review lane 全局并发上限；qa 走独立 lane 不被长 review 阻塞；
 * - push 防抖：窗口内多次 push 合并为一次（定时器重置）。
 */
export class Scheduler {
  private readonly opts: SchedulerOptions;

  private pending = new Map<string, PendingReview>();
  private order: string[] = [];
  private running = new Set<string>();
  private activeReviews = 0;

  private qaQueue: Array<() => Promise<void>> = [];
  private activeQa = 0;

  private debouncers = new Map<string, NodeJS.Timeout>();

  constructor(opts: SchedulerOptions) {
    this.opts = opts;
  }

  /** 入队一个 review；同 PR 已有待执行任务时合并（full 吞并 incremental） */
  enqueueReview(prKey: string, kind: ReviewKind, run: PendingReview['run']): void {
    // push 防抖窗口尚未触发但来了全量请求 → 取消防抖（全量覆盖增量）
    if (kind === 'full') this.cancelDebounce(prKey);

    const existing = this.pending.get(prKey);
    if (existing) {
      if (kind === 'full' && existing.kind === 'incremental') {
        this.pending.set(prKey, { kind, run });
        this.opts.logger.info({ prKey }, '待执行增量 review 升级为全量');
      } else {
        this.opts.logger.info({ prKey, kind }, '同 PR 已有待执行任务，合并');
      }
      return;
    }
    this.pending.set(prKey, { kind, run });
    this.order.push(prKey);
    this.dispatchReviews();
  }

  /** push 防抖：窗口内重复调用只重置定时器，窗口结束才真正入队 */
  debouncePush(prKey: string, fire: () => void): void {
    this.cancelDebounce(prKey);
    const t = setTimeout(() => {
      this.debouncers.delete(prKey);
      fire();
    }, this.opts.debounceMs);
    // 不阻止进程退出
    t.unref?.();
    this.debouncers.set(prKey, t);
  }

  private cancelDebounce(prKey: string): void {
    const t = this.debouncers.get(prKey);
    if (t) {
      clearTimeout(t);
      this.debouncers.delete(prKey);
    }
  }

  private dispatchReviews(): void {
    while (this.activeReviews < this.opts.reviewConcurrency) {
      const idx = this.order.findIndex((k) => !this.running.has(k));
      if (idx === -1) return;
      const prKey = this.order.splice(idx, 1)[0];
      const job = this.pending.get(prKey);
      if (!job) continue;
      this.pending.delete(prKey);
      this.running.add(prKey);
      this.activeReviews++;
      void job
        .run(job.kind)
        .catch((err) => this.opts.logger.error({ prKey, err: String(err) }, 'review 任务失败'))
        .finally(() => {
          this.running.delete(prKey);
          this.activeReviews--;
          // 运行期间同 PR 又有新任务入队 → 继续调度
          this.dispatchReviews();
        });
    }
  }

  /** 问答任务：独立高优先 lane */
  enqueueQa(run: () => Promise<void>): void {
    this.qaQueue.push(run);
    this.dispatchQa();
  }

  private dispatchQa(): void {
    while (this.activeQa < this.opts.qaConcurrency && this.qaQueue.length > 0) {
      const run = this.qaQueue.shift()!;
      this.activeQa++;
      void run()
        .catch((err) => this.opts.logger.error({ err: String(err) }, '问答任务失败'))
        .finally(() => {
          this.activeQa--;
          this.dispatchQa();
        });
    }
  }

  /** 测试/关停用 */
  stats(): { pending: number; running: number; qaQueued: number; debouncing: number } {
    return {
      pending: this.pending.size,
      running: this.running.size,
      qaQueued: this.qaQueue.length,
      debouncing: this.debouncers.size,
    };
  }
}
