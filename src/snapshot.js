/**
 * APIレスポンスを保存用スナップショットへ正規化する。
 *
 * 番号順にソートせず、APIが返した配列順を position として保存する。
 * 配列順が実際の呼出し優先順を示している可能性があり、並べ直すと情報が失われる。
 */

import { businessDate, toJstIso } from './util.js';

export const SCHEMA_VERSION = 1;

function normalizeEntries(entries) {
  if (!Array.isArray(entries)) return [];
  return entries.map((entry, position) => {
    const normalized = {
      position,
      number: Number(entry.number),
      status: entry.status ?? null,
    };
    if (entry.answer1 !== null && entry.answer1 !== undefined) normalized.answer1 = entry.answer1;
    if (entry.answer2 !== null && entry.answer2 !== undefined) normalized.answer2 = entry.answer2;
    return normalized;
  });
}

export function normalizeSnapshot(location, payload, observedAt) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('APIレスポンスがオブジェクトではありません');
  }

  const waitings = normalizeEntries(payload.waitings);
  const pendings = normalizeEntries(payload.pendings);
  const waitingsCount = Number.isFinite(payload.waitingscount)
    ? payload.waitingscount
    : waitings.length;
  const pendingsCount = Number.isFinite(payload.pendingscount)
    ? payload.pendingscount
    : pendings.length;

  return {
    schema_version: SCHEMA_VERSION,
    location_id: location.id,
    observed_at: toJstIso(observedAt),
    business_date: businessDate(observedAt),
    waitings_count: waitingsCount,
    pendings_count: pendingsCount,
    // APIはwaitingsを先頭20件程度しか返さないため、全件が見えているかを記録しておく。
    waitings_truncated: waitings.length < waitingsCount,
    waitings,
    pendings,
  };
}
