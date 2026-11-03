const bytes = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));
const hex = buffer => [...new Uint8Array(buffer)].map(b => b.toString(16).padStart(2, '0')).join('');
async function rest(env, path, options = {}) {
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    ...options, headers: { apikey: env.SUPABASE_SECRET_KEY, Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`, 'Content-Type': 'application/json', ...options.headers },
  });
  if (!response.ok) throw new Error(`Inbox storage unavailable (${response.status})`);
  return response.status === 204 ? null : response.json();
}
async function secret(env, encrypted) {
  const [iv, tag, data] = encrypted.split(':');
  const key = await crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', new TextEncoder().encode(env.ENCRYPTION_KEY)), 'AES-GCM', false, ['decrypt']);
  const ciphertext = new Uint8Array([...bytes(data), ...bytes(tag)]);
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(iv) }, key, ciphertext));
}
export async function receive(request, env, ctx) {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY || !env.ENCRYPTION_KEY) return new Response('Inbox not configured', { status: 503 });
  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > 2 * 1024 * 1024) return new Response('Too large', { status: 413 });
  try {
    const payload = JSON.parse(raw);
    const id = new URL(request.url).pathname.split('/')[3];
    let path;
    if (id && /^\d+$/.test(id)) path = `bot_accounts?id=eq.${id}`;
    else if (!id && payload.channelId) path = `bot_accounts?gallabox_channel_id=eq.${encodeURIComponent(payload.channelId)}`;
    else return new Response('Bot identifier required', { status: 400 });
    const bots = await rest(env, `${path}&select=id,webhook_secret_enc&limit=1`);
    if (!bots.length || !bots[0].webhook_secret_enc) return new Response('Unknown bot', { status: 404 });
    const bot = bots[0];
    const signature = request.headers.get('x-gallabox-signature') || '';
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(await secret(env, bot.webhook_secret_enc)), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const sig = signature.replace(/^sha256=/, '');
    const signatureBytes = /^[a-f0-9]{64}$/i.test(sig) ? Uint8Array.from(sig.match(/../g), b => parseInt(b, 16)) : bytes(sig);
    if (!await crypto.subtle.verify('HMAC', key, signatureBytes, new TextEncoder().encode(raw))) return new Response('Invalid signature', { status: 401 });
    const event = request.headers.get('x-event-name') || payload.event || payload.eventName || 'Message.Received';
    const messageId = payload.whatsapp?.id || payload.id;
    const identity = `${bot.id}:${event}:${messageId || raw}`;
    const digest = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity)));
    await rest(env, 'webhook_inbox?on_conflict=id', { method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify({ id: digest, bot_id: bot.id, event_name: event, raw_body: raw, signature }) });
    ctx.waitUntil(wake(env));
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: 'Message could not be durably accepted; retry delivery.' }, { status: 503 });
  }
}
export async function wake(env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) return;
  const pending = await rest(env, 'webhook_inbox?state=in.(pending,processing)&select=id&limit=1');
  if (pending.length) await fetch(`${env.BACKEND_ORIGIN}/health`, { signal: AbortSignal.timeout(20000) }).catch(() => {});
}
