const { MAX_MESSAGES_PER_USER } = require('../utils/constants');

const cache = new Map();

function getChatMessages(chatProfileId) {
  if (!cache.has(chatProfileId)) cache.set(chatProfileId, []);
  return cache.get(chatProfileId);
}

function append(chatProfileId, message) {
  const rows = getChatMessages(chatProfileId);
  rows.push(message);
  if (rows.length > MAX_MESSAGES_PER_USER * 2) {
    rows.splice(0, rows.length - MAX_MESSAGES_PER_USER);
  }
  return message;
}

function replace(chatProfileId, messages) {
  cache.set(chatProfileId, messages.slice(-MAX_MESSAGES_PER_USER));
}

function list(chatProfileId, limit = MAX_MESSAGES_PER_USER) {
  const rows = getChatMessages(chatProfileId);
  return rows.slice(-limit);
}

function last(chatProfileId) {
  const rows = getChatMessages(chatProfileId);
  return rows.length ? rows[rows.length - 1] : null;
}

function count(chatProfileId) {
  return getChatMessages(chatProfileId).length;
}

function clear(chatProfileId) {
  cache.set(chatProfileId, []);
}

function prune(chatProfileId, keep = MAX_MESSAGES_PER_USER) {
  const rows = getChatMessages(chatProfileId);
  if (rows.length <= keep) return;
  rows.splice(0, rows.length - keep);
}

function nextMessageId() {
  return Number(`${Date.now()}${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}`);
}

module.exports = {
  append,
  replace,
  list,
  last,
  count,
  clear,
  prune,
  nextMessageId,
};
