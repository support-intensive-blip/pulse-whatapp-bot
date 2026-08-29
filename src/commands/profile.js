const chatProfileService = require('../services/chatProfileService');
const userService = require('../services/userService');

function execute(chatProfileId, ownerUserId, args, isSelfChat = false) {
  const owner = userService.findById(ownerUserId);
  let profile = chatProfileService.findById(chatProfileId);

  if (!profile) {
    return 'No chat profile found.';
  }

  const isSetting = args && args.trim() && !['show'].includes(args.trim().toLowerCase());

  if (isSetting && !isSelfChat) {
    return 'Profile settings can only be changed in *Message Yourself* chat.\n\nOpen your self-chat and use:\n/profile set contact: Name role: ... relations: ...';
  }

  if (!args || !args.trim() || args.trim().toLowerCase() === 'show') {
    return chatProfileService.formatProfile(profile);
  }

  const parseArgs = args.trim().toLowerCase().startsWith('set') ? args.trim().slice(3).trim() : args;
  const fields = chatProfileService.parseProfileArgs(parseArgs);

  if (Object.keys(fields).length === 0) {
    return isSelfChat
      ? 'Usage: /profile set contact: Name role: colleague responsibilities: stack relations: teammate'
      : chatProfileService.formatProfile(profile);
  }

  let targetProfile = profile;
  const contactQuery = fields.target_contact;

  if (contactQuery && isSelfChat) {
    delete fields.target_contact;

    const resolved = chatProfileService.resolveContactQuery(owner.phone, contactQuery, ownerUserId, {
      action: 'profile_set',
      fields,
      label: 'Select contact for profile update',
    });

    if (resolved.message) return resolved.message;
    if (!resolved.profile) {
      return `Contact "${contactQuery}" not found. Send /contacts to see synced chats.`;
    }

    targetProfile = resolved.profile;
  }

  const updated = chatProfileService.updateProfile(targetProfile.id, fields);
  return `Profile updated for *${updated.contact_name || 'contact'}*.\n\n${chatProfileService.formatProfile(updated)}`;
}

module.exports = { execute };
