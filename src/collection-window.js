import { jstParts } from './util.js';

/** JST の収集対象時間帯。これ以外は取得しない。 */
export const COLLECTION_WINDOW = {
  start: { hour: 5, minute: 45 },
  end: { hour: 21, minute: 10 },
};

function toMinutes({ hour, minute }) {
  return hour * 60 + minute;
}

export function formatCollectionWindow() {
  const pad = (value) => String(value).padStart(2, '0');
  const { start, end } = COLLECTION_WINDOW;
  return `${pad(start.hour)}:${pad(start.minute)}-${pad(end.hour)}:${pad(end.minute)}`;
}

export function isWithinCollectionWindow(date = new Date()) {
  const { hour, minute } = jstParts(date);
  const current = hour * 60 + minute;
  return (
    current >= toMinutes(COLLECTION_WINDOW.start) && current <= toMinutes(COLLECTION_WINDOW.end)
  );
}
