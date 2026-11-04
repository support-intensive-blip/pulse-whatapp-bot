const axios = require('axios');

async function sendText(config, phone, text) {
  const body = new URLSearchParams({ channel: 'whatsapp', source: config.phone,
    destination: phone, 'src.name': config.channelId,
    message: JSON.stringify({ type: 'text', text: String(text) }) });
  const { data } = await axios.post('https://api.gupshup.io/wa/api/v1/msg', body.toString(), {
    headers: { apikey: config.apiKey, 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 20000,
  });
  if (data?.status !== 'submitted' || !data.messageId) throw new Error('Gupshup did not accept the message');
  return { id: data.messageId };
}

async function testConnection(config) {
  if (!config.apiKey || !config.channelId || !config.phone) {
    return { ok: false, verified: false, message: 'API key, app name and WhatsApp number are required.' };
  }
  return { ok: true, verified: null, message: 'Fields complete. Verify delivery with an inbound WhatsApp message after configuring the callback.' };
}

module.exports = { sendText, testConnection };
