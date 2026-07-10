import { createHash } from 'node:crypto';

/** 简单 promise 互斥锁（每仓库 git 操作串行用） */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    // 失败也要放行后续任务
    this.tail = next.catch(() => undefined);
    return next;
  }
}

export class KeyedMutex {
  private locks = new Map<string, Mutex>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    let m = this.locks.get(key);
    if (!m) {
      m = new Mutex();
      this.locks.set(key, m);
    }
    return m.run(fn);
  }
}

/** 把 project/repo 之类的 key 变成安全目录名 */
export function sanitizePathSegment(key: string): string {
  return key.replace(/[^a-zA-Z0-9一-龥._-]+/g, '_');
}

export function sha1(input: string): string {
  return createHash('sha1').update(input, 'utf8').digest('hex');
}

/**
 * finding 指纹：file + 归一化标题。行号不参与（代码移动后行号变但问题相同），
 * 数字统一抹平避免「第 3 处」之类的措辞差异。
 */
export function findingFingerprint(file: string, title: string): string {
  const normalized = title.toLowerCase().replace(/\s+/g, ' ').replace(/\d+/g, 'N').trim();
  return sha1(`${file}\n${normalized}`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 距下一个「周 weekday 的 hour 点整」（服务器本地时区）的毫秒数。
 * weekday: 0=周日 … 6=周六。恰好落在时点上时返回一整周（避免重复触发）。
 */
export function msUntilNextWeekly(now: Date, weekday: number, hour: number): number {
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  const dayDiff = (weekday - now.getDay() + 7) % 7;
  next.setDate(next.getDate() + dayDiff);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 7);
  return next.getTime() - now.getTime();
}

/** 按 UTF-8 字节数截断（企业微信 markdown 4096 字节上限用） */
export function truncateUtf8Bytes(text: string, maxBytes: number, suffix = '…'): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  const suffixBytes = Buffer.byteLength(suffix, 'utf8');
  let end = maxBytes - suffixBytes;
  // 避免截断在多字节字符中间
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8') + suffix;
}
