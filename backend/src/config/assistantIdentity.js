const { currentBot } = require('../utils/botContext');

// Inside a bot context (see utils/botContext.js) the identity comes from that
// bot's settings; env values remain the fallback for the original Intensive bot.

function getAssistantName() {
  return currentBot()?.assistant_name || process.env.ASSISTANT_NAME || 'JahNavi';
}

function getAssistantPersona() {
  return currentBot()?.assistant_persona || process.env.ASSISTANT_PERSONA || `I'm ${getAssistantName()} from NxtWave.`;
}

function getRoleWhenAsked() {
  return currentBot()?.assistant_role_when_asked || process.env.ASSISTANT_ROLE_WHEN_ASKED || `your NxtWave success coach`;
}

function isIdentityQuestion(text) {
  const q = (text || '').trim().toLowerCase();
  if (!q) return false;
  return /\b(who are you|who is this|who am i (talking|chatting|speaking) to|what are you|what do you do|what is your (name|role)|tell me about yourself|introduce yourself)\b/.test(
    q
  );
}

function getAssistantIdentity() {
  return {
    name: getAssistantName(),
    persona: getAssistantPersona(),
  };
}

function isPersonaLocked() {
  return process.env.ASSISTANT_PERSONA_LOCKED !== 'false';
}

module.exports = {
  getAssistantName,
  getAssistantPersona,
  getRoleWhenAsked,
  getAssistantIdentity,
  isPersonaLocked,
  isIdentityQuestion,
};
