const { getDatabase } = require('../database/db');

const logger = require('../utils/logger');

const { normalizePhone } = require('../utils/helpers');

const { getAssistantIdentity, isPersonaLocked } = require('../config/assistantIdentity');
const { MODEL_TIERS } = require('../config/modelConfig');



class UserService {

  findByPhone(phone) {

    const db = getDatabase();

    const normalized = normalizePhone(phone);

    return db.prepare('SELECT * FROM users WHERE phone = ?').get(normalized) || null;

  }



  findById(id) {

    const db = getDatabase();

    return db.prepare('SELECT * FROM users WHERE id = ?').get(id) || null;

  }



  getOrCreate(phone, name = null) {

    const db = getDatabase();

    const normalized = normalizePhone(phone);



    let user = this.findByPhone(normalized);

    if (user) {

      if (name && name !== user.name) {

        db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, user.id);

        user = this.findById(user.id);

      }

      return user;

    }



    const result = db

      .prepare('INSERT INTO users (phone, name) VALUES (?, ?)')

      .run(normalized, name);



    user = this.findById(result.lastInsertRowid);

    logger.info(`Created new user: ${normalized}`);

    return user;

  }



  formatAssistantInfo() {

    const assistant = getAssistantIdentity();

    const lines = [

      '*Assistant*',

      `Name: ${assistant.name}`,

      `Persona: ${assistant.persona}`,

    ];



    if (isPersonaLocked()) {

      lines.push('Edit ASSISTANT_NAME or ASSISTANT_PERSONA in .env and restart to customize.');

    }



    return lines.join('\n');

  }



  getAssistantIdentity() {

    return getAssistantIdentity();

  }



  getAll() {

    const db = getDatabase();

    return db.prepare('SELECT * FROM users ORDER BY created_at DESC').all();

  }



  setAssistantSelf(userId, enabled) {

    const db = getDatabase();

    db.prepare('UPDATE users SET assistant_self_enabled = ? WHERE id = ?').run(

      enabled ? 1 : 0,

      userId

    );

    logger.info(`Assistant self-chat ${enabled ? 'enabled' : 'disabled'} for user ${userId}`);

    const user = this.findById(userId);
    this.syncToBotAccount(user);
    return user;

  }



  setAssistantContacts(userId, enabled) {

    const db = getDatabase();

    db.prepare('UPDATE users SET assistant_contacts_enabled = ? WHERE id = ?').run(

      enabled ? 1 : 0,

      userId

    );

    logger.info(`Assistant contacts ${enabled ? 'enabled' : 'disabled'} for user ${userId}`);

    const user = this.findById(userId);
    if (enabled && user?.phone) {
      const chatProfileService = require('./chatProfileService');
      chatProfileService.enableAllContactAssistants(user.phone);
    }

    this.syncToBotAccount(user);
    return user;

  }



  isAssistantSelfEnabled(user) {

    if (!user) return true;

    const value = user.assistant_self_enabled;

    return value === undefined || value === null ? true : Number(value) === 1;

  }



  isAssistantContactsEnabled(user) {

    if (!user) return true;

    const value = user.assistant_contacts_enabled;

    return value === undefined || value === null ? true : Number(value) === 1;

  }



  formatAssistantStatus(user) {

    const selfStatus = this.isAssistantSelfEnabled(user) ? 'ON' : 'OFF';

    const contactsStatus = this.isAssistantContactsEnabled(user) ? 'ON' : 'OFF';



    return [

      '*Assistant Status*',

      `Self-chat: ${selfStatus}`,

      `All contacts: ${contactsStatus}`,

    ].join('\n');

  }



  setGuruMode(userId, enabled) {

    const db = getDatabase();

    db.prepare('UPDATE users SET guru_mode = ? WHERE id = ?').run(enabled ? 1 : 0, userId);

    logger.info(`Guru mode ${enabled ? 'enabled' : 'disabled'} for user ${userId}`);

    const user = this.findById(userId);
    this.syncToBotAccount(user);
    return user;

  }

  syncToBotAccount(user) {
    if (!user) return;
    const { botAccountService } = require('./botAccountService');
    botAccountService.syncFromWhatsAppUser(user);
  }



  isGuruModeEnabled(userId) {

    const user = this.findById(userId);

    return user ? user.guru_mode === 1 : false;

  }



  setChatModelTier(userId, tier) {

    const normalized = tier === MODEL_TIERS.SMART ? MODEL_TIERS.SMART : MODEL_TIERS.FAST;
    const db = getDatabase();
    db.prepare('UPDATE users SET chat_model_tier = ? WHERE id = ?').run(normalized, userId);
    logger.info(`Chat model tier set to ${normalized} for user ${userId}`);
    return this.findById(userId);

  }



  getChatModelTier(userId) {

    const user = this.findById(userId);
    if (!user?.chat_model_tier) return MODEL_TIERS.FAST;
    return user.chat_model_tier === MODEL_TIERS.SMART ? MODEL_TIERS.SMART : MODEL_TIERS.FAST;

  }



  getCount() {

    const db = getDatabase();

    const result = db.prepare('SELECT COUNT(*) as count FROM users').get();

    return result.count;

  }

}



module.exports = new UserService();

