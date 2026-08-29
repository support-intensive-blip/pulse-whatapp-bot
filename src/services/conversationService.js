const { getDatabase } = require('../database/db');
const chatProfileService = require('./chatProfileService');
const memoryService = require('./memoryService');
const userService = require('./userService');
const { normalizePhone, pickContactDisplayName, phoneTailDigits, isSkippableWhatsAppChatId, resolveOwnerScopeIds, isPhoneLikeString } = require('../utils/helpers');

function profileContactKey(profile) {
  if (profile.chat_type === 'self') return '__self__';

  const phone = normalizePhone(profile.contact_phone);
  if (phone) return phone;

  const fromChatId = normalizePhone(profile.chat_id);
  if (fromChatId) return fromChatId;

  return `unknown_${profile.id}`;
}

class ConversationService {
  profileContactKey(profile) {
    return profileContactKey(profile);
  }

  profileDedupeKey(profile) {
    if (profile.chat_type === 'self') return '__self__';

    const tail = chatProfileService.profilePhoneTail(profile);
    if (tail.length >= 10) return `phone:${tail}`;

    const name = (profile.contact_name || '').trim().toLowerCase();
    if (name) return `name:${name}`;

    return `chat:${profile.chat_id}`;
  }

  pickPreferredProfile(a, b) {
    return chatProfileService.pickPreferredContactProfile(a, b);
  }

  dedupeProfiles(profiles) {
    const groups = new Map();

    for (const profile of profiles) {
      if (isSkippableWhatsAppChatId(profile.chat_id)) continue;

      let groupKey = null;
      for (const [key, existing] of groups.entries()) {
        if (chatProfileService.profileSharesIdentity(profile, existing)) {
          groupKey = key;
          break;
        }
      }

      if (groupKey) {
        groups.set(groupKey, this.pickPreferredProfile(groups.get(groupKey), profile));
      } else {
        groups.set(this.profileDedupeKey(profile), profile);
      }
    }

    return [...groups.values()];
  }

  fastDedupeProfiles(profiles) {
    const groups = new Map();

    for (const profile of profiles) {
      if (isSkippableWhatsAppChatId(profile.chat_id)) continue;
      const key = this.profileDedupeKey(profile);
      if (groups.has(key)) {
        groups.set(key, this.pickPreferredProfile(groups.get(key), profile));
      } else {
        groups.set(key, profile);
      }
    }

    return [...groups.values()];
  }

  enrichChat(profile, { ownerUser = null, meta = null, assistantFn = null } = {}) {
    const last = meta?.lastMessage ?? memoryService.getLastMessage(profile.id);
    const messageCount = meta?.messageCount ?? memoryService.getMessageCount(profile.id);
    const owner =
      ownerUser || (profile.owner_phone ? userService.findByPhone(profile.owner_phone) : null);
    const assistantActive = assistantFn
      ? assistantFn(profile)
      : chatProfileService.isAssistantActive(profile, owner);

    return {
      id: profile.id,
      chatId: profile.chat_id,
      contactName: pickContactDisplayName(
        [profile.contact_name, profile.contact_phone],
        profile.contact_phone
      ),
      contactPhone: profile.contact_phone,
      contactRole: profile.contact_role,
      chatType: profile.chat_type,
      assistantActive,
      assistantEnabled:
        profile.chat_type === 'contact' && Number(profile.assistant_active) === 1,
      assistantPinned: Number(profile.assistant_pinned_on) === 1,
      aiOn: profile.chat_type === 'contact' && assistantActive,
      conversationMode: profile.conversation_mode || 'casual',
      contextTopic: profile.context_topic || '',
      messageCount,
      lastMessage: last
        ? {
            role: last.role,
            preview: (last.content || '').slice(0, 120),
            timestamp: last.timestamp,
          }
        : null,
      updatedAt: last?.timestamp || profile.updated_at,
    };
  }

  enrichChats(profiles) {
    if (!profiles.length) return [];

    const ownerUser = profiles[0]?.owner_phone
      ? userService.findByPhone(profiles[0].owner_phone)
      : null;
    const assistantFn = chatProfileService.buildAssistantCache(
      profiles[0]?.owner_phone,
      ownerUser
    );
    const metaMap = memoryService.getBatchChatMeta(profiles.map((p) => p.id));

    return profiles.map((profile) =>
      this.enrichChat(profile, {
        ownerUser,
        meta: metaMap.get(profile.id),
        assistantFn,
      })
    );
  }

  listContactsForOwner(ownerPhone, waContacts = [], { search = '', limit = 500 } = {}) {
    const owner = normalizePhone(ownerPhone);
    if (!owner) return [];

    const profiles = chatProfileService.getByOwner(owner);
    const map = new Map();

    const ensureContact = (key, seed = {}) => {
      if (!map.has(key)) {
        map.set(key, {
          key,
          contactPhone: seed.contactPhone || null,
          contactName: seed.contactName || seed.contactPhone || 'Unknown',
          isMyContact: Boolean(seed.isMyContact),
          chatCount: 0,
          lastActivity: null,
          lastPreview: null,
        });
      }
      return map.get(key);
    };

    for (const contact of waContacts) {
      const phone = normalizePhone(contact.contactPhone);
      if (!phone) continue;
      ensureContact(phone, contact);
    }

    for (const profile of profiles) {
      const key = profileContactKey(profile);
      const displayName =
        profile.chat_type === 'self'
          ? profile.contact_name || 'You (Self Chat)'
          : pickContactDisplayName(
              [profile.contact_name, profile.contact_phone],
              profile.contact_phone
            );
      const contact = ensureContact(key, {
        contactPhone: profile.contact_phone,
        contactName: displayName,
        isMyContact: false,
      });

      contact.chatCount += 1;

      const enriched = this.enrichChat(profile);
      const ts = enriched.updatedAt;
      if (!contact.lastActivity || new Date(ts) > new Date(contact.lastActivity)) {
        contact.lastActivity = ts;
        contact.lastPreview = enriched.lastMessage?.preview || null;
      }

      if (profile.contact_name && !isPhoneLikeString(profile.contact_name)) {
        contact.contactName = profile.contact_name;
      } else if (!contact.contactName || contact.contactName === 'Unknown') {
        contact.contactName = displayName;
      }
    }

    let contacts = [...map.values()];

    if (search.trim()) {
      const q = search.trim().toLowerCase();
      contacts = contacts.filter((contact) => {
        const name = (contact.contactName || '').toLowerCase();
        const phone = (contact.contactPhone || '').toLowerCase();
        return name.includes(q) || phone.includes(q);
      });
    }

    return contacts
      .slice(0, limit)
      .sort((a, b) => {
        const ta = new Date(a.lastActivity || 0).getTime();
        const tb = new Date(b.lastActivity || 0).getTime();
        if (tb !== ta) return tb - ta;
        return (a.contactName || '').localeCompare(b.contactName || '');
      });
  }

  listChatsForContact(ownerPhone, contactKey, { search = '', limit = 50 } = {}) {
    const owner = normalizePhone(ownerPhone);
    if (!owner || !contactKey) return [];

    let profiles = chatProfileService
      .getByOwner(owner)
      .filter((profile) => profileContactKey(profile) === contactKey);

    if (search.trim()) {
      const q = search.trim().toLowerCase();
      profiles = profiles.filter((profile) => {
        const name = (profile.contact_name || '').toLowerCase();
        const phone = (profile.contact_phone || '').toLowerCase();
        const role = (profile.contact_role || '').toLowerCase();
        return name.includes(q) || phone.includes(q) || role.includes(q);
      });
    }

    const enriched = this.enrichChats(profiles.slice(0, limit));
    return enriched.sort((a, b) => {
        const ta = new Date(a.updatedAt || 0).getTime();
        const tb = new Date(b.updatedAt || 0).getTime();
        return tb - ta;
      });
  }

  listForOwner(ownerPhone, { search = '', assistant = 'all', limit = 200, consolidate = false } = {}) {
    const owner = normalizePhone(ownerPhone);
    if (!owner) return [];

    if (consolidate) {
      chatProfileService.consolidateOwnerContactProfiles(owner);
      chatProfileService.consolidateImportedDuplicates(ownerPhone);
    }

    let profiles = chatProfileService.getByOwner(owner);
    profiles = this.fastDedupeProfiles(profiles);

    if (search.trim()) {
      const q = search.trim().toLowerCase();
      profiles = profiles.filter((p) => {
        const name = (p.contact_name || '').toLowerCase();
        const phone = (p.contact_phone || '').toLowerCase();
        const role = (p.contact_role || '').toLowerCase();
        return name.includes(q) || phone.includes(q) || role.includes(q);
      });
    }

    // Filter assistant state and sort by profile updated_at BEFORE enriching.
    // Enriching 10k+ profiles (message meta scan) was exceeding the dashboard 15s timeout.
    const ownerUser = owner ? userService.findByPhone(owner) : null;
    const assistantFn = chatProfileService.buildAssistantCache(owner, ownerUser);
    if (assistant === 'enabled') {
      profiles = profiles.filter((p) => assistantFn(p));
    } else if (assistant === 'disabled') {
      profiles = profiles.filter((p) => !assistantFn(p));
    }

    profiles.sort((a, b) => {
      const ta = new Date(a.updated_at || 0).getTime();
      const tb = new Date(b.updated_at || 0).getTime();
      return tb - ta;
    });

    return this.enrichChats(profiles.slice(0, limit));
  }

  exportChats(ownerPhone, chatProfileIds = null, options = {}) {
    const owner = normalizePhone(ownerPhone);
    let profiles = chatProfileService.getByOwner(owner);

    if (Array.isArray(chatProfileIds) && chatProfileIds.length > 0) {
      const idSet = new Set(chatProfileIds.map(Number));
      profiles = profiles.filter((p) => idSet.has(p.id));
    }

    const fromMs = this.parseExportBound(options.from);
    const toMs = this.parseExportBound(options.to);

    return profiles.map((profile) => {
      let messages = memoryService.getMessages(profile.id, 10000);
      if (fromMs != null || toMs != null) {
        messages = messages.filter((msg) => {
          const ts = new Date(msg.timestamp).getTime();
          if (Number.isNaN(ts)) return false;
          if (fromMs != null && ts < fromMs) return false;
          if (toMs != null && ts > toMs) return false;
          return true;
        });
      }
      return {
        chat: this.enrichChat(profile),
        messages,
      };
    });
  }

  parseExportBound(value) {
    if (value == null || value === '') return null;
    const date = new Date(value);
    const ms = date.getTime();
    return Number.isNaN(ms) ? null : ms;
  }

  /**
   * CSV columns: contact_name, time, incoming_message, bot_message, response_source
   * Rows pair a student (incoming) message with the following bot reply when possible.
   * response_source reflects whether the paired bot_message was answered from the
   * knowledge base (kb_meta.chunkCount > 0) or was a plain prompt-only reply.
   */
  toCsv(exportData) {
    const { formatISTDateTime } = require('../utils/time');
    const lines = ['contact_name,time,incoming_message,bot_message,response_source'];

    const csvCell = (value) => `"${String(value || '').replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
    const responseSource = (msg) => {
      const chunkCount = msg?.kbMeta?.chunkCount;
      return typeof chunkCount === 'number' && chunkCount > 0 ? 'KB Used' : 'Prompt Only';
    };

    for (const block of exportData) {
      const contactName = block.chat.contactName || 'Contact';
      const messages = Array.isArray(block.messages) ? block.messages : [];
      let i = 0;
      while (i < messages.length) {
        const msg = messages[i];
        const role = msg.role;

        if (role === 'user' || role === 'contact' || (!role && msg.source === 'whatsapp')) {
          const incoming = msg.content || '';
          const time = formatISTDateTime(msg.timestamp);
          const next = messages[i + 1];
          if (next && next.role === 'assistant') {
            lines.push(
              [
                csvCell(contactName),
                csvCell(time),
                csvCell(incoming),
                csvCell(next.content || ''),
                csvCell(responseSource(next)),
              ].join(',')
            );
            i += 2;
            continue;
          }
          lines.push(
            [csvCell(contactName), csvCell(time), csvCell(incoming), csvCell(''), csvCell('')].join(',')
          );
          i += 1;
          continue;
        }

        if (role === 'assistant') {
          lines.push(
            [
              csvCell(contactName),
              csvCell(formatISTDateTime(msg.timestamp)),
              csvCell(''),
              csvCell(msg.content || ''),
              csvCell(responseSource(msg)),
            ].join(',')
          );
        }
        i += 1;
      }
    }
    return lines.join('\n');
  }

  exportMessageName(msg, contactName) {
    if (msg.role === 'assistant') return 'AI';
    if (msg.role === 'owner') return 'You';
    return contactName || 'Contact';
  }

  toExportJson(exportData) {
    const { formatISTDateTime } = require('../utils/time');
    return {
      exportedAt: formatISTDateTime(new Date().toISOString()),
      timezone: 'Asia/Kolkata',
      chats: exportData.map((block) => ({
        contactName: block.chat.contactName,
        contactPhone: block.chat.contactPhone || null,
        messages: block.messages.map((msg) => ({
          time: formatISTDateTime(msg.timestamp),
          role: msg.role,
          name: this.exportMessageName(msg, block.chat.contactName),
          message: msg.content || '',
        })),
      })),
    };
  }

  getOwnerStats(ownerPhone) {
    return this.getStatsForOwnerPhones(ownerPhone ? [ownerPhone] : []);
  }

  getStatsForOwnerPhones(ownerPhones = []) {
    const phones = [...new Set((ownerPhones || []).map((p) => normalizePhone(p)).filter(Boolean))];
    if (!phones.length) {
      return {
        totalChats: 0,
        activeChats: 0,
        totalMessages: 0,
        messagesToday: 0,
        aiResponses: 0,
      };
    }

    const db = require('../database/db').getDatabase();
    const { profileIds } = resolveOwnerScopeIds(db, phones);
    if (!profileIds.length) {
      return {
        totalChats: 0,
        activeChats: 0,
        totalMessages: 0,
        messagesToday: 0,
        aiResponses: 0,
      };
    }

    const placeholders = profileIds.map(() => '?').join(',');

    const totalChats =
      db
        .prepare(
          `SELECT COUNT(*) as count FROM chat_profiles
           WHERE id IN (${placeholders}) AND chat_type = 'contact'`
        )
        .get(...profileIds)?.count || 0;
    const activeChats =
      db
        .prepare(
          `SELECT COUNT(*) as count FROM chat_profiles
           WHERE id IN (${placeholders}) AND chat_type = 'contact'
           AND assistant_active = 1`
        )
        .get(...profileIds)?.count || 0;
    const totalMessages =
      db
        .prepare(
          `SELECT COUNT(*) as count FROM messages
           WHERE chat_profile_id IN (${placeholders})`
        )
        .get(...profileIds)?.count || 0;
    const messagesToday =
      db
        .prepare(
          `SELECT COUNT(*) as count FROM messages
           WHERE chat_profile_id IN (${placeholders})
           AND date(timestamp) = date('now')`
        )
        .get(...profileIds)?.count || 0;
    const aiResponses =
      db
        .prepare(
          `SELECT COUNT(*) as count FROM messages
           WHERE chat_profile_id IN (${placeholders})
           AND role = 'assistant'`
        )
        .get(...profileIds)?.count || 0;

    return { totalChats, activeChats, totalMessages, messagesToday, aiResponses };
  }
}

module.exports = new ConversationService();
