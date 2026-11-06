const { randomUUID } = require('node:crypto');

const POSTBACK_PREFIX = 'pulse-menu:';
const GREETING = /^(?:hi+|hello|hey|namaste)(?:\s+andi)?(?:\s+tinnara)?$/u;
const matchText = (value) => value.trim().toLowerCase().replace(/[!?.,]+$/u, '').trim();

function normalizeMenu(value) {
  const string = (input, limit) => String(input ?? '').trim().slice(0, limit);
  const options = Array.isArray(value?.options) ? value.options.slice(0, 10).map(option => ({
    id: string(option?.id, 64),
    label: string(option?.label, 24),
    description: string(option?.description, 72),
    request: string(option?.request, 500),
  })) : [];
  const menu = {
    enabled: value?.enabled === true,
    greetings: value?.greetings === true,
    shortcuts: Array.isArray(value?.shortcuts)
      ? [...new Set(value.shortcuts.slice(0, 20).map(word => matchText(string(word, 60))).filter(Boolean))]
      : ['menu', 'help'],
    intro: string(value?.intro, 500) || 'Choose a topic, or type your question.',
    title: string(value?.title, 60) || 'Support menu',
    button: string(value?.button, 20) || 'Choose a topic',
    options,
  };
  if (options.some(option => !/^[\w-]+$/.test(option.id) || !matchText(option.label)) ||
      new Set(options.map(option => option.id)).size !== options.length ||
      new Set(options.map(option => matchText(option.label))).size !== options.length) {
    throw new Error('Give each menu option a unique label.');
  }
  if (menu.enabled && (!options.length || (!menu.greetings && !menu.shortcuts.length))) {
    throw new Error('Add a menu option and enable greetings or enter a shortcut.');
  }
  if (menu.enabled && options.some(option => menu.shortcuts.includes(matchText(option.label)) ||
      (menu.greetings && GREETING.test(matchText(option.label))))) {
    throw new Error('Menu options and menu triggers must use different wording.');
  }
  return menu;
}

function readMenu(bot) {
  try {
    return normalizeMenu(JSON.parse(bot?.whatsapp_menu || 'null'));
  } catch {
    return normalizeMenu(null);
  }
}

function getMenuReply(menu, body, supportsLists) {
  const text = matchText(body);
  if (!menu.enabled || !(menu.shortcuts.includes(text) || (menu.greetings && GREETING.test(text)))) return null;
  return {
    text: [menu.intro, ...menu.options.map(option => `• ${option.label}`), 'Type an option to select it.'].join('\n'),
    message: supportsLists ? {
      type: 'list',
      title: menu.title,
      body: menu.intro,
      msgid: randomUUID(),
      globalButtons: [{ type: 'text', title: menu.button }],
      items: [{ title: 'Options', options: menu.options.map(option => ({
        type: 'text', title: option.label, description: option.description, postbackText: POSTBACK_PREFIX + option.id,
      })) }],
    } : undefined,
  };
}

function findOption(menu, body, postback) {
  if (!menu.enabled) return null;
  if (postback) return menu.options.find(option => postback === POSTBACK_PREFIX + option.id);
  return menu.options.find(option => matchText(body) === matchText(option.label));
}

module.exports = { normalizeMenu, readMenu, getMenuReply, findOption, POSTBACK_PREFIX };
