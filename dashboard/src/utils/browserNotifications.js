function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    output[i] = raw.charCodeAt(i);
  }
  return output;
}

function exportKeyBase64(applicationServerKey) {
  if (!applicationServerKey) return null;
  const bytes = applicationServerKey instanceof ArrayBuffer
    ? new Uint8Array(applicationServerKey)
    : new Uint8Array(applicationServerKey);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const NOTIFICATION_ICON = '/pulse-logo.png';

function buildNotificationOptions({ body, url, requireInteraction = false }) {
  return {
    body,
    icon: NOTIFICATION_ICON,
    badge: NOTIFICATION_ICON,
    data: { url },
    tag: `pulse-action-${Date.now()}`,
    requireInteraction,
    silent: false,
  };
}

const WINDOWS_NOTIFICATION_HELP =
  'Windows or Chrome is blocking the banner. Open Settings → System → Notifications → enable Google Chrome, turn off Focus Assist, then in Chrome visit chrome://settings/content/notifications and set this site to Allow.';

export { WINDOWS_NOTIFICATION_HELP };

function createTrackedNotification(title, options, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;

    const finish = (result, error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };

    timer = setTimeout(() => {
      finish(null, new Error(WINDOWS_NOTIFICATION_HELP));
    }, timeoutMs);

    try {
      const notification = new Notification(title, options);
      notification.onshow = () => finish({ method: 'notification-api', shown: true });
      notification.onerror = () => {
        finish(null, new Error(`Browser blocked the notification. ${WINDOWS_NOTIFICATION_HELP}`));
      };
    } catch (error) {
      finish(null, error);
    }
  });
}

async function showViaServiceWorker(title, options) {
  const registration = await waitForServiceWorker();
  await registration.showNotification(title, options);
  return { method: 'service-worker', shown: true };
}

export async function getNotificationDiagnostics() {
  const diagnostics = {
    secureContext: window.isSecureContext,
    permission: typeof Notification !== 'undefined' ? Notification.permission : 'unsupported',
    serviceWorker: 'serviceWorker' in navigator,
    pushManager: 'PushManager' in window,
    permissionQuery: null,
  };

  if (navigator.permissions?.query) {
    try {
      const status = await navigator.permissions.query({ name: 'notifications' });
      diagnostics.permissionQuery = status.state;
    } catch {
      diagnostics.permissionQuery = 'unavailable';
    }
  }

  return diagnostics;
}

/** Run from a click handler. Resolves only if the OS shows the notification. */
export function runNotificationTest({ title, body, url = '/actions' }) {
  if (!canUseBrowserNotifications()) {
    return Promise.reject(new Error('Notifications require HTTPS.'));
  }
  if (Notification.permission !== 'granted') {
    return Promise.reject(new Error('Notifications are not allowed for this site.'));
  }

  const options = {
    body,
    requireInteraction: true,
    silent: false,
    tag: `pulse-test-${Date.now()}`,
    data: { url },
  };

  return createTrackedNotification(title, options);
}

async function waitForServiceWorker(timeoutMs = 6000) {
  if (!('serviceWorker' in navigator)) {
    throw new Error('This browser does not support service workers.');
  }

  const existing = await navigator.serviceWorker.getRegistration();
  if (!existing) {
    await navigator.serviceWorker.register('/sw.js');
  }

  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise((_, reject) => {
      setTimeout(
        () => reject(new Error('Notification service worker timed out. Refresh the page and try again.')),
        timeoutMs
      );
    }),
  ]);
}

export async function registerNotificationServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;
  return waitForServiceWorker();
}

export const ACTION_ALERTS_CHANGED_EVENT = 'pulse-action-alerts-changed';

export function notifyActionAlertsChanged() {
  window.dispatchEvent(new Event(ACTION_ALERTS_CHANGED_EVENT));
}

export async function registerActionNotificationPush(configApi) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    throw new Error('This browser does not support web push notifications.');
  }

  const registration = await registerNotificationServiceWorker();

  const { publicKey } = await configApi.vapidPublicKey();
  if (!publicKey) {
    throw new Error('Server VAPID public key is not configured.');
  }

  let subscription = await registration.pushManager.getSubscription();
  if (subscription) {
    const existingKey = exportKeyBase64(subscription.options?.applicationServerKey);
    if (existingKey !== publicKey) {
      try {
        await configApi.unsubscribePush(subscription.endpoint);
      } catch {
        // ignore stale server record
      }
      await subscription.unsubscribe();
      subscription = null;
    }
  }

  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
  }

  await configApi.subscribePush(subscription.toJSON());
  return true;
}

export function canUseBrowserNotifications() {
  return typeof window !== 'undefined' && window.isSecureContext && typeof Notification !== 'undefined';
}

export function getBrowserNotificationPermission() {
  if (!canUseBrowserNotifications()) return 'unsupported';
  return Notification.permission;
}

/** Call synchronously from a click handler so the browser shows the permission prompt. */
export function requestBrowserNotificationPermission() {
  if (!canUseBrowserNotifications()) {
    return Promise.reject(
      new Error(
        'Browser notifications need a secure connection (HTTPS). Open the dashboard with https:// or use localhost.'
      )
    );
  }
  return Notification.requestPermission();
}

export async function enableActionBrowserNotifications(configApi) {
  const permission = await requestBrowserNotificationPermission();
  if (permission !== 'granted') {
    return permission;
  }

  if ('serviceWorker' in navigator) {
    try {
      await registerNotificationServiceWorker();
    } catch (error) {
      console.warn('Service worker registration failed:', error);
    }
  }

  try {
    await registerActionNotificationPush(configApi);
  } catch (error) {
    console.warn('Push registration failed; in-tab alerts will still work:', error);
  }

  return permission;
}

export function showInAppActionAlert({ title, body, url = '/actions' }) {
  if (typeof document === 'undefined') return;

  let stack = document.getElementById('pulse-action-toast-stack');
  if (!stack) {
    stack = document.createElement('div');
    stack.id = 'pulse-action-toast-stack';
    stack.style.cssText =
      'position:fixed;right:16px;bottom:16px;z-index:99999;display:flex;flex-direction:column-reverse;gap:10px;max-width:min(360px,calc(100vw - 32px));pointer-events:none;';
    document.body.appendChild(stack);
  }

  const root = document.createElement('div');
  root.setAttribute('role', 'alert');
  root.style.cssText =
    'pointer-events:auto;padding:14px 16px;border-radius:12px;background:#0f172a;color:#fff;box-shadow:0 12px 32px rgba(15,23,42,.35);font-family:Inter,system-ui,sans-serif;font-size:14px;line-height:1.4;';

  const titleEl = document.createElement('div');
  titleEl.style.fontWeight = '600';
  titleEl.textContent = title;

  const bodyEl = document.createElement('div');
  bodyEl.style.marginTop = '6px';
  bodyEl.style.opacity = '0.9';
  bodyEl.textContent = body;

  const actions = document.createElement('div');
  actions.style.marginTop = '12px';
  actions.style.display = 'flex';
  actions.style.gap = '8px';

  const openBtn = document.createElement('button');
  openBtn.type = 'button';
  openBtn.textContent = 'Open';
  openBtn.style.cssText =
    'border:0;border-radius:8px;padding:8px 12px;background:#2563eb;color:#fff;font-weight:600;cursor:pointer;';
  openBtn.onclick = () => {
    if (typeof url === 'string' && url.startsWith('/')) {
      window.history.pushState({}, '', url);
      window.dispatchEvent(new PopStateEvent('popstate'));
    } else {
      window.location.href = url;
    }
    root.remove();
  };

  const dismissBtn = document.createElement('button');
  dismissBtn.type = 'button';
  dismissBtn.textContent = 'Dismiss';
  dismissBtn.style.cssText =
    'border:1px solid rgba(255,255,255,.25);border-radius:8px;padding:8px 12px;background:transparent;color:#fff;cursor:pointer;';
  dismissBtn.onclick = () => root.remove();

  actions.append(openBtn, dismissBtn);
  root.append(titleEl, bodyEl, actions);
  stack.appendChild(root);

  window.setTimeout(() => root.remove(), 30000);
}

export async function showActionNotification({ title, body, url = '/actions' }) {
  if (!canUseBrowserNotifications()) return;
  if (Notification.permission !== 'granted') return;

  const options = buildNotificationOptions({ body, url });

  try {
    new Notification(title, options);
  } catch {
    try {
      await showViaServiceWorker(title, options);
    } catch {
      // best effort only
    }
  }
}

export function clearKnownActionNotifications() {
  sessionStorage.removeItem('pulse_notified_action_ids');
}

export async function disableActionBrowserNotifications(configApi) {
  if ('serviceWorker' in navigator) {
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      const subscription = await registration?.pushManager?.getSubscription();
      if (subscription) {
        await configApi.unsubscribePush(subscription.endpoint);
        await subscription.unsubscribe();
      }
    } catch (error) {
      console.warn('Push unsubscribe failed:', error);
    }
  }
}
