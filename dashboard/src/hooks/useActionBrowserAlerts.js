import { useEffect, useRef, useState } from 'react';

import { configApi } from '../api/client';

import {

  ACTION_ALERTS_CHANGED_EVENT,

  canUseBrowserNotifications,

  getBrowserNotificationPermission,

  registerActionNotificationPush,

  showActionNotification,

  showInAppActionAlert,

} from '../utils/browserNotifications';

import { formatActionItemTime, actionItemChatUrl } from '../utils/actionLinks';

import { useActionItemsFeed } from './useActionItemsFeed';



const ALERTS_KEY = 'pulse_action_browser_alerts';

const KNOWN_IDS_KEY = 'pulse_notified_action_ids';



function loadKnownIds() {

  try {

    return new Set(JSON.parse(sessionStorage.getItem(KNOWN_IDS_KEY) || '[]'));

  } catch {

    return new Set();

  }

}



function saveKnownIds(ids) {

  sessionStorage.setItem(KNOWN_IDS_KEY, JSON.stringify([...ids]));

}



function readAlertsActive() {

  return (

    localStorage.getItem(ALERTS_KEY) === 'on'

    && canUseBrowserNotifications()

    && getBrowserNotificationPermission() === 'granted'

  );

}



export function useActionBrowserAlerts() {

  const knownRef = useRef(loadKnownIds());

  const [active, setActive] = useState(readAlertsActive);

  const { items } = useActionItemsFeed({ status: 'pending' });

  const seededRef = useRef(false);



  useEffect(() => {

    function sync() {

      knownRef.current = loadKnownIds();

      setActive(readAlertsActive());

    }



    window.addEventListener(ACTION_ALERTS_CHANGED_EVENT, sync);

    window.addEventListener('storage', sync);

    window.addEventListener('focus', sync);

    return () => {

      window.removeEventListener(ACTION_ALERTS_CHANGED_EVENT, sync);

      window.removeEventListener('storage', sync);

      window.removeEventListener('focus', sync);

    };

  }, []);



  useEffect(() => {

    if (!active) return undefined;



    registerActionNotificationPush(configApi).catch((error) => {

      console.warn('Push re-registration failed:', error);

    });

  }, [active]);



  useEffect(() => {

    if (!active) return;



    const pendingItems = items.filter((item) => item.status === 'pending');



    if (!seededRef.current) {

      for (const item of pendingItems) {

        knownRef.current.add(item.id);

      }

      saveKnownIds(knownRef.current);

      seededRef.current = true;

      return;

    }



    (async () => {

      for (const item of pendingItems) {

        if (knownRef.current.has(item.id)) continue;

        const when = formatActionItemTime(item);

        const alertBody = `${item.title} · ${item.contact_name || 'Unknown contact'}${when ? ` · ${when}` : ''}`;

        const alertUrl = actionItemChatUrl(item);

        showInAppActionAlert({

          title: 'New Call to Action',

          body: alertBody,

          url: alertUrl,

        });

        await showActionNotification({

          title: item.title || 'Call to Action',

          body: `${item.contact_name || 'Unknown contact'}${when ? ` · ${when}` : ''}`,

          url: alertUrl,

        });

        knownRef.current.add(item.id);

      }

      saveKnownIds(knownRef.current);

    })();

  }, [active, items]);

}

