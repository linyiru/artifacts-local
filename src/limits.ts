// Opt-in limits and fault injection, to exercise a client's retry and degradation paths.
// The thresholds are the documented ones (Platform → Limits); how the live service answers when
// one is hit is not documented and was not provoked live, so the responses here are guesses.

export const DOCUMENTED_RATE_LIMIT = { requests: 2000, windowMs: 10_000 } as const;
export const DOCUMENTED_MAX_REPO_BYTES = 1024 ** 3;

/** Fixed-window counter per key: `requests` per `windowMs`. */
export class RateLimiter {
  readonly requests: number;
  readonly windowMs: number;
  private windows = new Map<string, { start: number; count: number }>();
  private readonly now: () => number;

  constructor(requests: number, windowMs: number, now: () => number = Date.now) {
    if (!(requests > 0) || !(windowMs > 0)) throw new Error("rate limit needs positive requests and window");
    this.requests = requests;
    this.windowMs = windowMs;
    this.now = now;
  }

  /** Count one request for `key`; false when the window is already full. */
  take(key: string): boolean {
    const t = this.now();
    const w = this.windows.get(key);
    if (!w || t - w.start >= this.windowMs) {
      this.windows.set(key, { start: t, count: 1 });
      return true;
    }
    if (w.count >= this.requests) return false;
    w.count++;
    return true;
  }

  /** Seconds until `key` may send again. */
  retryAfter(key: string): number {
    const w = this.windows.get(key);
    return w ? Math.max(1, Math.ceil((w.start + this.windowMs - this.now()) / 1000)) : 0;
  }
}

/** `2000/10` → 2000 requests per 10 s; `default` → the documented limit. */
export function parseRateLimit(spec: string): { requests: number; windowMs: number } {
  if (spec === "default" || spec === "") return { ...DOCUMENTED_RATE_LIMIT };
  const m = /^(\d+)\/(\d+(?:\.\d+)?)$/.exec(spec);
  if (!m) throw new Error(`invalid rate limit ${JSON.stringify(spec)}; use <requests>/<seconds> or default`);
  return { requests: Number(m[1]), windowMs: Number(m[2]) * 1000 };
}

/** Deterministic PRNG (mulberry32), so a seeded run fails the same requests every time. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface FaultOptions {
  /** Share of requests answered with a 500, 0–1. */
  failRate?: number;
  /** Extra latency added to each request, in ms. */
  latencyMs?: number;
  random?: () => number;
}

export class Faults {
  readonly failRate: number;
  readonly latencyMs: number;
  private readonly random: () => number;

  constructor(opts: FaultOptions = {}) {
    const failRate = opts.failRate ?? 0;
    if (!(failRate >= 0 && failRate <= 1)) throw new Error("fail rate must be between 0 and 1");
    if (!((opts.latencyMs ?? 0) >= 0)) throw new Error("latency must be at least 0");
    this.failRate = failRate;
    this.latencyMs = opts.latencyMs ?? 0;
    this.random = opts.random ?? Math.random;
  }

  get active(): boolean {
    return this.failRate > 0 || this.latencyMs > 0;
  }

  shouldFail(): boolean {
    return this.failRate > 0 && this.random() < this.failRate;
  }

  async delay(): Promise<void> {
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));
  }
}
