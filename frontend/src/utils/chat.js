export function isContactChat(chat) {
  if (!chat) return false;
  if (chat.chatType === 'self') return false;
  if (chat.chatType === 'contact') return true;
  const name = String(chat.contactName || '').toLowerCase();
  return !name.includes('self chat') && name !== 'you (self chat)';
}

export function isContactAiOn(chat) {
  if (!isContactChat(chat)) return false;
  if (chat.aiOn != null) return Boolean(chat.aiOn);
  return Boolean(chat.assistantActive || chat.assistantEnabled || chat.assistantPinned);
}
