// 灵镜 通用滑动窗口限速器(设计文档 §4.3 + D5)。
//
// 单进程内存态(Map<key, 时间戳数组>)。每 key 保留窗口内的命中时间戳,allow() 时先剪过期再判量。
// 用途:Open API key 读写分级限速(读 300/min、写 60/min);未来 SMS / 厂商 429 退避也可复用(T-RATELIMIT-UTIL-MIGRATE)。
//
// 【显式记债】内存态与 server.ts 注明的"规模化后 worker 拆独立进程 (Approach B)"路线冲突:
//   拆进程后各进程各持一份计数,限速失效。届时需换共享存储(Redis / DB 计数)。本轮单进程够用。

const now = (): number => Date.now();

export class SlidingWindowLimiter {
  private hits = new Map<string, number[]>();

  /** @param windowMs 窗口毫秒数  @param max 窗口内最多放行次数 */
  constructor(private windowMs: number, private max: number) {}

  /** 判定并记录一次命中:窗口内未超上限 → 记录并返回 true;已达上限 → 不记录,返回 false。 */
  allow(key: string): boolean {
    const cutoff = now() - this.windowMs;
    const arr = this.hits.get(key);
    if (!arr) {
      this.hits.set(key, [now()]);
      return true;
    }
    // 剪掉过期时间戳(滑动窗口)
    let i = 0;
    while (i < arr.length && arr[i]! <= cutoff) i++;
    if (i > 0) arr.splice(0, i);
    if (arr.length >= this.max) return false;
    arr.push(now());
    return true;
  }

  /** 被拒后还要等几秒才有名额 = 最老的那次命中滑出窗口的时刻。
   *  给 429 的 Retry-After 用:不给这个头,Agent 只能瞎猜退避时长 ——
   *  猜短了继续撞墙(每次撞墙又不计数,但白跑一轮 RTT),猜长了白等一分钟。
   *  窗口内无命中(理论上不该在被拒后发生)时回 1,不回 0:0 秒退避等于不退避。 */
  retryAfterSeconds(key: string): number {
    const arr = this.hits.get(key);
    const oldest = arr?.[0];
    if (oldest === undefined) return 1;
    return Math.max(1, Math.ceil((oldest + this.windowMs - now()) / 1000));
  }

  /** 惰性回收:删掉窗口内已无命中的 key,防内存无限增长。调用方可定时触发。 */
  sweep(): void {
    const cutoff = now() - this.windowMs;
    for (const [key, arr] of this.hits) {
      while (arr.length && arr[0]! <= cutoff) arr.shift();
      if (arr.length === 0) this.hits.delete(key);
    }
  }

  /** 当前跟踪的 key 数(测试 / 监控用)。 */
  size(): number {
    return this.hits.size;
  }
}
