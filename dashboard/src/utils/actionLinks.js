import { formatISTDateTime } from './time';

export function formatActionItemTime(item) {
  const ts = item?.trigger_message_at || item?.triggered_at;
  return formatISTDateTime(ts);
}

export function actionItemChatUrl(item) {
  if (!item?.chat_profile_id) return '/actions';
  const base = `/conversations/${item.chat_profile_id}`;
  if (item.trigger_message_id) {
    return `${base}?msg=${item.trigger_message_id}`;
  }
  return base;
}
