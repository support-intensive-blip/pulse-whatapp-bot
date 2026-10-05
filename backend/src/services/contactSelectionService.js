class ContactSelectionService {
  constructor() {
    this.pending = new Map();
  }

  setPending(ownerUserId, data) {
    this.pending.set(ownerUserId, {
      ...data,
      createdAt: Date.now(),
    });
  }

  getPending(ownerUserId) {
    return this.pending.get(ownerUserId) || null;
  }

  hasPending(ownerUserId) {
    return this.pending.has(ownerUserId);
  }

  clearPending(ownerUserId) {
    this.pending.delete(ownerUserId);
  }

  resolveIndex(ownerUserId, index) {
    const pending = this.getPending(ownerUserId);
    if (!pending || !pending.profiles?.length) return null;

    const selected = pending.profiles[index - 1];
    if (!selected) return null;

    const resolved = { profile: selected, pending };
    this.clearPending(ownerUserId);
    return resolved;
  }

  isNumericSelection(body) {
    return /^\d+$/.test((body || '').trim());
  }

  parseSelectionIndex(body) {
    const match = (body || '').trim().match(/^(\d+)$/);
    return match ? parseInt(match[1], 10) : null;
  }
}

module.exports = new ContactSelectionService();
