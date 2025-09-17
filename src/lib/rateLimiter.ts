type RateLimitOutcome = {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
};

interface RateLimitConfig {
  windowMs: number;
  limit: number;
  blockDurationMs?: number;
}

type Entry = {
  timestamps: number[];
  blockedUntil: number;
};

export class SlidingWindowRateLimiter {
  private windowMs: number;
  private limit: number;
  private blockDurationMs: number;
  private store: Map<string, Entry>;

  constructor(config: RateLimitConfig) {
    this.windowMs = config.windowMs;
    this.limit = config.limit;
    this.blockDurationMs = config.blockDurationMs || config.windowMs;
    this.store = new Map();
  }

  hit(key: string, now = Date.now()): RateLimitOutcome {
    const entry = this.store.get(key) || { timestamps: [], blockedUntil: 0 };
    if (entry.blockedUntil > now) {
      return { allowed: false, remaining: 0, retryAfterMs: entry.blockedUntil - now };
    }

    const cutoff = now - this.windowMs;
    entry.timestamps = entry.timestamps.filter((ts) => ts > cutoff);
    if (entry.timestamps.length >= this.limit) {
      entry.blockedUntil = now + this.blockDurationMs;
      this.store.set(key, entry);
      return { allowed: false, remaining: 0, retryAfterMs: this.blockDurationMs };
    }

    entry.timestamps.push(now);
    this.store.set(key, entry);
    return {
      allowed: true,
      remaining: Math.max(this.limit - entry.timestamps.length, 0),
      retryAfterMs: 0
    };
  }
}

export function throwIfLimited(result: RateLimitOutcome, context: string): void {
  if (result.allowed) return;
  console.warn('[rate-limit]', context, { retryAfterMs: result.retryAfterMs });
  const err = new Error('rate_limited:' + context);
  (err as any).status = 429;
  (err as any).retryAfterMs = result.retryAfterMs;
  throw err;
}
