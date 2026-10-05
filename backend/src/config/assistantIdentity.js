function getAssistantName() {
  return process.env.ASSISTANT_NAME || 'JahNavi';
}

function getAssistantPersona() {
  return process.env.ASSISTANT_PERSONA || `I'm ${getAssistantName()} from NxtWave.`;
}

function getRoleWhenAsked() {
  return process.env.ASSISTANT_ROLE_WHEN_ASKED || `your NxtWave success coach`;
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
