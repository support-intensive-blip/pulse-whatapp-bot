import { receive, wake } from './inbox.js';
export default {
  async scheduled(_event, env, ctx) { ctx.waitUntil(wake(env)); },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/webhooks/gallabox' || /^\/webhooks\/gallabox\/\d+$/.test(url.pathname)) return receive(request, env, ctx);
    if (url.pathname !== '/api' && !url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }
    const upstream = new URL(env.BACKEND_ORIGIN);
    upstream.pathname = url.pathname;
    upstream.search = url.search;
    const headers = new Headers(request.headers);
    headers.delete('host');
    try {
      const response = await fetch(upstream, {
        method: request.method,
        headers,
        body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
        redirect: 'manual',
      });
      const result = new Response(response.body, response);
      result.headers.set('Cache-Control', 'no-store');
      return result;
    } catch {
      return Response.json({ error: 'The server is unavailable. Please try again shortly.' }, {
        status: 503, headers: { 'Cache-Control': 'no-store' },
      });
    }
  },
};
