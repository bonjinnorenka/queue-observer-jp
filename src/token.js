/**
 * 管理画面HTMLの <script id="script" data-content="..."> からアクセストークンを取り出す。
 * data-content はHTMLエスケープされたJSONで、api_url / shop / access_token を含む。
 */

import { fetchWithRetry } from './util.js';

const NAMED_ENTITIES = {
  quot: '"',
  amp: '&',
  lt: '<',
  gt: '>',
  apos: "'",
  nbsp: '\u00a0',
};

export function unescapeHtml(text) {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, entity) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    }
    if (entity.startsWith('#')) {
      return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    }
    const named = NAMED_ENTITIES[entity.toLowerCase()];
    return named === undefined ? match : named;
  });
}

export function extractScriptContent(html) {
  const candidates = [
    /<script[^>]*\bid="script"[^>]*\bdata-content="([^"]*)"/,
    /<script[^>]*\bdata-content="([^"]*)"[^>]*\bid="script"/,
    /\bdata-content="([^"]*access_token[^"]*)"/,
  ];
  for (const pattern of candidates) {
    const match = html.match(pattern);
    if (match) return unescapeHtml(match[1]);
  }
  throw new Error('data-content 属性が見つかりませんでした(ページ構造が変わった可能性があります)');
}

export function extractAccessToken(html) {
  const json = extractScriptContent(html);
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new Error(`data-content のJSONパースに失敗しました: ${error.message}`);
  }
  const accessToken = parsed.access_token;
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new Error('data-content に access_token が含まれていませんでした');
  }
  return { accessToken, shop: parsed.shop ?? null, apiUrl: parsed.api_url ?? null };
}

export async function fetchAccessToken(adminUrl) {
  const { body } = await fetchWithRetry(adminUrl);
  return extractAccessToken(body);
}
