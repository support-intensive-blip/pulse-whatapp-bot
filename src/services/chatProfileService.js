const { getDatabase } = require('../database/db');
const { getGroqClient } = require('../ai/groqClient');
const { MODEL_TIERS, getChatTemperature } = require('../config/modelConfig');
const { TOKEN_CATEGORIES } = require('../config/tokenCategories');
const userService = require('./userService');
const logger = require('../utils/logger');
const { normalizePhone, normalizePhoneDigits, canonicalContactPhone, phoneTailDigits, extractPhoneTailFromText, shouldPreferContactName, isPhoneLikeString, isLikelyLidPhone, sleep, withTimeout, awaitWithAbort, isSkippableWhatsAppChatId, serializeWhatsAppChatId, pickContactDisplayName } = require('../utils/helpers');
const { isRecoverableBrowserError } = require('../utils/chromiumProfile');

class ChatProfileService {
  constructor() {
    this._syncLocks = new Map();
  }

  _syncKey(ownerPhone) {
    return normalizePhone(ownerPhone) || 'unknown';
  }

  _beginSync(ownerPhone) {
    const key = this._syncKey(ownerPhone);
    const existing = this._syncLocks.get(key);
    if (existing) {
      logger.info(`Chat sync already in progress for ${key}, waiting`);
      return { wait: true, promise: existing.promise };
    }

    let resolve;
    const promise = new Promise((res) => {
      resolve = res;
    });
    this._syncLocks.set(key, { promise, resolve });
    return { wait: false, promise };
  }

  _finishSync(ownerPhone, result) {
    const key = this._syncKey(ownerPhone);
    const entry = this._syncLocks.get(key);
    if (entry?.resolve) {
      entry.resolve(result);
    }
    this._syncLocks.delete(key);
  }

  _isSyncInProgress(ownerPhone) {
    return this._syncLocks.has(this._syncKey(ownerPhone));
  }

  _setSyncInProgress(ownerPhone, value) {
    // Legacy no-op — use _beginSync/_finishSync.
    if (!value) this._finishSync(ownerPhone, 0);
  }
  findByChatId(chatId) {
    const db = getDatabase();
    return db.prepare('SELECT * FROM chat_profiles WHERE chat_id = ?').get(chatId) || null;
  }

  findByChatIdForOwner(chatId, ownerPhone) {
    if (!chatId || !ownerPhone) return null;
    const db = getDatabase();
    const owner = normalizePhone(ownerPhone);
    return (
      db
        .prepare('SELECT * FROM chat_profiles WHERE chat_id = ? AND owner_phone = ?')
        .get(chatId, owner) || null
    );
  }

  pickPreferredContactProfile(a, b) {
    if (!a) return b;
    if (!b) return a;

    const score = (profile) => {
      let value = 0;
      if (String(profile.chat_id || '').includes('manual.import')) value -= 1000;
      if (profile.contact_name) value += 20;
      if (!isSkippableWhatsAppChatId(profile.chat_id)) value += 10;
      return value;
    };

    return score(a) >= score(b) ? a : b;
  }

  resolveStorageProfile(profile) {
    if (!profile) return profile;
    if (profile.chat_type !== 'contact') return profile;

    const siblings = this.getSiblingProfiles(profile);
    if (siblings.length <= 1) return profile;

    return siblings.reduce((best, next) => this.pickPreferredContactProfile(best, next));
  }

  effectiveContactPhone(profile, realPhone = null) {
    if (realPhone && !isLikelyLidPhone(realPhone)) {
      return canonicalContactPhone(realPhone) || normalizePhone(realPhone);
    }
    const stored = profile?.contact_phone;
    if (stored && !isLikelyLidPhone(stored)) {
      return canonicalContactPhone(stored) || normalizePhone(stored);
    }
    return null;
  }

  profilePhoneTail(profile) {
    if (!profile) return '';

    const fromPhone = this.effectiveContactPhone(profile);
    if (fromPhone) {
      const tail = phoneTailDigits(fromPhone);
      if (tail.length >= 10 && !isLikelyLidPhone(tail)) return tail;
    }

    const fromName = extractPhoneTailFromText(profile.contact_name);
    if (fromName.length >= 10) return fromName;

    const chatId = String(profile.chat_id || '');
    if (chatId && !chatId.endsWith('@lid') && !chatId.includes('@manual.import')) {
      const tail = phoneTailDigits(normalizePhone(chatId));
      if (tail.length >= 10 && !isLikelyLidPhone(tail)) return tail;
    }

    return '';
  }

  isApiTestProfile(profile) {
    const chatId = String(profile?.chat_id || '');
    return chatId.startsWith('api-test-') || chatId.endsWith('@pulse.test');
  }

  profileSharesIdentity(a, b) {
    if (!a || !b) return false;
    if (a.id === b.id) return true;

    if (String(a.chat_id || '') === String(b.chat_id || '') && a.chat_id) return true;

    // Eval/test API chats must stay isolated — they all used to share
    // contact_name "API Test Contact", which pulled sibling history (and
    // a sticky Telugu DSA thread) into every new session and tanked scores.
    if (this.isApiTestProfile(a) || this.isApiTestProfile(b)) {
      return false;
    }

    if (this.matchesImportedContact(a, b) || this.matchesImportedContact(b, a)) {
      return true;
    }

    const tailA = this.profilePhoneTail(a);
    const tailB = this.profilePhoneTail(b);
    if (tailA.length >= 10 && tailA === tailB) return true;

    return this.contactNamesMatch(a.contact_name, b.contact_name);
  }

  getSiblingProfiles(profile) {
    if (!profile) return [];
    if (profile.chat_type !== 'contact') return [profile];

    // Isolated API eval chats never share memory across sessions.
    if (this.isApiTestProfile(profile)) return [profile];

    const owner = normalizePhone(profile.owner_phone);
    const db = getDatabase();
    const all = db
      .prepare(
        `SELECT * FROM chat_profiles
         WHERE owner_phone = ? AND chat_type = 'contact'`
      )
      .all(owner);

    return all.filter((candidate) => this.profileSharesIdentity(profile, candidate));
  }

  consolidateProfileGroup(profile, ownerPhone = null) {
    if (!profile || profile.chat_type !== 'contact') return profile;

    const siblings = this.getSiblingProfiles(profile);
    if (siblings.length <= 1) return profile;

    let keep = siblings.reduce((best, next) => this.pickPreferredContactProfile(best, next));
    for (const sibling of siblings) {
      if (sibling.id === keep.id) continue;
      const latestKeep = this.findById(keep.id);
      if (!latestKeep) break;
      keep = this.mergeProfiles(latestKeep.id, sibling.id);
    }

    if (ownerPhone && keep.chat_id?.includes('@manual.import')) {
      const whatsappSibling = siblings.find((s) => !String(s.chat_id || '').includes('@manual.import'));
      if (whatsappSibling) {
        const refreshed = this.findById(whatsappSibling.id) || whatsappSibling;
        keep = this.mergeProfiles(refreshed.id, keep.id);
      }
    }

    logger.info(
      `Consolidated ${siblings.length} profile(s) into ${keep.id} (${keep.contact_name || keep.chat_id})`
    );
    return this.findById(keep.id) || keep;
  }

  consolidateImportedDuplicates(ownerPhone) {
    const owner = normalizePhone(ownerPhone);
    if (!owner) return 0;

    const db = getDatabase();
    const profiles = db
      .prepare(
        `SELECT * FROM chat_profiles
         WHERE owner_phone = ? AND chat_type = 'contact'`
      )
      .all(owner);

    // Large owners: skip synchronous full-owner merge (O(n²)). Per-profile
    // consolidateProfileGroup is enough for request paths.
    if (profiles.length > 400) {
      logger.warn(
        `Skipping full duplicate consolidation for owner ${owner} (${profiles.length} contacts)`
      );
      return 0;
    }

    const merged = new Set();
    let count = 0;

    for (const profile of profiles) {
      if (merged.has(profile.id)) continue;
      const siblings = this.getSiblingProfiles(profile).filter((s) => !merged.has(s.id));
      if (siblings.length <= 1) continue;

      this.consolidateProfileGroup(profile, owner);
      siblings.forEach((s) => merged.add(s.id));
      count += siblings.length - 1;
    }

    return count;
  }

  inheritAssistantFromSiblings(profile) {
    if (!profile || profile.chat_type !== 'contact') return profile;
    if (this.isContactPinned(profile)) return profile;
    if (Number(profile.assistant_active) === 1 && !profile.paused_until) return profile;

    const siblings = this.getSiblingProfiles(profile);
    const enabledSibling = siblings.find(
      (s) =>
        s.id !== profile.id &&
        Number(s.assistant_active) === 1 &&
        !s.paused_until
    );
    if (!enabledSibling) return profile;

    return this.resumeAssistant(profile.id, false);
  }

  consolidateOwnerContactProfiles(ownerPhone) {
    const owner = normalizePhone(ownerPhone);
    if (!owner) return 0;

    const profiles = this.getByOwner(owner).filter((p) => p.chat_type === 'contact');
    const groups = new Map();

    for (const profile of profiles) {
      const tail = phoneTailDigits(profile.contact_phone);
      const key = tail.length >= 10
        ? `phone:${tail}`
        : (profile.contact_name || '').trim().toLowerCase() || `id:${profile.id}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(profile);
    }

    let mergedCount = 0;
    for (const group of groups.values()) {
      if (group.length < 2) continue;

      let keep = group[0];
      for (let i = 1; i < group.length; i += 1) {
        const next = group[i];
        const preferred = this.pickPreferredContactProfile(keep, next);
        const drop = preferred.id === keep.id ? next : keep;
        keep = this.mergeProfiles(preferred.id, drop.id);
        mergedCount += 1;
      }
    }

    if (mergedCount > 0) {
      logger.info(`Consolidated ${mergedCount} duplicate contact profile(s) for owner ${owner}`);
    }
    return mergedCount;
  }

  findByContactPhone(ownerPhone, contactPhone) {
    if (!contactPhone) return null;

    const owner = normalizePhone(ownerPhone);
    const phone = normalizePhone(contactPhone);
    const db = getDatabase();

    return (
      db
        .prepare(
          `SELECT * FROM chat_profiles
           WHERE owner_phone = ? AND chat_type = 'contact' AND contact_phone = ?
           ORDER BY assistant_pinned_on DESC, assistant_active DESC, updated_at DESC
           LIMIT 1`
        )
        .get(owner, phone) || null
    );
  }

  findLinkedContactProfile(ownerPhone, { contactPhone, contactName, chatId }) {
    const owner = normalizePhone(ownerPhone);
    const db = getDatabase();

    if (chatId) {
      const exact = db
        .prepare(
          `SELECT * FROM chat_profiles
           WHERE owner_phone = ? AND chat_type = 'contact' AND chat_id = ?
           ORDER BY updated_at DESC LIMIT 1`
        )
        .get(owner, chatId);
      if (exact) return exact;
    }

    const resolvedPhone =
      contactPhone && !isLikelyLidPhone(contactPhone)
        ? canonicalContactPhone(contactPhone) || normalizePhone(contactPhone)
        : null;

    if (resolvedPhone) {
      const byPhone = db
        .prepare(
          `SELECT * FROM chat_profiles
           WHERE owner_phone = ? AND chat_type = 'contact' AND contact_phone = ?
           ORDER BY assistant_pinned_on DESC, assistant_active DESC, updated_at DESC
           LIMIT 1`
        )
        .get(owner, resolvedPhone);
      if (byPhone) return byPhone;

      const tail = phoneTailDigits(resolvedPhone);
      if (tail.length >= 10) {
        const byTail = db
          .prepare(
            `SELECT * FROM chat_profiles
             WHERE owner_phone = ? AND chat_type = 'contact'
             AND (
               contact_phone LIKE '%' || ?
               OR chat_id LIKE '%' || ? || '@manual.import'
             )
             ORDER BY
               CASE WHEN chat_id LIKE '%@manual.import' THEN 0 ELSE 1 END,
               assistant_pinned_on DESC,
               assistant_active DESC,
               updated_at DESC
             LIMIT 1`
          )
          .get(owner, tail, tail);
        if (byTail) return byTail;
      }
    }

    if (chatId) {
      const userId = normalizePhone(chatId);
      if (userId && !isLikelyLidPhone(userId)) {
        const byChatUser = db
          .prepare(
            `SELECT * FROM chat_profiles
             WHERE owner_phone = ? AND chat_type = 'contact'
             AND (chat_id LIKE ? OR contact_phone = ?)
             ORDER BY assistant_pinned_on DESC, assistant_active DESC, updated_at DESC
             LIMIT 1`
          )
          .get(owner, `${userId}@%`, userId);
        if (byChatUser) return byChatUser;
      }
    }

    const nameTail = extractPhoneTailFromText(contactName);
    if (nameTail.length >= 10) {
      const byNameTail = db
        .prepare(
          `SELECT * FROM chat_profiles
           WHERE owner_phone = ? AND chat_type = 'contact'
           AND (
             contact_phone LIKE '%' || ?
             OR contact_name LIKE '%' || ?
             OR chat_id LIKE '%' || ? || '@manual.import'
           )
           ORDER BY
             CASE WHEN chat_id LIKE '%@manual.import' THEN 0 ELSE 1 END,
             assistant_pinned_on DESC,
             assistant_active DESC,
             updated_at DESC
           LIMIT 1`
        )
        .get(owner, nameTail, nameTail, nameTail);
      if (byNameTail) return byNameTail;
    }

    if (contactName) {
      return this.findByContactName(ownerPhone, contactName);
    }

    return null;
  }

  mergeProfiles(keepId, dropId) {
    if (!keepId || !dropId || keepId === dropId) {
      return this.findById(keepId || dropId);
    }

    const db = getDatabase();
    const keep = this.findById(keepId);
    const drop = this.findById(dropId);
    if (!keep || !drop) return keep || drop;

    db.prepare('UPDATE messages SET chat_profile_id = ? WHERE chat_profile_id = ?').run(keepId, dropId);
    db.prepare('UPDATE conversation_summaries SET chat_profile_id = ? WHERE chat_profile_id = ?').run(
      keepId,
      dropId
    );
    db.prepare('UPDATE action_items SET chat_profile_id = ? WHERE chat_profile_id = ?').run(keepId, dropId);
    db.prepare('UPDATE token_usage SET chat_profile_id = ? WHERE chat_profile_id = ?').run(keepId, dropId);

    const fields = [];
    const values = [];

    if (Number(drop.assistant_pinned_on) === 1 && Number(keep.assistant_pinned_on) !== 1) {
      fields.push('assistant_active = ?', 'assistant_pinned_on = ?', 'paused_until = ?');
      values.push(drop.assistant_active, drop.assistant_pinned_on, drop.paused_until);
    } else if (Number(drop.assistant_active) === 1 && Number(keep.assistant_active) !== 1 && !keep.paused_until) {
      fields.push('assistant_active = ?');
      values.push(drop.assistant_active);
    }

    if (!keep.contact_phone && drop.contact_phone) {
      fields.push('contact_phone = ?');
      values.push(canonicalContactPhone(drop.contact_phone) || drop.contact_phone);
    } else if (
      drop.contact_phone &&
      isLikelyLidPhone(keep.contact_phone) &&
      !isLikelyLidPhone(drop.contact_phone)
    ) {
      fields.push('contact_phone = ?');
      values.push(canonicalContactPhone(drop.contact_phone) || drop.contact_phone);
    }

    if (!keep.contact_name && drop.contact_name) {
      fields.push('contact_name = ?');
      values.push(drop.contact_name);
    }

    if (fields.length > 0) {
      fields.push("updated_at = datetime('now')");
      values.push(keepId);
      db.prepare(`UPDATE chat_profiles SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    }

    db.prepare('DELETE FROM chat_profiles WHERE id = ?').run(dropId);

    logger.info(`Merged chat profile ${dropId} into ${keepId}`);
    return this.findById(keepId);
  }

  getProfileIdsByPhoneTail(ownerPhone, contactPhone) {
    const owner = normalizePhone(ownerPhone);
    const tail = phoneTailDigits(canonicalContactPhone(contactPhone) || contactPhone);
    if (!owner || tail.length < 10) return [];

    const db = getDatabase();
    const profiles = db
      .prepare(
        `SELECT id, contact_phone FROM chat_profiles
         WHERE owner_phone = ? AND chat_type = 'contact'`
      )
      .all(owner);

    return profiles
      .filter((profile) => {
        const phone = profile.contact_phone;
        if (isLikelyLidPhone(phone)) return false;
        return phoneTailDigits(canonicalContactPhone(phone) || phone) === tail;
      })
      .map((profile) => profile.id);
  }

  contactNamesMatch(nameA, nameB) {
    const a = String(nameA || '').trim().toLowerCase();
    const b = String(nameB || '').trim().toLowerCase();
    if (!a || !b) return false;
    if (a === b) return true;
    return a.includes(b) || b.includes(a);
  }

  importPhoneTail(profile) {
    if (!profile) return '';
    return phoneTailDigits(
      canonicalContactPhone(profile.contact_phone) || normalizePhone(profile.chat_id)
    );
  }

  matchesImportedContact(whatsappProfile, importedProfile, realPhone = null) {
    if (!whatsappProfile || !importedProfile) return false;

    const impTail = this.importPhoneTail(importedProfile);
    if (impTail.length >= 10) {
      const resolvedPhone = this.effectiveContactPhone(whatsappProfile, realPhone);
      const wpTail = resolvedPhone ? phoneTailDigits(resolvedPhone) : this.profilePhoneTail(whatsappProfile);
      if (wpTail.length >= 10 && wpTail === impTail) return true;

      const wpUser = normalizePhone(whatsappProfile.chat_id);
      if (wpUser && !isLikelyLidPhone(wpUser) && phoneTailDigits(wpUser) === impTail) return true;
    }

    const wpName = whatsappProfile.contact_name;
    const impName = importedProfile.contact_name;
    return this.contactNamesMatch(wpName, impName);
  }

  getPinnedImportedProfiles(ownerPhone) {
    const owner = normalizePhone(ownerPhone);
    const db = getDatabase();
    return db
      .prepare(
        `SELECT * FROM chat_profiles
         WHERE owner_phone = ? AND chat_type = 'contact'
         AND chat_id LIKE '%@manual.import'
         AND assistant_pinned_on = 1 AND assistant_active = 1`
      )
      .all(owner);
  }

  getMatchingPinnedImport(profile, realPhone = null) {
    if (!profile) return null;
    const imports = this.getPinnedImportedProfiles(profile.owner_phone);
    return imports.find((imp) => this.matchesImportedContact(profile, imp, realPhone)) || null;
  }

  propagateImportedEnable(importedProfile) {
    if (!importedProfile || !String(importedProfile.chat_id || '').includes('@manual.import')) {
      return importedProfile;
    }

    const owner = normalizePhone(importedProfile.owner_phone);
    const db = getDatabase();
    const candidates = db
      .prepare(
        `SELECT * FROM chat_profiles
         WHERE owner_phone = ? AND chat_type = 'contact'
         AND chat_id NOT LIKE '%@manual.import'`
      )
      .all(owner);

    for (const candidate of candidates) {
      if (this.matchesImportedContact(candidate, importedProfile)) {
        const merged = this.mergeProfiles(candidate.id, importedProfile.id);
        logger.info(
          `Propagated imported AI enable: merged profile ${importedProfile.id} into WhatsApp profile ${candidate.id}`
        );
        return merged;
      }
    }

    return importedProfile;
  }

  async linkImportedContactProfile(profile, ownerPhone, { chat, client } = {}) {
    if (!profile || profile.chat_type !== 'contact' || String(profile.chat_id || '').includes('@manual.import')) {
      return profile;
    }
    if (this.isContactPinned(profile)) return profile;

    const realPhone = chat && client ? await this.resolveRealContactPhone(chat, client) : null;
    const pinnedImport = this.getMatchingPinnedImport(profile, realPhone);
    if (!pinnedImport) return profile;

    if (realPhone) {
      profile =
        this.updateProfile(profile.id, { contact_phone: canonicalContactPhone(realPhone) }) || profile;
    }

    const merged = this.mergeProfiles(profile.id, pinnedImport.id);
    logger.info(
      `Linked imported profile ${pinnedImport.id} into WhatsApp profile ${profile.id} for inbound message`
    );

    const chatId = chat?.id?._serialized;
    if (chatId && merged.chat_id !== chatId) {
      return this.updateChatId(merged.id, chatId, ownerPhone);
    }
    return merged;
  }

  async resolveRealContactPhone(chat, client = null) {
    const chatId = chat?.id?._serialized;
    if (!chatId) return null;

    if (chatId.endsWith('@lid') && client && typeof client.getContactLidAndPhone === 'function') {
      try {
        const mapped = await client.getContactLidAndPhone([chatId]);
        const pn = mapped?.[0]?.pn;
        if (pn) {
          const phone = normalizePhone(pn);
          if (phone && !isLikelyLidPhone(phone)) {
            logger.info(`Resolved LID ${chatId} to phone ${phone}`);
            return phone;
          }
        }
      } catch (error) {
        if (isRecoverableBrowserError(error)) throw error;
        const { isLidMappingError } = require('../utils/whatsappSend');
        if (isLidMappingError(error)) {
          logger.debug(`LID phone not available for ${chatId} (expected for some contacts)`);
        } else {
          logger.warn(`LID phone resolve failed for ${chatId}: ${error.message}`);
        }
      }
    }

    try {
      let contact = null;
      try {
        contact = await chat.getContact();
      } catch (error) {
        if (isRecoverableBrowserError(error)) throw error;
      }

      if (!contact && client) {
        try {
          contact = await client.getContactById(chatId);
        } catch (error) {
          if (isRecoverableBrowserError(error)) throw error;
        }
      }

      const phone = contact?.number || contact?.id?.user;
      const normalized = phone ? String(phone).replace(/\D/g, '') : null;
      return normalized && !isLikelyLidPhone(normalized) ? normalized : null;
    } catch (error) {
      if (isRecoverableBrowserError(error)) throw error;
      return null;
    }
  }

  async relinkProfileForMessage(chat, ownerPhone, profile, client = null) {
    if (!profile || profile.chat_type === 'self') return profile;

    const chatId = chat?.id?._serialized;
    if (!chatId) return profile;

    const realPhone = await this.resolveRealContactPhone(chat, client);
    const chatName = (chat?.name || '').trim();
    if (chatName && !profile.contact_name) {
      profile = this.updateProfile(profile.id, { contact_name: chatName }) || profile;
    }

    const linked = this.findLinkedContactProfile(ownerPhone, {
      contactPhone: realPhone || this.effectiveContactPhone(profile),
      contactName: profile.contact_name || chatName || null,
      chatId,
    });

    if (!linked) {
      if (realPhone && !isLikelyLidPhone(realPhone)) {
        return this.updateProfile(profile.id, {
          contact_phone: canonicalContactPhone(realPhone) || realPhone,
        }) || profile;
      }
      return profile;
    }

    if (linked.id === profile.id) {
      if (linked.chat_id !== chatId) {
        return this.updateChatId(linked.id, chatId, ownerPhone);
      }
      return linked;
    }

    const preferred = this.pickPreferredContactProfile(linked, profile);
    const drop = preferred.id === linked.id ? profile : linked;
    const merged = this.mergeProfiles(preferred.id, drop.id);
    return this.updateChatId(merged.id, chatId, ownerPhone);
  }

  updateChatId(profileId, chatId, ownerPhone = null) {
    if (!profileId || !chatId) return this.findById(profileId);

    const db = getDatabase();
    const profile = this.findById(profileId);
    const owner = ownerPhone ? normalizePhone(ownerPhone) : normalizePhone(profile?.owner_phone);

    const existing = owner
      ? this.findByChatIdForOwner(chatId, owner)
      : this.findByChatId(chatId);

    if (existing && existing.id !== profileId) {
      if (owner && normalizePhone(existing.owner_phone) !== owner) {
        logger.warn(
          `Chat id ${chatId} belongs to owner ${existing.owner_phone}, not ${owner}; skipping cross-owner merge`
        );
      } else {
        logger.warn(`Chat id ${chatId} already linked to profile ${existing.id}, merging ${profileId} into it`);
        return this.mergeProfiles(existing.id, profileId);
      }
    }

    db.prepare(
      `UPDATE chat_profiles SET chat_id = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(chatId, profileId);

    return this.findById(profileId);
  }

  syncAssistantStateForContact(profile) {
    if (!profile || profile.chat_type !== 'contact') return profile;

    const db = getDatabase();
    const owner = normalizePhone(profile.owner_phone);
    const phone = profile.contact_phone ? canonicalContactPhone(profile.contact_phone) : null;
    const tail = phone ? phoneTailDigits(phone) : '';

    if (tail.length >= 10) {
      const ids = this.getProfileIdsByPhoneTail(owner, phone);
      const stmt = db.prepare(
        `UPDATE chat_profiles
         SET assistant_active = ?, assistant_pinned_on = ?, paused_until = ?, updated_at = datetime('now')
         WHERE id = ?`
      );
      for (const id of ids) {
        stmt.run(profile.assistant_active, profile.assistant_pinned_on, profile.paused_until, id);
      }
    } else if (!phone) {
      return profile;
    } else {
      db.prepare(
        `UPDATE chat_profiles
         SET assistant_active = ?, assistant_pinned_on = ?, paused_until = ?, updated_at = datetime('now')
         WHERE owner_phone = ? AND chat_type = 'contact' AND contact_phone = ?`
      ).run(
        profile.assistant_active,
        profile.assistant_pinned_on,
        profile.paused_until,
        owner,
        phone
      );
    }

    if (String(profile.chat_id || '').includes('@manual.import') && profile.contact_name) {
      const name = profile.contact_name.trim();
      db.prepare(
        `UPDATE chat_profiles
         SET assistant_active = ?, assistant_pinned_on = ?, paused_until = ?, updated_at = datetime('now')
         WHERE owner_phone = ? AND chat_type = 'contact'
         AND (
           LOWER(contact_name) = LOWER(?)
           OR LOWER(contact_name) LIKE '%' || LOWER(?) || '%'
           OR LOWER(?) LIKE '%' || LOWER(contact_name) || '%'
         )`
      ).run(
        profile.assistant_active,
        profile.assistant_pinned_on,
        profile.paused_until,
        owner,
        name,
        name,
        name
      );
    }

    return this.findById(profile.id);
  }

  isContactPinned(profile) {
    return Number(profile?.assistant_pinned_on) === 1 && Number(profile?.assistant_active) === 1;
  }

  isContactPhonePinned(ownerPhone, contactPhone) {
    if (!contactPhone) return false;

    const owner = normalizePhone(ownerPhone);
    const tail = phoneTailDigits(canonicalContactPhone(contactPhone) || contactPhone);
    if (tail.length < 10) return false;

    const db = getDatabase();
    const profiles = db
      .prepare(
        `SELECT contact_phone, assistant_pinned_on, assistant_active FROM chat_profiles
         WHERE owner_phone = ? AND chat_type = 'contact'`
      )
      .all(owner);

    return profiles.some(
      (profile) =>
        phoneTailDigits(canonicalContactPhone(profile.contact_phone) || profile.contact_phone) === tail &&
        Number(profile.assistant_pinned_on) === 1 &&
        Number(profile.assistant_active) === 1
    );
  }

  isChatUserPinned(ownerPhone, chatId) {
    if (!chatId) return false;

    const owner = normalizePhone(ownerPhone);
    const userId = normalizePhone(chatId);
    if (!userId) return false;

    const db = getDatabase();
    const row = db
      .prepare(
        `SELECT COUNT(*) as count FROM chat_profiles
         WHERE owner_phone = ? AND chat_type = 'contact'
         AND (chat_id = ? OR chat_id LIKE ? OR contact_phone = ?)
         AND assistant_pinned_on = 1 AND assistant_active = 1`
      )
      .get(owner, chatId, `${userId}@%`, userId);

    return Number(row?.count) > 0;
  }

  syncAssistantStateForChatUser(profile) {
    if (!profile || profile.chat_type !== 'contact') return profile;

    const owner = normalizePhone(profile.owner_phone);
    const userId = normalizePhone(profile.chat_id);
    if (!owner || !userId) return this.syncAssistantStateForContact(profile);

    const db = getDatabase();
    db.prepare(
      `UPDATE chat_profiles
       SET assistant_active = ?, assistant_pinned_on = ?, paused_until = ?, updated_at = datetime('now')
       WHERE owner_phone = ? AND chat_type = 'contact'
       AND (chat_id = ? OR chat_id LIKE ? OR contact_phone = ?)`
    ).run(
      profile.assistant_active,
      profile.assistant_pinned_on,
      profile.paused_until,
      owner,
      profile.chat_id,
      `${userId}@%`,
      userId
    );

    return this.findById(profile.id);
  }

  enableAllContactAssistants(ownerPhone) {
    const db = getDatabase();
    const owner = normalizePhone(ownerPhone);

    db.prepare(
      `UPDATE chat_profiles
       SET assistant_active = 1, paused_until = NULL, updated_at = datetime('now')
       WHERE owner_phone = ? AND chat_type = 'contact'`
    ).run(owner);

    logger.info(`Enabled all contact assistants for owner ${owner}`);
  }

  findById(id) {
    const db = getDatabase();
    return db.prepare('SELECT * FROM chat_profiles WHERE id = ?').get(id) || null;
  }

  getOrCreate({ chatId, ownerPhone, contactName = null, contactPhone = null, chatType = 'contact' }) {
    const db = getDatabase();
    const owner = normalizePhone(ownerPhone);
    let profile = this.findByChatIdForOwner(chatId, owner);

    if (!profile) {
      const foreign = this.findByChatId(chatId);
      if (foreign && normalizePhone(foreign.owner_phone) !== owner) {
        profile = this.findLinkedContactProfile(owner, { contactPhone, contactName, chatId });
      }
    }

    if (profile) {
      const updates = [];
      const values = [];

      if (
        contactName &&
        contactName !== profile.contact_name &&
        shouldPreferContactName(profile.contact_name, contactName, profile.contact_phone)
      ) {
        updates.push('contact_name = ?');
        values.push(contactName);
      }

      if (contactPhone && contactPhone !== profile.contact_phone) {
        updates.push('contact_phone = ?');
        values.push(contactPhone);
      }

      if (updates.length > 0) {
        updates.push("updated_at = datetime('now')");
        values.push(profile.id);
        db.prepare(`UPDATE chat_profiles SET ${updates.join(', ')} WHERE id = ?`).run(...values);
        profile = this.findById(profile.id);
      }

      return profile;
    }

    const storedName =
      contactName && !isPhoneLikeString(contactName)
        ? contactName
        : contactPhone
          ? null
          : contactName;

    const result = db
      .prepare(
        `INSERT INTO chat_profiles (chat_id, owner_phone, contact_name, contact_phone, chat_type)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(chatId, owner, storedName, contactPhone ? canonicalContactPhone(contactPhone) || contactPhone : null, chatType);

    profile = this.findById(result.lastInsertRowid);
    logger.info(`Created chat profile for ${chatId} (${chatType})`);
    return profile;
  }

  inferSelfChatForSync(chat, ownerPhone) {
    const chatId = serializeWhatsAppChatId(chat);
    const existing = this.findByChatIdForOwner(chatId, ownerPhone);
    if (existing?.chat_type === 'self') return true;

    const name = (chat.name || '').toLowerCase();
    if (
      name.includes('message yourself') ||
      name === 'you' ||
      (name.includes('(you)') && !chat.isGroup)
    ) {
      return true;
    }

    const owner = normalizePhone(ownerPhone);
    const phoneFromChat = normalizePhone(chatId.split('@')[0]);
    if (phoneFromChat && owner && phoneFromChat === owner) return true;

    return false;
  }

  lookupIndexedContactName(nameIndex, chatId, contactPhone) {
    if (!nameIndex?.size) return null;

    const candidates = [];
    if (chatId) candidates.push(chatId);
    if (contactPhone) {
      const digits = normalizePhoneDigits(contactPhone);
      const canonical = canonicalContactPhone(contactPhone);
      candidates.push(contactPhone, digits, canonical, normalizePhone(contactPhone));
      if (digits && digits.length >= 10) {
        candidates.push(digits.slice(-10));
        candidates.push(`${digits}@c.us`);
        if (canonical) candidates.push(`${canonical}@c.us`);
      }
    }

    for (const key of candidates) {
      if (!key) continue;
      const value = nameIndex.get(key);
      if (value && !isPhoneLikeString(value)) return value;
    }
    return null;
  }

  async resolveContactFromChat(chat, isSelfChat = false, client = null, nameIndex = null, options = {}) {
    const { skipPuppeteer = false, phoneByChatId = null } = options;
    const chatId = serializeWhatsAppChatId(chat);
    let contactPhone =
      phoneByChatId?.get(chatId) ||
      chat?.contactPhone ||
      chat?.number ||
      null;
    let contact = null;

    if (!contactPhone && chat?.id?.user && !String(chatId).endsWith('@lid')) {
      contactPhone = chat.id.user;
    }

    const chatTitle = chat?.formattedTitle || chat?.name || chat?.pushname || null;
    let indexedName = this.lookupIndexedContactName(nameIndex, chatId, contactPhone);

    if (!isSelfChat && !skipPuppeteer) {
      const chatDisplayName = pickContactDisplayName([chatTitle], contactPhone);
      const hasCachedName = Boolean(
        (indexedName && !isPhoneLikeString(indexedName)) ||
        (chatDisplayName && !isPhoneLikeString(chatDisplayName))
      );

      if (!hasCachedName) {
        try {
          if (typeof chat.getContact === 'function') {
            contact = await chat.getContact();
          }
        } catch (error) {
          if (isRecoverableBrowserError(error)) throw error;
          logger.warn(`Could not resolve contact for ${chatId}: ${error.message}`);
        }

        if (!contact && client && chatId) {
          try {
            contact = await client.getContactById(chatId);
          } catch (error) {
            if (isRecoverableBrowserError(error)) throw error;
            logger.warn(`getContactById failed for ${chatId}: ${error.message}`);
          }
        }
      }
    }

    if (!contactPhone && chatId.includes('@') && !chatId.endsWith('@lid')) {
      contactPhone = chatId.split('@')[0];
    }

    contactPhone = contactPhone ? String(contactPhone).replace(/\D/g, '') : null;
    if (contactPhone && isLikelyLidPhone(contactPhone)) {
      contactPhone = null;
    }

    if (!contactPhone && !isSelfChat) {
      const fromChatName = extractPhoneTailFromText(chatTitle);
      if (fromChatName.length >= 10) {
        contactPhone = canonicalContactPhone(fromChatName) || fromChatName;
      }
    }

    if (contact?.number) {
      contactPhone = String(contact.number).replace(/\D/g, '') || contactPhone;
    } else if (contact?.id?.user && !contact?.number) {
      const userDigits = String(contact.id.user).replace(/\D/g, '');
      if (userDigits.length <= 13 && !isLikelyLidPhone(userDigits)) {
        contactPhone = userDigits || contactPhone;
      }
    }

    if (contactPhone && isLikelyLidPhone(contactPhone)) {
      contactPhone = null;
    }

    if (!indexedName) {
      indexedName = this.lookupIndexedContactName(nameIndex, chatId, contactPhone);
    }

    const contactName = isSelfChat
      ? 'You (Self Chat)'
      : pickContactDisplayName(
          [
            contact?.name,
            indexedName,
            contact?.pushname,
            contact?.shortName,
            contact?.verifiedName,
            chatTitle,
            chat?.name,
          ],
          contactPhone
        );

    return {
      contactName: contactName === 'Unknown' ? null : contactName,
      contactPhone: contactPhone ? canonicalContactPhone(contactPhone) || contactPhone : null,
    };
  }

  _indexContactNameKeys(map, displayName, phone, chatId) {
    if (!displayName || isPhoneLikeString(displayName)) return;

    const keys = new Set();
    if (chatId) keys.add(chatId);
    if (phone) {
      const digits = normalizePhoneDigits(phone);
      const canonical = canonicalContactPhone(phone);
      keys.add(String(phone));
      keys.add(digits);
      keys.add(normalizePhone(phone));
      if (canonical) keys.add(canonical);
      if (digits && digits.length >= 10) {
        keys.add(digits.slice(-10));
        keys.add(`${digits}@c.us`);
        if (canonical) keys.add(`${canonical}@c.us`);
      }
    }

    for (const key of keys) {
      if (key) map.set(key, displayName);
    }
  }

  buildContactNameIndex(contacts = []) {
    const map = new Map();

    for (const contact of contacts) {
      if (contact.isGroup) continue;

      const phone = normalizePhoneDigits(contact.number || contact.phone || contact.id?.user);
      const safePhone = phone && !isLikelyLidPhone(phone) ? phone : null;
      const chatId = contact.id?._serialized || contact.chatId || null;
      const displayName = pickContactDisplayName(
        [contact.name, contact.pushname, contact.shortName, contact.verifiedName, contact.formattedName],
        safePhone
      );

      this._indexContactNameKeys(map, displayName, safePhone, chatId);
    }

    return map;
  }

  buildContactPhoneByChatId(contacts = []) {
    const map = new Map();

    for (const contact of contacts) {
      if (contact.isGroup) continue;
      const chatId = contact.id?._serialized || contact.chatId;
      const phone = normalizePhoneDigits(contact.number || contact.phone || '');
      if (chatId && phone && !isLikelyLidPhone(phone)) {
        map.set(chatId, phone);
        const canonical = canonicalContactPhone(phone);
        if (canonical) map.set(`${canonical}@c.us`, phone);
        map.set(`${phone}@c.us`, phone);
      }
    }

    return map;
  }

  backfillProfileNames(ownerPhone, nameIndex) {
    if (!nameIndex?.size) return 0;

    const owner = normalizePhone(ownerPhone);
    const profiles = this.getByOwner(owner);
    let updated = 0;

    for (const profile of profiles) {
      if (profile.chat_type === 'self') continue;

      const phone = normalizePhoneDigits(profile.contact_phone || '');
      const better = this.lookupIndexedContactName(nameIndex, profile.chat_id, phone);

      if (shouldPreferContactName(profile.contact_name, better, phone)) {
        this.updateProfile(profile.id, { contact_name: better });
        updated += 1;
      }
    }

    updated += this.backfillNamesFromSiblingProfiles(ownerPhone);

    if (updated > 0) {
      logger.info(`Backfilled contact names for ${updated} chat profile(s)`);
    }

    return updated;
  }

  backfillNamesFromSiblingProfiles(ownerPhone) {
    const owner = normalizePhone(ownerPhone);
    const db = getDatabase();
    const missing = db
      .prepare(
        `SELECT id, contact_phone
         FROM chat_profiles
         WHERE owner_phone = ?
           AND chat_type = 'contact'
           AND contact_phone IS NOT NULL
           AND contact_phone != ''
           AND (contact_name IS NULL OR contact_name = '')`
      )
      .all(owner);

    let updated = 0;
    const findName = db.prepare(
      `SELECT contact_name
       FROM chat_profiles
       WHERE contact_phone = ?
         AND contact_name IS NOT NULL
         AND contact_name != ''
         AND id != ?
       ORDER BY CASE WHEN owner_phone = ? THEN 0 ELSE 1 END, updated_at DESC
       LIMIT 1`
    );

    for (const row of missing) {
      const match = findName.get(row.contact_phone, row.id, owner);
      if (!match?.contact_name || isPhoneLikeString(match.contact_name)) continue;
      this.updateProfile(row.id, { contact_name: match.contact_name });
      updated += 1;
    }

    return updated;
  }

  async enrichFromWhatsAppChat(
    chat,
    ownerPhone,
    isSelfChat = false,
    client = null,
    nameIndex = null,
    options = {}
  ) {
    const { skipPuppeteer = false, fastPath = false, phoneByChatId = null } = options;
    const chatId = serializeWhatsAppChatId(chat);
    if (!chatId) return null;

    const existing = this.findByChatIdForOwner(chatId, ownerPhone);
    // Lightweight sync used to skip existing rows entirely — that froze null names forever.
    // Only take the fast exit when we already have a usable display name (or self chat).
    if (existing && (fastPath || skipPuppeteer)) {
      if (isSelfChat && existing.chat_type !== 'self') {
        return this.updateProfile(existing.id, { chat_type: 'self', contact_name: 'You (Self Chat)' });
      }

      const hasName = Boolean(existing.contact_name && !isPhoneLikeString(existing.contact_name));
      if (hasName && !isSelfChat) {
        // Still allow phone fill if missing and we can derive it cheaply.
        const cheapPhone =
          phoneByChatId?.get(chatId) ||
          chat?.contactPhone ||
          (!String(chatId).endsWith('@lid') ? chat?.id?.user : null);
        const digits = cheapPhone ? normalizePhoneDigits(cheapPhone) : '';
        if (
          (!existing.contact_phone || isLikelyLidPhone(existing.contact_phone)) &&
          digits &&
          !isLikelyLidPhone(digits)
        ) {
          return this.updateProfile(existing.id, {
            contact_phone: canonicalContactPhone(digits) || digits,
          });
        }
        return existing;
      }
    }

    const { contactName, contactPhone } = await this.resolveContactFromChat(
      chat,
      isSelfChat,
      client,
      nameIndex,
      { skipPuppeteer, phoneByChatId }
    );

    if (isSelfChat) {
      return this.getOrCreate({
        chatId,
        ownerPhone,
        contactName,
        contactPhone,
        chatType: 'self',
      });
    }

    let profile = this.findByChatIdForOwner(chatId, ownerPhone);
    if (!profile) {
      profile = this.findLinkedContactProfile(ownerPhone, { contactPhone, contactName, chatId });
      if (profile) {
        profile = this.updateChatId(profile.id, chatId, ownerPhone);
      }
    }

    if (profile) {
      const updates = [];
      const values = [];

      if (
        contactName &&
        contactName !== profile.contact_name &&
        shouldPreferContactName(profile.contact_name, contactName, contactPhone)
      ) {
        updates.push('contact_name = ?');
        values.push(contactName);
      }

      if (contactPhone && contactPhone !== profile.contact_phone) {
        updates.push('contact_phone = ?');
        values.push(contactPhone);
      }

      if (updates.length > 0) {
        updates.push("updated_at = datetime('now')");
        values.push(profile.id);
        const db = getDatabase();
        db.prepare(`UPDATE chat_profiles SET ${updates.join(', ')} WHERE id = ?`).run(...values);
        profile = this.findById(profile.id);
      }

      return profile;
    }

    return this.getOrCreate({
      chatId,
      ownerPhone,
      contactName,
      contactPhone,
      chatType: 'contact',
    });
  }

  async fetchWhatsAppContacts(client) {
    if (!client) return [];

    try {
      const contacts = await client.getContacts();
      const seen = new Map();

      for (const contact of contacts) {
        if (contact.isGroup) continue;

        const phone = normalizePhone(contact.number || contact.id?.user);
        if (!phone) continue;

        const name = contact.pushname || contact.name || contact.shortName || null;
        const existing = seen.get(phone);

        if (!existing || (name && existing.contactName === existing.contactPhone)) {
          seen.set(phone, {
            contactPhone: phone,
            contactName: name || phone,
            isMyContact: Boolean(contact.isMyContact),
          });
        }
      }

      return [...seen.values()];
    } catch (error) {
      logger.error(`Contact fetch failed: ${error.message}`);
      return [];
    }
  }

  async fetchContactsFromStoreFallback(client) {
    const page = client?.pupPage;
    if (!page) return [];

    const rows = await page.evaluate(() => {
      try {
        const Contact = window.require('WAWebCollections').Contact;
        const models = Contact.getModelsArray() || [];
        let toPn = null;
        try {
          toPn = window.require('WAWebLidMigrationUtils').toPn;
        } catch (_) {
          toPn = null;
        }

        return models
          .map((contact) => {
            const chatId = contact?.id?._serialized || '';
            if (!chatId || chatId.endsWith('@g.us')) return null;

            let phone = '';
            try {
              if (typeof toPn === 'function') {
                const pn = toPn(contact.id);
                phone = pn?.user || pn?._serialized?.split('@')[0] || '';
              }
            } catch (_) {
              phone = '';
            }
            if (!phone) {
              phone = contact.userid || contact.number || contact.phoneNumber || '';
              if (!phone && chatId.endsWith('@c.us')) {
                phone = contact?.id?.user || '';
              }
            }

            const name =
              contact.name ||
              contact.pushname ||
              contact.shortName ||
              contact.verifiedName ||
              contact.formattedTitle ||
              '';

            return {
              id: { _serialized: chatId, user: contact?.id?.user, server: contact?.id?.server },
              chatId,
              number: phone,
              phone,
              name,
              pushname: contact.pushname || '',
              shortName: contact.shortName || '',
              verifiedName: contact.verifiedName || '',
              isGroup: false,
            };
          })
          .filter(Boolean);
      } catch (error) {
        return { __error: String(error?.message || error) };
      }
    });

    if (rows && rows.__error) {
      throw new Error(rows.__error);
    }

    logger.info(`Loaded ${(rows || []).length} WhatsApp contacts via Store fallback`);
    return rows || [];
  }

  async fetchChatsFromStoreFallback(client) {
    const page = client?.pupPage;
    if (!page) {
      throw new Error('No browser page for Store chat sync fallback');
    }

    const rows = await page.evaluate(() => {
      try {
        const Chat = window.require('WAWebCollections').Chat;
        const models = Chat.getModelsArray() || [];
        return models
          .map((chat) => {
            const id = chat?.id?._serialized || '';
            if (!id) return null;
            const isGroup =
              Boolean(chat?.groupMetadata) || String(id).endsWith('@g.us');
            const isChannel =
              Boolean(chat?.newsletterMetadata) ||
              String(id).includes('@newsletter');

            let contact = null;
            let toPn = null;
            try {
              contact = chat.contact || window.require('WAWebCollections').Contact.get(chat.id);
            } catch (_) {
              contact = null;
            }
            try {
              toPn = window.require('WAWebLidMigrationUtils').toPn;
            } catch (_) {
              toPn = null;
            }

            const name =
              chat.formattedTitle ||
              chat.name ||
              contact?.name ||
              contact?.pushname ||
              contact?.verifiedName ||
              '';

            let phone = '';
            try {
              if (typeof toPn === 'function') {
                const pn = toPn(chat.id);
                phone = pn?.user || String(pn?._serialized || '').split('@')[0] || '';
              }
            } catch (_) {
              phone = '';
            }
            if (!phone && id.endsWith('@c.us')) phone = chat?.id?.user || '';
            if (!phone) phone = contact?.userid || contact?.number || contact?.phoneNumber || '';

            return {
              id: {
                _serialized: id,
                user: chat?.id?.user,
                server: chat?.id?.server,
              },
              name,
              formattedTitle: name,
              contactPhone: String(phone || '').replace(/\D/g, ''),
              number: String(phone || '').replace(/\D/g, ''),
              isGroup,
              isChannel,
              timestamp: chat.t || chat.timestamp || 0,
            };
          })
          .filter(Boolean);
      } catch (error) {
        return { __error: String(error?.message || error) };
      }
    });

    if (rows && rows.__error) {
      throw new Error(`Store chat fallback failed: ${rows.__error}`);
    }

    logger.info(`Loaded ${(rows || []).length} WhatsApp chats via Store fallback`);
    return rows || [];
  }

  async fetchChatsForSync(client, options = {}) {
    const opts = typeof options === 'number' ? { timeoutMs: options } : options;
    const {
      timeoutMs = 120000,
      shouldAbort = null,
      allowRetry = true,
    } = opts;

    if (shouldAbort?.()) {
      throw new Error('Operation aborted for priority work');
    }

    try {
      const chats = await awaitWithAbort(
        withTimeout(client.getChats(), timeoutMs, 'getChats'),
        shouldAbort
      );
      logger.info(`Loaded ${chats.length} WhatsApp chats for sync`);
      return chats;
    } catch (error) {
      if (String(error.message).includes('aborted for priority')) {
        throw error;
      }

      const msg = String(error.message || error || '');
      const timedOut = msg.includes('timed out');
      if (allowRetry && timedOut) {
        if (shouldAbort?.()) {
          throw new Error('Operation aborted for priority work');
        }
        const retryMs = Math.max(timeoutMs, 60000);
        logger.warn(`getChats timed out (${timeoutMs}ms), retrying with ${retryMs}ms…`);
        try {
          const chats = await awaitWithAbort(
            withTimeout(client.getChats(), retryMs, 'getChats-retry'),
            shouldAbort
          );
          logger.info(`Loaded ${chats.length} WhatsApp chats for sync (retry)`);
          return chats;
        } catch (retryError) {
          logger.warn(
            `getChats retry failed (${retryError.message}), using Store fallback`
          );
          return this.fetchChatsFromStoreFallback(client);
        }
      }

      logger.warn(`getChats failed (${msg}), using Store fallback`);
      return this.fetchChatsFromStoreFallback(client);
    }
  }

  async ensureSelfChatProfile(client, ownerPhone) {
    if (!client || !ownerPhone) return null;

    const owner = normalizePhone(ownerPhone);
    const existing = this.getByOwner(owner).find((profile) => profile.chat_type === 'self');
    if (existing) return existing;

    try {
      const chats = await this.fetchChatsForSync(client, {
        timeoutMs: 60000,
        allowRetry: false,
      });
      for (const chat of chats) {
        if (chat.isGroup || chat.isChannel) continue;
        if (!this.inferSelfChatForSync(chat, ownerPhone)) continue;

        const profile = await this.enrichFromWhatsAppChat(chat, ownerPhone, true, client, null, {
          skipPuppeteer: true,
        });
        if (profile) {
          logger.info(`Ensured self-chat profile ${profile.id} (${profile.chat_id})`);
          return profile;
        }
      }

      const selfChatId = `${owner}@c.us`;
      try {
        const chat = await client.getChatById(selfChatId);
        if (chat) {
          const profile = await this.enrichFromWhatsAppChat(chat, ownerPhone, true, client, null, {
            skipPuppeteer: true,
          });
          if (profile) {
            logger.info(`Ensured self-chat profile ${profile.id} via ${selfChatId}`);
            return profile;
          }
        }
      } catch (_) {
        // fall through
      }
    } catch (error) {
      logger.warn(`ensureSelfChatProfile failed: ${error.message}`);
    }

    return null;
  }

  promoteToSelfChat(profileId) {
    const db = getDatabase();
    db.prepare(
      `UPDATE chat_profiles
       SET chat_type = 'self', contact_name = 'You (Self Chat)', updated_at = datetime('now')
       WHERE id = ?`
    ).run(profileId);
    return this.findById(profileId);
  }

  async syncPersonalChats(client, ownerPhone, options = {}) {
    if (!client) return 0;

    const lock = this._beginSync(ownerPhone);
    if (lock.wait) {
      return lock.promise;
    }

    const {
      lightweight = false,
      timeoutMs = lightweight ? 120000 : 300000,
    } = options;

    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`Chat sync timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    let result = 0;
    try {
      result = await Promise.race([
        this._runPersonalChatSync(client, ownerPhone, options),
        timeoutPromise,
      ]);
      return result;
    } catch (error) {
      if (isRecoverableBrowserError(error)) {
        throw error;
      }
      if (String(error.message).includes('aborted for priority')) {
        logger.info(`Chat sync aborted: ${error.message}`);
        return 0;
      }
      logger.error(
        `Chat sync failed: ${error.message || error}${error.stack ? ` | ${error.stack.split('\n')[1] || ''}` : ''}`
      );
      return 0;
    } finally {
      clearTimeout(timeoutId);
      this._finishSync(ownerPhone, result);
    }
  }

  async _runPersonalChatSync(client, ownerPhone, options = {}) {
    const {
      lightweight = false,
      batchSize = lightweight ? 50 : 25,
      batchDelayMs = lightweight ? 75 : 200,
      maxChats = parseInt(process.env.MAX_SYNC_CHATS, 10) || 200,
      getChatsTimeoutMs = lightweight ? 90000 : 120000,
      shouldAbort = null,
    } = options;

    if (shouldAbort?.()) {
      logger.info('Chat sync skipped — priority work pending');
      return 0;
    }

    const chats = await this.fetchChatsForSync(client, {
      timeoutMs: getChatsTimeoutMs,
      shouldAbort,
      allowRetry: !lightweight,
    });
    let nameIndex = new Map();
    let phoneByChatId = new Map();

    if (shouldAbort?.()) {
      logger.info('Chat sync aborted after loading chats — priority work pending');
      return 0;
    }

    // Prefer Store Contact models (fast). client.getContacts() often hangs / fails
    // with cryptic WA errors and blocks the whole sync timeout.
    try {
      const storeContacts = await withTimeout(
        this.fetchContactsFromStoreFallback(client),
        lightweight ? 12000 : 20000,
        'storeContacts'
      );
      nameIndex = this.buildContactNameIndex(storeContacts);
      phoneByChatId = this.buildContactPhoneByChatId(storeContacts);
    } catch (error) {
      logger.warn(`Store contact index failed: ${error.message}`);
    }

    if (!nameIndex.size) {
      try {
        const allContacts = await awaitWithAbort(
          withTimeout(client.getContacts(), lightweight ? 12000 : 30000, 'getContacts'),
          shouldAbort
        );
        nameIndex = this.buildContactNameIndex(allContacts);
        phoneByChatId = this.buildContactPhoneByChatId(allContacts);
      } catch (error) {
        if (isRecoverableBrowserError(error)) {
          logger.warn(`Aborted chat sync — browser unavailable: ${error.message}`);
          throw error;
        }
        logger.warn(`Could not load WhatsApp contacts for names: ${error.message}`);
      }
    } else {
      logger.info(`Contact name index ready: ${nameIndex.size} key(s)`);
    }

    const privateChats = chats
      .filter((chat) => {
        if (chat.isGroup || chat.isChannel) return false;
        const chatId = serializeWhatsAppChatId(chat);
        return !isSkippableWhatsAppChatId(chatId);
      })
      .slice(0, maxChats);

    if (privateChats.length === 0 && chats.length > 0) {
      const sample = chats.slice(0, 5).map((chat) => ({
        id: serializeWhatsAppChatId(chat),
        isGroup: Boolean(chat.isGroup),
        isChannel: Boolean(chat.isChannel),
      }));
      logger.warn(
        `No private chats from ${chats.length} WhatsApp chats (sample: ${JSON.stringify(sample)})`
      );
    }

    let synced = 0;

    for (let i = 0; i < privateChats.length; i += 1) {
      if (options.shouldAbort?.()) {
        logger.info(
          `Chat sync yielding at ${i}/${privateChats.length} — high-priority browser work pending`
        );
        break;
      }

      const chat = privateChats[i];
      let isSelfChat = this.inferSelfChatForSync(chat, ownerPhone);

      if (!lightweight && !isSelfChat) {
        try {
          const contact = await chat.getContact();
          isSelfChat = contact?.isMe === true;
        } catch (error) {
          if (isRecoverableBrowserError(error)) {
            logger.warn(`Stopped chat sync at ${i}/${privateChats.length}: ${error.message}`);
            throw error;
          }
        }
      }

      await this.enrichFromWhatsAppChat(chat, ownerPhone, isSelfChat, client, nameIndex, {
        skipPuppeteer: lightweight,
        phoneByChatId,
      });
      synced += 1;

      if ((i + 1) % batchSize === 0) {
        await sleep(batchDelayMs);
      }
    }

    if (nameIndex.size) {
      this.backfillProfileNames(ownerPhone, nameIndex);
    } else {
      const siblingFilled = this.backfillNamesFromSiblingProfiles(ownerPhone);
      if (siblingFilled > 0) {
        logger.info(`Backfilled ${siblingFilled} contact name(s) from sibling profiles`);
      }
    }

    logger.info(
      `Synced ${synced} personal chats from WhatsApp${lightweight ? ' (lightweight)' : ''}`
    );
    return synced;
  }

  updateProfile(id, fields) {
    const db = getDatabase();
    const allowed = [
      'contact_name',
      'contact_phone',
      'contact_role',
      'contact_responsibilities',
      'contact_relations',
    ];
    const updates = [];
    const values = [];

    for (const key of allowed) {
      if (fields[key] !== undefined && fields[key] !== null) {
        updates.push(`${key} = ?`);
        values.push(fields[key]);
      }
    }

    if (updates.length === 0) return this.findById(id);

    updates.push("updated_at = datetime('now')");
    values.push(id);

    db.prepare(`UPDATE chat_profiles SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    logger.info(`Updated chat profile ${id}`);
    return this.findById(id);
  }

  scoreContactMatch(contactName, query) {
    if (!contactName || !query) return 0;

    const name = contactName.toLowerCase().trim();
    const q = query.toLowerCase().trim();

    if (name === q) return 100;
    if (name.startsWith(q)) return 85;
    if (name.includes(q)) return 70;

    const nameParts = name.split(/\s+/);
    const queryParts = q.split(/\s+/);

    let partScore = 0;
    for (const qp of queryParts) {
      if (nameParts.some((np) => np.startsWith(qp) || np.includes(qp))) {
        partScore += 30;
      }
    }
    if (partScore > 0) return partScore;

    let overlap = 0;
    for (const ch of q) {
      if (name.includes(ch)) overlap += 1;
    }
    return Math.min(40, overlap * 5);
  }

  findContactSuggestions(ownerPhone, contactName, limit = 5) {
    const owner = normalizePhone(ownerPhone);
    const profiles = this.getByOwner(owner).filter((p) => p.chat_type === 'contact');

    return profiles
      .map((profile) => ({
        profile,
        score: this.scoreContactMatch(profile.contact_name, contactName),
      }))
      .filter((item) => item.score >= 20)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  findByContactName(ownerPhone, contactName) {
    const suggestions = this.findContactSuggestions(ownerPhone, contactName, 1);
    if (suggestions.length === 1 && suggestions[0].score >= 85) {
      return suggestions[0].profile;
    }

    const owner = normalizePhone(ownerPhone);
    const search = contactName.trim().toLowerCase();
    const profiles = this.getByOwner(owner).filter((p) => p.chat_type === 'contact');

    return (
      profiles.find((p) => p.contact_name?.toLowerCase() === search) ||
      profiles.find((p) => p.contact_name?.toLowerCase().includes(search)) ||
      null
    );
  }

  formatContactSuggestions(suggestions, actionLabel = 'Select contact') {
    if (!suggestions.length) {
      return 'No matching contacts found. Use /contacts to list chats.';
    }

    const lines = suggestions.map((item, index) => {
      const phone = item.profile.contact_phone || 'no number';
      return `${index + 1}. ${item.profile.contact_name || 'Unknown'} (${phone})`;
    });

    return `*${actionLabel}*\n\n${lines.join('\n')}\n\nReply with number only. Example: 1`;
  }

  resolveContactQuery(ownerPhone, contactName, ownerUserId, pendingAction) {
    const exact = this.findByContactName(ownerPhone, contactName);
    if (exact) {
      return { profile: exact, suggestions: null };
    }

    const suggestions = this.findContactSuggestions(ownerPhone, contactName);
    if (suggestions.length === 0) {
      return { profile: null, suggestions: null, message: `No contact found for "${contactName}".` };
    }

    if (suggestions.length === 1 && suggestions[0].score >= 70) {
      return { profile: suggestions[0].profile, suggestions: null };
    }

    const contactSelectionService = require('./contactSelectionService');
    contactSelectionService.setPending(ownerUserId, {
      action: pendingAction.action,
      mode: pendingAction.mode || null,
      fields: pendingAction.fields || null,
      profiles: suggestions.map((s) => s.profile),
    });

    return {
      profile: null,
      suggestions,
      message: this.formatContactSuggestions(suggestions, pendingAction.label),
    };
  }

  pauseAssistant(chatProfileId, durationMs) {
    const db = getDatabase();
    const pausedUntil = new Date(Date.now() + durationMs).toISOString();

    db.prepare(
      `UPDATE chat_profiles
       SET assistant_active = 0, paused_until = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).run(pausedUntil, chatProfileId);

    logger.info(`Assistant paused for chat profile ${chatProfileId} until ${pausedUntil}`);
    return this.findById(chatProfileId);
  }

  resumeAssistant(chatProfileId, pin = false) {
    const db = getDatabase();

    if (pin) {
      db.prepare(
        `UPDATE chat_profiles
         SET assistant_active = 1, assistant_pinned_on = 1, paused_until = NULL, updated_at = datetime('now')
         WHERE id = ?`
      ).run(chatProfileId);
    } else {
      db.prepare(
        `UPDATE chat_profiles
         SET assistant_active = 1, paused_until = NULL, updated_at = datetime('now')
         WHERE id = ?`
      ).run(chatProfileId);
    }

    logger.info(`Assistant resumed for chat profile ${chatProfileId}`);
    const profile = this.findById(chatProfileId);
    return this.syncAssistantStateForChatUser(this.syncAssistantStateForContact(profile));
  }

  enableAssistantExplicit(chatProfileId) {
    let profile = this.resumeAssistant(chatProfileId, true);
    profile = this.propagateImportedEnable(profile);
    logger.info(
      `Pinned ON profile ${profile?.id} (${profile?.contact_name}) chat=${profile?.chat_id} active=${profile?.assistant_active}`
    );
    return profile;
  }

  disableAssistant(chatProfileId) {
    const db = getDatabase();

    db.prepare(
      `UPDATE chat_profiles
       SET assistant_active = 0, assistant_pinned_on = 0, paused_until = NULL, updated_at = datetime('now')
       WHERE id = ?`
    ).run(chatProfileId);

    logger.info(`Assistant disabled for chat profile ${chatProfileId}`);
    const profile = this.findById(chatProfileId);
    return this.syncAssistantStateForContact(profile);
  }

  forceDisableAllContactAssistants(ownerPhone) {
    const db = getDatabase();
    const owner = normalizePhone(ownerPhone);

    db.prepare(
      `UPDATE chat_profiles
       SET assistant_active = 0, assistant_pinned_on = 0, paused_until = NULL, updated_at = datetime('now')
       WHERE owner_phone = ? AND chat_type = 'contact'`
    ).run(owner);

    logger.info(`Force disabled all contact assistants for owner ${owner}`);
  }

  isAssistantActive(profile, ownerUser = null) {
    if (!profile) return true;
    if (profile.chat_type !== 'contact') return true;

    if (profile.paused_until) {
      const until = new Date(profile.paused_until).getTime();
      if (Date.now() >= until) {
        this.resumeAssistant(profile.id);
        return true;
      }
      return false;
    }

    if (this.isContactPinned(profile)) return true;

    if (this.getMatchingPinnedImport(profile)) return true;

    if (ownerUser) {
      if (profile.contact_phone && this.isContactPhonePinned(ownerUser.phone, profile.contact_phone)) {
        return true;
      }
      if (profile.contact_name) {
        const owner = normalizePhone(profile.owner_phone);
        const pinnedImports = this.getPinnedImportedProfiles(owner);
        const profileName = profile.contact_name.trim().toLowerCase();
        if (
          pinnedImports.some((imp) =>
            this.contactNamesMatch(profileName, imp.contact_name)
          )
        ) {
          return true;
        }

        const db = getDatabase();
        const row = db
          .prepare(
            `SELECT COUNT(*) as count FROM chat_profiles
             WHERE owner_phone = ? AND chat_type = 'contact' AND LOWER(contact_name) = LOWER(?)
             AND assistant_pinned_on = 1 AND assistant_active = 1`
          )
          .get(owner, profile.contact_name.trim());
        if (Number(row?.count) > 0) return true;
      }
      if (profile.chat_id && this.isChatUserPinned(ownerUser.phone, profile.chat_id)) {
        return true;
      }
    }

    if (ownerUser && Number(ownerUser.assistant_contacts_enabled) === 1) {
      return Number(profile.assistant_active) === 1;
    }

    return false;
  }

  buildAssistantCache(ownerPhone, ownerUser = null) {
    const owner = normalizePhone(ownerPhone);
    const user = ownerUser || (owner ? userService.findByPhone(owner) : null);
    const pinnedImports = owner ? this.getPinnedImportedProfiles(owner) : [];
    const globalEnabled = Boolean(user && Number(user.assistant_contacts_enabled) === 1);

    const pinnedPhoneTails = new Set();
    const pinnedNames = new Set();
    const pinnedChatIds = new Set();

    if (owner) {
      const db = getDatabase();
      const rows = db
        .prepare(
          `SELECT contact_phone, contact_name, chat_id, assistant_pinned_on, assistant_active
           FROM chat_profiles WHERE owner_phone = ? AND chat_type = 'contact'`
        )
        .all(owner);

      for (const row of rows) {
        if (Number(row.assistant_pinned_on) !== 1 || Number(row.assistant_active) !== 1) continue;
        const tail = phoneTailDigits(
          canonicalContactPhone(row.contact_phone) || row.contact_phone
        );
        if (tail.length >= 10) pinnedPhoneTails.add(tail);
        if (row.contact_name) pinnedNames.add(row.contact_name.trim().toLowerCase());
        if (row.chat_id) {
          pinnedChatIds.add(row.chat_id);
          const userId = normalizePhone(row.chat_id);
          if (userId) pinnedChatIds.add(`${userId}@c.us`);
          if (userId) pinnedChatIds.add(`${userId}@lid`);
        }
      }
    }

    return (profile) => {
      if (!profile) return true;
      if (profile.chat_type !== 'contact') return true;

      if (profile.paused_until) {
        const until = new Date(profile.paused_until).getTime();
        if (Date.now() >= until) {
          this.resumeAssistant(profile.id);
          return true;
        }
        return false;
      }

      if (this.isContactPinned(profile)) return true;

      if (pinnedImports.some((imp) => this.matchesImportedContact(profile, imp))) {
        return true;
      }

      if (user) {
        const tail = phoneTailDigits(
          canonicalContactPhone(profile.contact_phone) || profile.contact_phone
        );
        if (tail.length >= 10 && pinnedPhoneTails.has(tail)) return true;

        const profileName = (profile.contact_name || '').trim().toLowerCase();
        if (profileName) {
          if (
            pinnedImports.some((imp) =>
              this.contactNamesMatch(profileName, imp.contact_name)
            )
          ) {
            return true;
          }
          if (pinnedNames.has(profileName)) return true;
        }

        if (profile.chat_id && pinnedChatIds.has(profile.chat_id)) return true;
        const userId = normalizePhone(profile.chat_id);
        if (userId && (pinnedChatIds.has(`${userId}@c.us`) || pinnedChatIds.has(`${userId}@lid`))) {
          return true;
        }
      }

      if (globalEnabled) return Number(profile.assistant_active) === 1;
      return false;
    };
  }

  parseProfileArgs(args) {
    const fields = {};
    const targetContact = args.match(/(?:^|\s)contact:\s*([^]+?)(?=\s+(?:name|phone|role|responsibilities|relations):|$)/i);
    if (targetContact) {
      fields.target_contact = targetContact[1].trim();
    }

    const patterns = {
      contact_name: /(?:^|\s)name:\s*([^]+?)(?=\s+(?:contact|phone|role|responsibilities|relations):|$)/i,
      contact_phone: /(?:^|\s)phone:\s*([^]+?)(?=\s+(?:name|role|responsibilities|relations):|$)/i,
      contact_role: /(?:^|\s)role:\s*([^]+?)(?=\s+(?:name|phone|responsibilities|relations):|$)/i,
      contact_responsibilities:
        /(?:^|\s)responsibilities:\s*([^]+?)(?=\s+(?:name|phone|role|relations):|$)/i,
      contact_relations:
        /(?:^|\s)relations:\s*([^]+?)(?=\s+(?:name|phone|role|responsibilities):|$)/i,
    };

    for (const [key, pattern] of Object.entries(patterns)) {
      const match = args.match(pattern);
      if (match) {
        fields[key] = match[1].trim();
      }
    }

    return fields;
  }

  formatProfile(profile) {
    if (!profile) return 'No profile found for this chat.';

    const lines = [
      '*Chat Profile*',
      `Contact: ${profile.contact_name || 'Unknown'}`,
      `Phone: ${profile.contact_phone || 'Unknown'}`,
      `Type: ${profile.chat_type}`,
      `Role: ${profile.contact_role || 'Not set — use /profile set role: ...'}`,
      `Responsibilities: ${profile.contact_responsibilities || 'Not set'}`,
      `Relation: ${profile.contact_relations || 'Not set'}`,
    ];

    return lines.join('\n');
  }

  formatContactsList(profiles) {
    if (!profiles || profiles.length === 0) {
      return 'No personal chats synced yet. They will appear after you restart the bot or message someone.';
    }

    const lines = profiles.map((profile, index) => {
      const relation = profile.contact_relations ? ` | Relation: ${profile.contact_relations}` : '';
      const role = profile.contact_role ? ` | Role: ${profile.contact_role}` : '';
      return `${index + 1}. ${profile.contact_name || 'Unknown'} (${profile.contact_phone || 'no number'})${role}${relation}`;
    });

    return `*Personal Chats*\n\n${lines.join('\n')}\n\nUse /profile in self-chat to set role, responsibilities, and relations.`;
  }

  looksLikeProfileInfo(text) {
    const lower = text.toLowerCase();
    const keywords = [
      'colleague',
      'coworker',
      'manager',
      'friend',
      'team',
      'works on',
      'responsible',
      'reports to',
      'my ',
      'is a',
      'role',
      'stack',
      'department',
      'relation',
    ];
    return keywords.some((word) => lower.includes(word));
  }

  async tryUpdateProfileFromMessage(profileId, text, accountUser = null, isSelfChat = false) {
    if (!isSelfChat || !this.looksLikeProfileInfo(text)) return null;

    let profile = this.findById(profileId);
    if (!profile) return null;

    const nameMatch = text.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/);
    if (nameMatch && profile.chat_type === 'self' && accountUser?.phone) {
      const namedProfile = this.findByContactName(accountUser.phone, nameMatch[1]);
      if (namedProfile) profile = namedProfile;
    }

    try {
      const groq = getGroqClient();
      const response = await groq.chat(
        [
          {
            role: 'system',
            content: `Extract contact profile information from the message.
Return ONLY valid JSON with keys: contact_name, contact_role, contact_responsibilities, contact_relations.
contact_relations should describe the relationship with this contact.
Use empty string for fields not mentioned. Do not invent details.`,
          },
          {
            role: 'user',
            content: `Existing profile:
name: ${profile.contact_name || ''}
role: ${profile.contact_role || ''}
responsibilities: ${profile.contact_responsibilities || ''}
relations: ${profile.contact_relations || ''}

Message: ${text}`,
          },
        ],
        {
          temperature: getChatTemperature(),
          maxTokens: 256,
          tier: MODEL_TIERS.FAST,
          usageContext: {
            chatProfileId: profile.id,
            ownerUserId: accountUser?.id ?? null,
            category: TOKEN_CATEGORIES.PROFILE,
          },
        }
      );

      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;

      const extracted = JSON.parse(jsonMatch[0]);
      const updates = {};

      for (const key of [
        'contact_name',
        'contact_role',
        'contact_responsibilities',
        'contact_relations',
      ]) {
        if (extracted[key] && String(extracted[key]).trim()) {
          updates[key] = String(extracted[key]).trim();
        }
      }

      if (Object.keys(updates).length === 0) return null;

      const updated = this.updateProfile(profileId, updates);
      logger.info(`Auto-updated chat profile ${profileId} from message context`);
      return updated;
    } catch (error) {
      logger.warn(`Profile auto-extraction failed: ${error.message}`);
      return null;
    }
  }

  getAll() {
    const db = getDatabase();
    return db
      .prepare('SELECT * FROM chat_profiles ORDER BY updated_at DESC')
      .all();
  }

  getByOwner(ownerPhone) {
    const db = getDatabase();
    const owner = normalizePhone(ownerPhone);
    return db
      .prepare(
        'SELECT * FROM chat_profiles WHERE owner_phone = ? ORDER BY contact_name ASC'
      )
      .all(owner);
  }
}

module.exports = new ChatProfileService();
