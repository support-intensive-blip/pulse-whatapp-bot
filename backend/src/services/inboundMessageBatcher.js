const logger = require('../utils/logger');

const BATCH_WINDOW_MS = Math.max(
  1000,
  Number(process.env.INBOUND_BATCH_WINDOW_MS) || 10000
);

/**
 * Debounce inbound student messages per chat so rapid texts/images
 * become one combined LLM turn (single KB retrieval + one reply).
 */
class InboundMessageBatcher {
  constructor(windowMs = BATCH_WINDOW_MS) {
    this.windowMs = windowMs;
    this.queues = new Map();
  }

  enqueue({ key, fragment, onFlush, onQueued = null, windowMs = null }) {
    const text = String(fragment || '').trim();
    if (!key || !text) return false;

    const effectiveWindowMs = windowMs != null && windowMs >= 0 ? windowMs : this.windowMs;

    let entry = this.queues.get(key);
    if (!entry) {
      entry = {
        fragments: [],
        timer: null,
        onFlush: null,
        flushing: false,
      };
      this.queues.set(key, entry);
    }

    if (entry.flushing) {
      // Rare race: flush in progress — start a fresh queue for follow-ups.
      entry = {
        fragments: [],
        timer: null,
        onFlush: null,
        flushing: false,
      };
      this.queues.set(key, entry);
    }

    entry.fragments.push(text);
    entry.onFlush = onFlush;

    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      this.flush(key).catch((error) => {
        logger.error(`Inbound batch flush error key=${key}: ${error.message}`);
      });
    }, effectiveWindowMs);

    logger.info(
      `Inbound batch queued key=${key} parts=${entry.fragments.length} windowMs=${effectiveWindowMs}`
    );

    if (typeof onQueued === 'function') {
      try {
        onQueued({
          partCount: entry.fragments.length,
          windowMs: effectiveWindowMs,
        });
      } catch (error) {
        logger.warn(`Inbound batch onQueued failed: ${error.message}`);
      }
    }

    return true;
  }

  async flush(key) {
    const entry = this.queues.get(key);
    if (!entry || entry.flushing) return null;

    entry.flushing = true;
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    this.queues.delete(key);

    const fragments = entry.fragments.filter(Boolean);
    if (!fragments.length || typeof entry.onFlush !== 'function') {
      return null;
    }

    const combined =
      fragments.length === 1
        ? fragments[0]
        : [
            `The student sent ${fragments.length} messages within a few seconds. Treat them as one turn.`,
            '',
            ...fragments.map((part, index) => `Message ${index + 1}:\n${part}`),
          ].join('\n\n');

    logger.info(
      `Inbound batch flush key=${key} parts=${fragments.length} chars=${combined.length}`
    );

    return entry.onFlush({
      combined,
      fragments,
      partCount: fragments.length,
    });
  }

  pendingCount(key) {
    return this.queues.get(key)?.fragments?.length || 0;
  }

  clear(key) {
    const entry = this.queues.get(key);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    this.queues.delete(key);
  }
}

module.exports = {
  inboundMessageBatcher: new InboundMessageBatcher(),
  InboundMessageBatcher,
  BATCH_WINDOW_MS,
};
