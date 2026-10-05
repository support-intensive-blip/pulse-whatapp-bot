const userService = require('../services/userService');
const chatProfileService = require('../services/chatProfileService');
const contactSelectionService = require('../services/contactSelectionService');

function applyContactAssistantAction(profile, mode) {
  if (mode === 'on') {
    chatProfileService.enableAssistantExplicit(profile.id);
    return `Assistant pinned ON for *${profile.contact_name}*.`;
  }

  chatProfileService.disableAssistant(profile.id);
  return `Assistant OFF for *${profile.contact_name}*.`;
}

function handleContactAction(owner, ownerUserId, contactName, mode) {
  const resolved = chatProfileService.resolveContactQuery(owner.phone, contactName, ownerUserId, {
    action: 'assistant_contact',
    mode,
    label: `Select contact to turn ${mode.toUpperCase()}`,
  });

  if (resolved.message) return resolved.message;
  if (!resolved.profile) return `Contact "${contactName}" not found.`;

  if (!mode || !['on', 'off'].includes(mode)) {
    const pinned = Number(resolved.profile.assistant_pinned_on) === 1 ? 'PINNED ON' : 'not pinned';
    const status = Number(resolved.profile.assistant_active) === 1 ? 'ON' : 'OFF';
    return `*${resolved.profile.contact_name}* assistant: ${status} (${pinned}).\nUse: /assistant contact: ${resolved.profile.contact_name} on|off`;
  }

  return applyContactAssistantAction(resolved.profile, mode);
}

function execute(ownerUserId, args) {
  const owner = userService.findById(ownerUserId);
  if (!owner) return 'Account not found.';

  const text = (args || '').trim().toLowerCase();

  if (!text || text === 'show' || text === 'status') {
    return userService.formatAssistantStatus(owner);
  }

  const selectMatch = args.match(/^select\s+(\d+)$/i);
  if (selectMatch) {
    return executePendingSelection(ownerUserId, parseInt(selectMatch[1], 10));
  }

  const contactMatch = args.match(/contact:\s*([^]+?)(?:\s+(on|off)\s*$|\s*$)/i);
  if (contactMatch) {
    const contactName = contactMatch[1].trim();
    const mode = (contactMatch[2] || '').trim().toLowerCase();
    return handleContactAction(owner, ownerUserId, contactName, mode);
  }

  if (text === 'contacts all off' || text === 'contacts force off' || text === 'all contacts off') {
    userService.setAssistantContacts(ownerUserId, false);
    chatProfileService.forceDisableAllContactAssistants(owner.phone);
    return 'All contact assistants force disabled.';
  }

  if (text === 'contacts on' || text === 'contact on') {
    userService.setAssistantContacts(ownerUserId, true);
    return 'Global contacts ON. Pinned contacts stay active.';
  }

  if (text === 'contacts off' || text === 'contact off') {
    userService.setAssistantContacts(ownerUserId, false);
    return 'Global contacts OFF. Pinned ON contacts stay active. Use /assistant contacts all off to force disable all.';
  }

  if (text === 'self on' || text === 'me on' || text === 'on') {
    userService.setAssistantSelf(ownerUserId, true);
    return 'Assistant enabled in *your self-chat*.';
  }

  if (text === 'self off' || text === 'me off' || text === 'off') {
    userService.setAssistantSelf(ownerUserId, false);
    return 'Self-chat assistant OFF. Silent until /assistant self on';
  }

  return `*Assistant Controls* (self-chat only)

/assistant — show status
/assistant self on|off — your self-chat
/assistant contacts on|off — global contacts (keeps pinned ON)
/assistant contacts all off — force disable ALL contacts
/assistant contact: Name on|off — one contact (pinned ON)
Reply number if name suggestions appear

${userService.formatAssistantStatus(owner)}`;
}

function executePendingSelection(ownerUserId, index) {
  const resolved = contactSelectionService.resolveIndex(ownerUserId, index);
  if (!resolved) {
    return 'Invalid selection. Try the command again.';
  }

  const { profile, pending } = resolved;

  if (pending.action === 'assistant_contact') {
    return applyContactAssistantAction(profile, pending.mode);
  }

  if (pending.action === 'profile_set') {
    const updated = chatProfileService.updateProfile(profile.id, pending.fields || {});
    const owner = userService.findById(ownerUserId);
    return `Profile updated for *${updated.contact_name}*.\n\n${chatProfileService.formatProfile(updated)}`;
  }

  return `Selected *${profile.contact_name}*.`;
}

module.exports = { execute, executePendingSelection };
