import { RelayError } from "./protocol.js";

type Failure = { count: number; lastFailureAt: number; blockedUntil: number };

export class LoginThrottle {
  private readonly failures = new Map<string, Failure>();
  private readonly maxEntries: number;
  private readonly freeFailures: number;

  constructor(options: { maxEntries?: number; freeFailures?: number } = {}) {
    this.maxEntries = options.maxEntries ?? 10_000;
    this.freeFailures = options.freeFailures ?? 3;
  }

  private prune(at: number) {
    for (const [key, failure] of this.failures) {
      if (at - failure.lastFailureAt > 60 * 60 * 1000) this.failures.delete(key);
    }
    while (this.failures.size >= this.maxEntries) {
      const oldest = this.failures.keys().next().value;
      if (oldest === undefined) break;
      this.failures.delete(oldest);
    }
  }

  assertAllowed(key: string, at = Date.now()) {
    const failure = this.failures.get(key);
    if (!failure) return;
    if (at - failure.lastFailureAt > 60 * 60 * 1000) {
      this.failures.delete(key);
      return;
    }
    if (failure.blockedUntil > at) {
      throw new RelayError("RATE_LIMITED", "登录尝试过于频繁", {
        retryAfterMs: failure.blockedUntil - at,
      });
    }
  }

  failed(key: string, at = Date.now()) {
    this.prune(at);
    const previous = this.failures.get(key);
    const count = previous && at - previous.lastFailureAt < 60 * 60 * 1000 ? previous.count + 1 : 1;
    const delay = count < this.freeFailures ? 0 : Math.min(15 * 60 * 1000, 1000 * 2 ** Math.min(count - this.freeFailures, 10));
    if (previous) this.failures.delete(key);
    this.failures.set(key, { count, lastFailureAt: at, blockedUntil: at + delay });
    return delay;
  }

  succeeded(key: string) {
    this.failures.delete(key);
  }

  size() {
    return this.failures.size;
  }
}
