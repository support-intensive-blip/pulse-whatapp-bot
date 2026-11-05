import { receive, wake } from './inbox.js';
export default {
  async scheduled(_event, env, ctx) { ctx.waitUntil(wake(env)); },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/webhooks/gallabox' || /^\/webhooks\/(gallabox|gupshup)\/\d+$/.test(url.pathname)) return receive(request, env, ctx);
    if (url.pathname !== '/api' && !url.pathname.startsWith('/api/')) {
      if (env.DASHBOARD_REDIRECT === 'true') {
        if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 });
        const destination = new URL(env.BACKEND_ORIGIN);
        destination.pathname = url.pathname;
        destination.search = url.search;
        return new Response(null, { status: 302, headers: { Location: destination.href, 'Cache-Control': 'no-store' } });
      }
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
