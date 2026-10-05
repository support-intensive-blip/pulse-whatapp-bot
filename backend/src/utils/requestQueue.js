/**
 * Per-key async mutex and global concurrency limiter for parallel HTTP handlers.
 */

class KeyedQueue {
  constructor() {
    this.tails = new Map();
  }

  run(key, fn) {
    const prev = this.tails.get(key) || Promise.resolve();
    const run = prev
      .catch(() => {})
      .then(() => fn());
    this.tails.set(key, run);
    return run.finally(() => {
      if (this.tails.get(key) === run) {
        this.tails.delete(key);
      }
    });
  }
}

class ConcurrencyLimiter {
  constructor(max) {
    this.max = Math.max(1, max);
    this.active = 0;
    this.waiters = [];
  }

  async acquire() {
    if (this.active < this.max) {
      this.active += 1;
      return;
    }
    await new Promise((resolve) => {
      this.waiters.push(resolve);
    });
    this.active += 1;
  }

  release() {
    this.active = Math.max(0, this.active - 1);
    const next = this.waiters.shift();
    if (next) next();
  }

  async run(fn) {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

module.exports = {
  KeyedQueue,
  ConcurrencyLimiter,
};
