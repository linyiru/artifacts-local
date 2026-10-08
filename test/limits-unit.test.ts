import { describe, expect, it } from "vitest";
import {
  DOCUMENTED_MAX_REPO_BYTES,
  DOCUMENTED_RATE_LIMIT,
  Faults,
  RateLimiter,
  parseRateLimit,
  seededRandom,
} from "../src/limits.ts";

describe("RateLimiter", () => {
  it("allows `requests` per window per key, then refuses until the window passes", () => {
    let clock = 0;
    const r = new RateLimiter(2, 10_000, () => clock);
    expect([r.take("a"), r.take("a"), r.take("a")]).toEqual([true, true, false]);
    expect(r.take("b")).toBe(true);
    clock = 4_000;
    expect(r.retryAfter("a")).toBe(6);
    expect(r.retryAfter("unseen")).toBe(0);
    clock = 10_000;
    expect(r.take("a")).toBe(true);
  });

  it("rejects non-positive limits", () => {
    expect(() => new RateLimiter(0, 1000)).toThrow(/positive/);
    expect(() => new RateLimiter(1, 0)).toThrow(/positive/);
  });
});

describe("parseRateLimit", () => {
  it("parses <requests>/<seconds> and default", () => {
    expect(parseRateLimit("default")).toEqual(DOCUMENTED_RATE_LIMIT);
    expect(parseRateLimit("")).toEqual({ requests: 2000, windowMs: 10_000 });
    expect(parseRateLimit("5/1")).toEqual({ requests: 5, windowMs: 1000 });
    expect(parseRateLimit("3/0.5")).toEqual({ requests: 3, windowMs: 500 });
    expect(() => parseRateLimit("fast")).toThrow(/invalid rate limit/);
  });

  it("documents a 1 GB repo limit", () => {
    expect(DOCUMENTED_MAX_REPO_BYTES).toBe(1_073_741_824);
  });
});

const seededRun = () => {
  const f = new Faults({ failRate: 0.25, random: seededRandom(42) });
  return Array.from({ length: 1000 }, () => f.shouldFail());
};

describe("Faults", () => {
  it("fails about failRate of requests, deterministically with a seed", () => {
    const a = seededRun();
    expect(a).toEqual(seededRun());
    const failures = a.filter(Boolean).length;
    expect(failures).toBeGreaterThan(200);
    expect(failures).toBeLessThan(300);
  });

  it("never fails at 0 and always at 1", () => {
    expect(new Faults().shouldFail()).toBe(false);
    expect(new Faults().active).toBe(false);
    expect(new Faults({ failRate: 1 }).shouldFail()).toBe(true);
  });

  it("adds latency", async () => {
    const f = new Faults({ latencyMs: 30 });
    expect(f.active).toBe(true);
    const t = Date.now();
    await f.delay();
    expect(Date.now() - t).toBeGreaterThanOrEqual(25);
    await new Faults().delay();
  });

  it("validates options", () => {
    expect(() => new Faults({ failRate: 2 })).toThrow(/between 0 and 1/);
    expect(() => new Faults({ latencyMs: -1 })).toThrow(/at least 0/);
  });

  it("produces values in [0, 1)", () => {
    const r = seededRandom(1);
    for (let i = 0; i < 100; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});
