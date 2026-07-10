import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Scheduler } from '../src/queue/scheduler';
import { consoleLogger } from '../src/types';

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

const tick = () => new Promise<void>((r) => setImmediate(r));

describe('Scheduler review lane', () => {
  it('不同 PR 并行，受全局并发上限约束', async () => {
    const s = new Scheduler({ reviewConcurrency: 2, qaConcurrency: 1, debounceMs: 1000, logger: silentLogger });
    const gates = [deferred(), deferred(), deferred()];
    const started: string[] = [];
    for (let i = 0; i < 3; i++) {
      s.enqueueReview(`pr-${i}`, 'full', async () => {
        started.push(`pr-${i}`);
        await gates[i].promise;
      });
    }
    await tick();
    expect(started).toEqual(['pr-0', 'pr-1']); // 上限 2，第三个排队
    gates[0].resolve();
    await tick();
    expect(started).toEqual(['pr-0', 'pr-1', 'pr-2']);
    gates[1].resolve();
    gates[2].resolve();
    await tick();
  });

  it('同 PR 串行：运行中再入队会等当前任务结束', async () => {
    const s = new Scheduler({ reviewConcurrency: 2, qaConcurrency: 1, debounceMs: 1000, logger: silentLogger });
    const gate = deferred();
    const runs: string[] = [];
    s.enqueueReview('pr-1', 'full', async () => {
      runs.push('first');
      await gate.promise;
    });
    await tick();
    s.enqueueReview('pr-1', 'incremental', async () => {
      runs.push('second');
    });
    await tick();
    expect(runs).toEqual(['first']); // 第二个必须等
    gate.resolve();
    await tick();
    await tick();
    expect(runs).toEqual(['first', 'second']);
  });

  it('待执行任务合并：全量吞并增量，重复触发只跑一次', async () => {
    const s = new Scheduler({ reviewConcurrency: 1, qaConcurrency: 1, debounceMs: 1000, logger: silentLogger });
    const gate = deferred();
    s.enqueueReview('pr-busy', 'full', async () => gate.promise); // 占住唯一槽位

    const kinds: string[] = [];
    await tick();
    s.enqueueReview('pr-1', 'incremental', async (kind) => {
      kinds.push(kind);
    });
    s.enqueueReview('pr-1', 'full', async (kind) => {
      kinds.push(kind);
    });
    s.enqueueReview('pr-1', 'incremental', async (kind) => {
      kinds.push(kind);
    });
    gate.resolve();
    await tick();
    await tick();
    expect(kinds).toEqual(['full']); // 只跑一次，且是升级后的全量
  });

  it('任务抛错不影响后续调度', async () => {
    const s = new Scheduler({ reviewConcurrency: 1, qaConcurrency: 1, debounceMs: 1000, logger: silentLogger });
    const runs: string[] = [];
    s.enqueueReview('pr-1', 'full', async () => {
      throw new Error('boom');
    });
    await tick();
    s.enqueueReview('pr-2', 'full', async () => {
      runs.push('pr-2');
    });
    await tick();
    await tick();
    expect(runs).toEqual(['pr-2']);
  });
});

describe('Scheduler push 防抖', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('窗口内多次 push 合并为一次', () => {
    const s = new Scheduler({ reviewConcurrency: 1, qaConcurrency: 1, debounceMs: 3000, logger: silentLogger });
    let fired = 0;
    s.debouncePush('pr-1', () => fired++);
    vi.advanceTimersByTime(2000);
    s.debouncePush('pr-1', () => fired++); // 重置定时器
    vi.advanceTimersByTime(2000);
    expect(fired).toBe(0); // 还没到重置后的窗口期
    vi.advanceTimersByTime(1000);
    expect(fired).toBe(1);
  });

  it('不同 PR 的防抖互不影响', () => {
    const s = new Scheduler({ reviewConcurrency: 1, qaConcurrency: 1, debounceMs: 3000, logger: silentLogger });
    let a = 0;
    let b = 0;
    s.debouncePush('pr-a', () => a++);
    s.debouncePush('pr-b', () => b++);
    vi.advanceTimersByTime(3000);
    expect(a).toBe(1);
    expect(b).toBe(1);
  });

  it('防抖期间来了全量 review → 取消防抖（全量覆盖增量）', () => {
    const s = new Scheduler({ reviewConcurrency: 1, qaConcurrency: 1, debounceMs: 3000, logger: silentLogger });
    let debounceFired = 0;
    s.debouncePush('pr-1', () => debounceFired++);
    s.enqueueReview('pr-1', 'full', async () => {});
    vi.advanceTimersByTime(5000);
    expect(debounceFired).toBe(0);
  });
});

describe('Scheduler task lane（/fix 等不可合并任务）', () => {
  it('与同 PR 的 review 串行，task 之间 FIFO 不合并', async () => {
    const s = new Scheduler({ reviewConcurrency: 2, qaConcurrency: 1, debounceMs: 1000, logger: silentLogger });
    const gate = deferred();
    const runs: string[] = [];
    s.enqueueReview('pr-1', 'full', async () => {
      runs.push('review');
      await gate.promise;
    });
    await tick();
    // review 运行中入队两个 fix：都要等，且互不合并
    s.enqueueTask('pr-1', async () => {
      runs.push('fix-1');
    });
    s.enqueueTask('pr-1', async () => {
      runs.push('fix-2');
    });
    await tick();
    expect(runs).toEqual(['review']);
    gate.resolve();
    await tick();
    await tick();
    await tick();
    expect(runs).toEqual(['review', 'fix-1', 'fix-2']);
  });

  it('不同 PR 的 task 可并行', async () => {
    const s = new Scheduler({ reviewConcurrency: 2, qaConcurrency: 1, debounceMs: 1000, logger: silentLogger });
    const started: string[] = [];
    const gate = deferred();
    s.enqueueTask('pr-a', async () => {
      started.push('a');
      await gate.promise;
    });
    s.enqueueTask('pr-b', async () => {
      started.push('b');
      await gate.promise;
    });
    await tick();
    expect(started.sort()).toEqual(['a', 'b']);
    gate.resolve();
    await tick();
  });
});

describe('Scheduler drain（优雅停机）', () => {
  it('等待在跑任务收尾，期间丢弃新任务，清空防抖', async () => {
    const s = new Scheduler({ reviewConcurrency: 2, qaConcurrency: 1, debounceMs: 60_000, logger: silentLogger });
    const gate = deferred();
    const runs: string[] = [];
    s.enqueueReview('pr-1', 'full', async () => {
      runs.push('running');
      await gate.promise;
    });
    let debounceFired = 0;
    s.debouncePush('pr-2', () => debounceFired++);
    await tick();

    const drainP = s.drain(5_000);
    // 排水期间的新任务被丢弃
    s.enqueueReview('pr-3', 'full', async () => runs.push('late'));
    s.enqueueTask('pr-4', async () => runs.push('late-task'));
    expect(s.stats().pending).toBe(0);
    expect(s.stats().draining).toBe(true);
    expect(s.stats().debouncing).toBe(0); // 防抖被清空

    gate.resolve();
    const result = await drainP;
    expect(result.completed).toBe(true);
    expect(runs).toEqual(['running']);
    expect(debounceFired).toBe(0);
  });

  it('超时返回被打断的任务 key', async () => {
    const s = new Scheduler({ reviewConcurrency: 1, qaConcurrency: 1, debounceMs: 1000, logger: silentLogger });
    const gate = deferred();
    s.enqueueReview('pr-stuck', 'full', async () => gate.promise);
    await tick();
    const result = await s.drain(300);
    expect(result.completed).toBe(false);
    expect(result.interrupted).toEqual(['pr-stuck']);
    gate.resolve();
  });
});

describe('Scheduler qa lane', () => {
  it('review 占满时问答仍立即执行', async () => {
    const s = new Scheduler({ reviewConcurrency: 1, qaConcurrency: 1, debounceMs: 1000, logger: consoleLogger });
    const gate = deferred();
    s.enqueueReview('pr-1', 'full', async () => gate.promise);
    let qaDone = false;
    s.enqueueQa(async () => {
      qaDone = true;
    });
    await tick();
    await tick();
    expect(qaDone).toBe(true); // 没被 review 阻塞
    gate.resolve();
  });
});
