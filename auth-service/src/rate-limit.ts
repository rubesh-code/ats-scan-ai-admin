/**
 * In-process fixed-window counter for the login route.
 *
 * It complements, not replaces, the database-backed lockout: it resets on
 * restart and is per process. Behind the SSH tunnel every client arrives as
 * 127.0.0.1, so the per-IP limit acts as a second global limit there; it only
 * separates clients once real client addresses reach the service.
 */
export class FixedWindowLimiter {
  private readonly buckets = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = 10_000,
  ) {}

  /** Records a hit and returns how many hits the key has had in the current window. */
  hit(key: string, now: number): number {
    const bucket = this.buckets.get(key);
    if (bucket && now - bucket.start < this.windowMs) {
      bucket.count += 1;
      return bucket.count;
    }
    if (this.buckets.size >= this.maxKeys) this.sweep(now);
    this.buckets.set(key, { start: now, count: 1 });
    return 1;
  }

  isOver(count: number): boolean {
    return count > this.limit;
  }

  /** True only for the first refused hit in a window, so a flood writes one audit row, not thousands. */
  isFirstRefusal(count: number): boolean {
    return count === this.limit + 1;
  }

  private sweep(now: number) {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.start >= this.windowMs) this.buckets.delete(key);
    }
    // Still full of live keys: drop them all rather than grow without bound.
    if (this.buckets.size >= this.maxKeys) this.buckets.clear();
  }
}
