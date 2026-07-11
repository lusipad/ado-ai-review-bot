import type { Logger } from '../types';

export type ReviewKind = 'full' | 'incremental';

export interface SchedulerOptions {
  reviewConcurrency: number;
  qaConcurrency: number;
  debounceMs: number;
  logger: Logger;
}

interface PendingJob {
  /** 串行域（prKey）：同一 serialKey 的任务不并发 */
  serialKey: string;
  kind: ReviewKind | 'task';
  run: (kind: ReviewKind) => Promise<void>;
}

/**
 * 调度规则：
 * - 每 PR 串行：同一 prKey 同时只有一个 review/task 在跑；
 * - 待执行 review 合并：全量吞并增量、重复触发只留一个；task（如 /fix）不合并、FIFO；
 * - review lane 全局并发上限；qa 走独立 lane 不被长 review 阻塞；
 * - push 防抖：窗口内多次 push 合并为一次（定时器重置）。
 */
export class Scheduler {
  private readonly opts: SchedulerOptions;

  /** jobId → job；review 的 jobId = prKey（合并语义），task 的 jobId 唯一 */
  private pending = new Map<string, PendingJob>();
  private order: string[] = [];
  private running = new Set<string>();
  private activeReviews = 0;
  private taskSeq = 0;

  private qaQueue: Array<() => Promise<void>> = [];
  private activeQa = 0;

  private debouncers = new Map<string, NodeJS.Timeout>();
  private draining = false;

  constructor(opts: SchedulerOptions) {
    this.opts = opts;
  }

  /**
   * 优雅停机：停止派发新任务，等在跑任务收尾（最多 timeoutMs）。
   * 排队中/防抖中的任务直接放弃——重启后的恢复扫描会补上。
   */
  async drain(timeoutMs: number): Promise<{ completed: boolean; interrupted: string[] }> {
    this.draining = true;
    for (const t of this.debouncers.values()) clearTimeout(t);
    this.debouncers.clear();
    const deadline = Date.now() + timeoutMs;
    while (this.activeReviews > 0 || this.activeQa > 0) {
      if (Date.now() >= deadline) {
        return { completed: false, interrupted: [...this.running] };
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    return { completed: true, interrupted: [] };
  }

  isDraining(): boolean {
    return this.draining;
  }

  /** 入队一个 review；同 PR 已有待执行 review 时合并（full 吞并 incremental） */
  enqueueReview(prKey: string, kind: ReviewKind, run: PendingJob['run']): void {
    if (this.draining) {
      this.opts.logger.warn({ prKey, kind }, '停机排水中，丢弃新任务（重启后恢复扫描会补）');
      return;
    }
    // push 防抖窗口尚未触发但来了全量请求 → 取消防抖（全量覆盖增量）
    if (kind === 'full') this.cancelDebounce(prKey);

    const existing = this.pending.get(prKey);
    if (existing) {
      if (kind === 'full' && existing.kind === 'incremental') {
        this.pending.set(prKey, { serialKey: prKey, kind, run });
        this.opts.logger.info({ prKey }, '待执行增量 review 升级为全量');
      } else {
        this.opts.logger.info({ prKey, kind }, '同 PR 已有待执行任务，合并');
      }
      return;
    }
    this.pending.set(prKey, { serialKey: prKey, kind, run });
    this.order.push(prKey);
    this.dispatchReviews();
  }

  /** 入队一个不可合并的任务（如 /fix）：与同 PR 的 review 串行，FIFO 不去重 */
  enqueueTask(prKey: string, run: () => Promise<void>): void {
    if (this.draining) {
      this.opts.logger.warn({ prKey }, '停机排水中，丢弃 task');
      return;
    }
    const jobId = `${prKey} task-${++this.taskSeq}`;
    this.pending.set(jobId, { serialKey: prKey, kind: 'task', run: () => run() });
    this.order.push(jobId);
    this.dispatchReviews();
  }

  /** PR 关闭收尾：取消该 PR 的防抖与所有待执行任务（在跑的不打断，自然收尾） */
  cancelPending(prKey: string): void {
    this.cancelDebounce(prKey);
    for (const [jobId, job] of this.pending) {
      if (job.serialKey === prKey) {
        this.pending.delete(jobId);
        this.order = this.order.filter((id) => id !== jobId);
      }
    }
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
      const idx = this.order.findIndex((id) => {
        const j = this.pending.get(id);
        return j !== undefined && !this.running.has(j.serialKey);
      });
      if (idx === -1) return;
      const jobId = this.order.splice(idx, 1)[0];
      const job = this.pending.get(jobId)!;
      this.pending.delete(jobId);
      const { serialKey } = job;
      this.running.add(serialKey);
      this.activeReviews++;
      void job
        .run(job.kind === 'task' ? 'full' : job.kind)
        .catch((err) => this.opts.logger.error({ serialKey, err: String(err) }, 'review 任务失败'))
        .finally(() => {
          this.running.delete(serialKey);
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

  /** 测试/面板/关停用 */
  stats(): {
    pending: number;
    running: number;
    runningKeys: string[];
    qaQueued: number;
    activeQa: number;
    debouncing: number;
    debouncingKeys: string[];
    draining: boolean;
  } {
    return {
      pending: this.pending.size,
      running: this.running.size,
      runningKeys: [...this.running],
      qaQueued: this.qaQueue.length,
      activeQa: this.activeQa,
      debouncing: this.debouncers.size,
      debouncingKeys: [...this.debouncers.keys()],
      draining: this.draining,
    };
  }
}
