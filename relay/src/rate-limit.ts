import { RelayError } from "./protocol.js";

type Failure = { count: number; lastFailureAt: number; blockedUntil: number };

type PersistentFailures = {
  rateLimitGet(key: string): Failure | undefined;
  rateLimitSet(key: string, value: Failure): void;
  rateLimitDelete(key: string): void;
  rateLimitPrune(before: number, maxEntries: number): void;
  rateLimitSize(): number;
};

export class LoginThrottle {
  private readonly failures = new Map<string, Failure>();
  private readonly maxEntries: number;
  private readonly freeFailures: number;
  private readonly persistent?: PersistentFailures;

  constructor(options: { maxEntries?: number; freeFailures?: number; persistent?: PersistentFailures } = {}) {
    this.maxEntries = options.maxEntries ?? 10_000;
    this.freeFailures = options.freeFailures ?? 3;
    this.persistent = options.persistent;
  }

  private prune(at: number) {
    if (this.persistent) {
      this.persistent.rateLimitPrune(at - 60 * 60 * 1000, this.maxEntries);
      return;
    }
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
    const failure = this.persistent?.rateLimitGet(key) ?? this.failures.get(key);
    if (!failure) return;
    if (at - failure.lastFailureAt > 60 * 60 * 1000) {
      this.succeeded(key);
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
    const previous = this.persistent?.rateLimitGet(key) ?? this.failures.get(key);
    const count = previous && at - previous.lastFailureAt < 60 * 60 * 1000 ? previous.count + 1 : 1;
    const delay = count < this.freeFailures ? 0 : Math.min(15 * 60 * 1000, 1000 * 2 ** Math.min(count - this.freeFailures, 10));
    const value = { count, lastFailureAt: at, blockedUntil: at + delay };
    if (this.persistent) this.persistent.rateLimitSet(key, value);
    else {
      if (previous) this.failures.delete(key);
      this.failures.set(key, value);
    }
    return delay;
  }

  succeeded(key: string) {
    if (this.persistent) this.persistent.rateLimitDelete(key);
    else this.failures.delete(key);
  }

  size() {
    return this.persistent?.rateLimitSize() ?? this.failures.size;
  }
}
