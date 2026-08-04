/**
 * JST(UTC+9、夏時間なし)前提の日時ユーティリティと共通ヘルパー。
 */

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

export const WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'];

function pad(value, length = 2) {
  return String(value).padStart(length, '0');
}

export function jstParts(date) {
  const shifted = new Date(date.getTime() + JST_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
    weekday: shifted.getUTCDay(),
  };
}

export function toJstIso(date) {
  const p = jstParts(date);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}+09:00`;
}

/** 営業日。深夜営業のない拠点を前提にJSTの暦日を使う。 */
export function businessDate(date) {
  const p = jstParts(date);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

export function rawFileParts(date) {
  const p = jstParts(date);
  return { year: String(p.year), month: pad(p.month), day: pad(p.day) };
}

export function round(value, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function sum(values) {
  return values.reduce((acc, value) => acc + value, 0);
}

export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const DEFAULT_HEADERS = {
  'User-Agent':
    'queue-observer-jp/1.0 (+https://github.com/bonjinnorenka/queue-observer-jp)',
  'Accept-Language': 'ja,en;q=0.8',
};

/**
 * タイムアウトと指数バックオフ付きのfetch。2xx以外は再試行対象として扱う。
 */
export async function fetchWithRetry(url, { headers = {}, attempts = 3, timeoutMs = 15000, baseDelayMs = 1500 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { ...DEFAULT_HEADERS, ...headers },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'follow',
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}`);
      }
      const body = await response.text();
      return { body, receivedAt: new Date(), status: response.status };
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await sleep(baseDelayMs * attempt);
      }
    }
  }
  throw lastError;
}
