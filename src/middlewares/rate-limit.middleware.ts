import { Request, Response, NextFunction } from "express";

// Lightweight in-memory rate limiter + progressive lockout for auth endpoints.
// No external dependency: a single-process, per-IP sliding counter. Good enough
// to blunt credential-stuffing / brute force on /auth/login. If the backend is
// ever scaled to multiple instances, replace with a shared store (Redis).

type Bucket = {
  hits: number[]; // timestamps (ms) of attempts within the window
  lockedUntil: number; // epoch ms; 0 = not locked
  strikes: number; // consecutive lockouts, drives progressive backoff
};

const buckets = new Map<string, Bucket>();

// Periodically drop idle buckets so the map does not grow unbounded.
const SWEEP_MS = 10 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [key, b] of buckets) {
    if (b.lockedUntil < now && (b.hits.length === 0 || now - b.hits[b.hits.length - 1] > SWEEP_MS)) {
      buckets.delete(key);
    }
  }
}, SWEEP_MS).unref?.();

function clientKey(req: Request): string {
  // trust proxy is enabled, so req.ip reflects the real client behind Cloudflare.
  return req.ip || req.socket.remoteAddress || "unknown";
}

export interface RateLimitOptions {
  windowMs: number; // sliding window size
  max: number; // max attempts per window before a lockout
  baseLockMs: number; // first lockout duration; grows with repeated strikes
  maxLockMs: number; // cap on lockout duration
}

/**
 * Rate-limit + progressive lockout by client IP. On exceeding `max` attempts
 * within `windowMs`, the IP is locked for baseLockMs * 2^(strikes-1) (capped).
 * Returns HTTP 429 with a Retry-After header while locked.
 */
export function rateLimit(opts: RateLimitOptions) {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = clientKey(req);
    const now = Date.now();
    const b = buckets.get(key) ?? { hits: [], lockedUntil: 0, strikes: 0 };

    if (b.lockedUntil > now) {
      const retryAfter = Math.ceil((b.lockedUntil - now) / 1000);
      res.setHeader("Retry-After", String(retryAfter));
      buckets.set(key, b);
      return res.status(429).json({ message: "Too many attempts. Please try again later." });
    }

    // Drop attempts outside the sliding window.
    b.hits = b.hits.filter((t) => now - t < opts.windowMs);
    b.hits.push(now);

    if (b.hits.length > opts.max) {
      b.strikes += 1;
      const lock = Math.min(opts.baseLockMs * 2 ** (b.strikes - 1), opts.maxLockMs);
      b.lockedUntil = now + lock;
      b.hits = [];
      buckets.set(key, b);
      res.setHeader("Retry-After", String(Math.ceil(lock / 1000)));
      return res.status(429).json({ message: "Too many attempts. Please try again later." });
    }

    buckets.set(key, b);
    next();
  };
}

/** Preset for authentication endpoints (login, etc.). */
export const loginRateLimit = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 10, // 10 attempts / 5 min / IP
  baseLockMs: 60 * 1000, // first lockout: 1 min
  maxLockMs: 30 * 60 * 1000, // cap: 30 min
});
