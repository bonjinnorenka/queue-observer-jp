/**
 * 10分ごとの観測エントリポイント。
 *
 *   1. 管理画面HTMLからアクセストークンを取得
 *   2. 待機列APIをBearerトークン付きで取得(observed_at は実際の取得完了時刻)
 *   3. 生スナップショットを raw NDJSON に追記
 *   4. derived を増分更新(今日分のみ)
 */

import { regenerateIncrementalDerived } from './aggregate.js';
import { normalizeSnapshot } from './snapshot.js';
import {
  STATUS_FILE,
  appendSnapshot,
  readLocations,
  writeJson,
} from './storage.js';
import { fetchAccessToken } from './token.js';
import { fetchWithRetry, toJstIso } from './util.js';

async function fetchWaiting(apiUrl, accessToken) {
  const { body, receivedAt } = await fetchWithRetry(apiUrl, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });
  let payload;
  try {
    payload = JSON.parse(body);
  } catch (error) {
    throw new Error(`APIレスポンスのJSONパースに失敗しました: ${error.message}`);
  }
  return { payload, observedAt: receivedAt };
}

async function collectLocation(location) {
  const { accessToken } = await fetchAccessToken(location.admin_url);
  const { payload, observedAt } = await fetchWaiting(location.api_url, accessToken);
  const snapshot = normalizeSnapshot(location, payload, observedAt);

  const file = await appendSnapshot(location, snapshot, observedAt);
  console.log(
    `[ok] ${location.id} ${snapshot.observed_at} waitings=${snapshot.waitings_count} pendings=${snapshot.pendings_count} -> ${file}`,
  );

  // 増分更新: 今日のファイルとlatestのみ更新
  const { latest } = await regenerateIncrementalDerived(location, snapshot.business_date);
  console.log(
    `[derived] ${location.id} rate60m=${latest.queue_exit_rate_60m ?? '-'}/h estimate=${latest.estimated_wait_minutes ?? '-'}min (${latest.estimate_confidence ?? 'n/a'})`,
  );

  return {
    location_id: location.id,
    ok: true,
    observed_at: snapshot.observed_at,
    waitings_count: snapshot.waitings_count,
    pendings_count: snapshot.pendings_count,
    error: null,
  };
}

async function main() {
  const locations = await readLocations();
  const results = [];

  for (const location of locations) {
    try {
      results.push(await collectLocation(location));
    } catch (error) {
      console.error(`[fail] ${location.id}: ${error.message}`);
      results.push({
        location_id: location.id,
        ok: false,
        observed_at: null,
        waitings_count: null,
        pendings_count: null,
        error: error.message,
      });
    }
  }

  // 取得失敗もコミット対象として残し、サイト側で警告を出せるようにする。
  await writeJson(STATUS_FILE, {
    schema_version: 1,
    attempted_at: toJstIso(new Date()),
    results,
  });

  const failed = results.filter((result) => !result.ok);
  if (failed.length === results.length && results.length > 0) {
    // 全件失敗でもワークフローは失敗させない。次回の派生計算がギャップとして除外する。
    console.error('[warn] すべての拠点で取得に失敗しました');
  }
}

await main();
