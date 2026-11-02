import { randomBytes } from "node:crypto";
import { APPROVAL_TTL_SEC } from "../builders.js";

export interface IssuedNonce<T> {
  nonce: string;
  expiresAt: number;
  meta: T;
}

/** Single-use nonces with a 60 s TTL (§10.1). */
export class NonceStore<T = undefined> {
  private readonly items = new Map<string, IssuedNonce<T>>();
  constructor(
    private readonly now: () => number,
    private readonly ttlSec = APPROVAL_TTL_SEC,
    private readonly max = 256,
  ) {}

  issue(meta: T): IssuedNonce<T> {
    this.sweep();
    if (this.items.size >= this.max) {
      const oldest = this.items.keys().next().value;
      if (oldest !== undefined) this.items.delete(oldest);
    }
    const item = { nonce: randomBytes(16).toString("hex"), expiresAt: this.now() + this.ttlSec, meta };
    this.items.set(item.nonce, item);
    return item;
  }

  peek(nonce: string): IssuedNonce<T> | "expired" | undefined {
    const it = this.items.get(nonce);
    if (!it) return undefined;
    if (this.now() > it.expiresAt) {
      this.items.delete(nonce);
      return "expired";
    }
    return it;
  }

  /** Removes the nonce whatever the outcome; a nonce can be presented once. */
  take(nonce: string): IssuedNonce<T> | "expired" | undefined {
    const r = this.peek(nonce);
    this.items.delete(nonce);
    return r;
  }

  private sweep(): void {
    const t = this.now();
    for (const [k, v] of this.items) if (t > v.expiresAt) this.items.delete(k);
  }
}

/** Sliding-window limiter (5 req/min for the unauthenticated /ui/attach step 1). */
export class RateLimiter {
  private hits: number[] = [];
  constructor(
    private readonly now: () => number,
    private readonly limit: number,
    private readonly windowSec = 60,
  ) {}
  allow(): boolean {
    const t = this.now();
    this.hits = this.hits.filter((h) => t - h < this.windowSec);
    if (this.hits.length >= this.limit) return false;
    this.hits.push(t);
    return true;
  }
}
