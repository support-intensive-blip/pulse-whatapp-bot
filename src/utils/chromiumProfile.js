const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const STALE_LOCK_NAMES = new Set([
  'SingletonLock',
  'SingletonSocket',
  'SingletonCookie',
  'lockfile',
]);

function walkDir(dir, onFile) {
  if (!fs.existsSync(dir)) return;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(fullPath, onFile);
      continue;
    }
    onFile(fullPath, entry.name);
  }
}

function clearStaleChromiumLocks(dataPath = '.wwebjs_auth') {
  const root = path.resolve(process.cwd(), dataPath);
  if (!fs.existsSync(root)) return 0;

  let removed = 0;

  walkDir(root, (fullPath, name) => {
    if (!STALE_LOCK_NAMES.has(name)) return;

    try {
      fs.rmSync(fullPath, { force: true });
      removed += 1;
      logger.info(`Removed stale Chromium lock: ${fullPath}`);
    } catch (error) {
      logger.warn(`Could not remove Chromium lock ${fullPath}: ${error.message}`);
    }
  });

  if (removed > 0) {
    logger.info(`Cleared ${removed} stale Chromium lock file(s) under ${root}`);
  }

  return removed;
}

function isChromiumProfileLockError(error) {
  const message = String(error?.message || error || '');
  return (
    message.includes('Code: 21') ||
    message.includes('process_singleton') ||
    message.includes('profile appears to be in use') ||
    message.includes('SingletonLock')
  );
}

function isBrowserTargetClosedError(error) {
  const message = String(error?.message || error || '');
  return (
    message.includes('Target closed') ||
    message.includes('Session closed') ||
    message.includes('Protocol error') ||
    message.includes('Browser has disconnected') ||
    message.includes('Execution context was destroyed') ||
    message.includes('Navigating frame was detached') ||
    message.includes('detached Frame') ||
    message.includes('Promise was collected') ||
    message.includes('timed out') ||
    message.includes('callFunctionOn')
  );
}

function isWWebJsBrokenError(error) {
  const message = String(error?.message || error || '');
  return (
    message.includes("reading 'getChat'") ||
    message.includes("reading 'getChats'") ||
    message.includes("reading 'enforceLidAndPnRetrieval'") ||
    message.includes('WWebJS')
  );
}

function isRecoverableBrowserError(error) {
  return isChromiumProfileLockError(error) || isBrowserTargetClosedError(error) || isWWebJsBrokenError(error);
}

module.exports = {
  clearStaleChromiumLocks,
  isChromiumProfileLockError,
  isBrowserTargetClosedError,
  isWWebJsBrokenError,
  isRecoverableBrowserError,
};
