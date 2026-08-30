import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import {
  buildDayFile,
  buildLatest,
  buildStats,
  regenerateIncrementalDerived,
} from '../src/aggregate.js';
import { buildIntervals } from '../src/derive.js';
import { normalizeSnapshot } from '../src/snapshot.js';
import { DERIVED_DIR, RAW_DIR, readJson } from '../src/storage.js';

const location = {
  id: 'test-location',
  name: 'テスト拠点',
  path: 'test/location',
};

function snapshot(observedAt, waitings, waitingsCount = waitings.length, pendings = []) {
  return normalizeSnapshot(
    location,
    {
      waitings: waitings.map((number) => ({ number, status: 4 })),
      pendings: pendings.map((number) => ({ number, status: 5 })),
      waitingscount: waitingsCount,
      pendingscount: pendings.length,
    },
    new Date(observedAt),
  );
}

/** 10:00-11:00に 1組 → 7組 → 4組 進む、合計12組/時のシナリオ。 */
function scenario() {
  const snapshots = [
    snapshot('2026-08-04T10:00:00+09:00', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 30),
    snapshot('2026-08-04T10:20:00+09:00', [2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 30),
    snapshot('2026-08-04T10:40:00+09:00', [9, 10, 11, 12, 13, 14, 15, 16], 28),
    snapshot('2026-08-04T11:00:00+09:00', [13, 14, 15, 16, 17, 18], 24),
  ];
  return { business_date: '2026-08-04', snapshots, intervals: buildIntervals(snapshots) };
}

describe('buildDayFile', () => {
  it('スナップショットの要約と区間の両方を持つ', () => {
    const day = buildDayFile(location, scenario());
    assert.equal(day.business_date, '2026-08-04');
    assert.equal(day.snapshot_count, 4);
    assert.equal(day.intervals.length, 3);
    assert.deepEqual(Object.keys(day.snapshots[0]).sort(), [
      'head_number',
      'observed_at',
      'pendings_count',
      'waitings_count',
      'waitings_truncated',
    ]);
    assert.equal(day.snapshots[0].head_number, 1);
  });
});

describe('buildStats', () => {
  it('曜日と時間帯のバケットに集計する', () => {
    const stats = buildStats(location, [scenario()]);

    assert.equal(stats.observation_days, 1);
    assert.equal(stats.snapshot_count, 4);
    assert.equal(stats.rate_eligible_interval_count, 3);
    assert.deepEqual(stats.date_range, { from: '2026-08-04', to: '2026-08-04' });

    // 2026-08-04は火曜日(weekday=2)。10時台に3区間すべてが入る。
    const bucket = stats.weekday_hours.find((entry) => entry.weekday === 2 && entry.hour === 10);
    assert.equal(bucket.interval_count, 3);
    assert.equal(bucket.advance_total, 12);
    assert.equal(bucket.rate_per_hour, 12);
    assert.equal(bucket.median_rate_per_hour, 12);
  });

  it('速度計算に使えない区間は集計から除外する', () => {
    const snapshots = [
      snapshot('2026-08-04T08:00:00+09:00', [], 0),
      snapshot('2026-08-04T08:20:00+09:00', [], 0),
    ];
    const stats = buildStats(location, [
      { business_date: '2026-08-04', snapshots, intervals: buildIntervals(snapshots) },
    ]);
    assert.equal(stats.rate_eligible_interval_count, 0);
    const bucket = stats.weekday_hours.find((entry) => entry.hour === 8);
    assert.equal(bucket.interval_count, 0);
    assert.equal(bucket.rate_per_hour, null);
  });
});

describe('buildLatest', () => {
  it('直近60分の速度で待ち時間を推定する', () => {
    const day = scenario();
    const stats = buildStats(location, [day]);
    const latest = buildLatest(location, day, stats, ['2026-08-04']);

    assert.equal(latest.observed_at, '2026-08-04T11:00:00+09:00');
    assert.equal(latest.waitings_count, 24);
    assert.equal(latest.queue_exit_rate_60m, 12);
    assert.equal(latest.rate_source, '60m');
    assert.equal(latest.estimated_wait_minutes, 120);
    assert.equal(latest.estimate_confidence, 'high');
    assert.equal(latest.rate_is_lower_bound, false);
  });

  it('待ち0なら推定待ち時間も0', () => {
    const snapshots = [
      snapshot('2026-08-04T10:00:00+09:00', [1, 2, 3], 3),
      snapshot('2026-08-04T10:20:00+09:00', [], 0),
    ];
    const day = { business_date: '2026-08-04', snapshots, intervals: buildIntervals(snapshots) };
    const stats = buildStats(location, [day]);
    const latest = buildLatest(location, day, stats, ['2026-08-04']);

    assert.equal(latest.estimated_wait_minutes, 0);
    assert.equal(latest.queue_exit_rate_60m, null);
  });

  it('観測データがなければnullで返す', () => {
    const stats = buildStats(location, []);
    const latest = buildLatest(location, null, stats, []);
    assert.equal(latest.observed_at, null);
    assert.deepEqual(latest.notes, ['観測データがまだありません']);
  });

  it('打ち切り区間が含まれる場合は下限値として印を付ける', () => {
    const snapshots = [
      snapshot('2026-08-04T10:00:00+09:00', [1, 2, 3], 30),
      snapshot('2026-08-04T10:20:00+09:00', [40, 41, 42], 30),
      snapshot('2026-08-04T10:40:00+09:00', [41, 42, 43], 30),
    ];
    const day = { business_date: '2026-08-04', snapshots, intervals: buildIntervals(snapshots) };
    const stats = buildStats(location, [day]);
    const latest = buildLatest(location, day, stats, ['2026-08-04']);

    assert.equal(latest.rate_windows['60m'].censored_interval_count, 1);
    assert.equal(latest.rate_is_lower_bound, true);
    assert.ok(latest.notes.some((note) => note.includes('実際の速度はこれ以上')));
  });
});

describe('regenerateIncrementalDerived', () => {
  const fixtureLocation = {
    id: 'test-incremental-string-dates',
    name: '増分更新テスト拠点',
    path: '_tmp_incremental_string_dates',
  };
  const rawDir = path.join(RAW_DIR, fixtureLocation.path);
  const derivedPath = path.join(DERIVED_DIR, fixtureLocation.path);

  after(async () => {
    await fs.rm(rawDir, { recursive: true, force: true });
    await fs.rm(derivedPath, { recursive: true, force: true });
  });

  it('文字列の observed_at / business_date とディスク上の stats.json でも増分更新できる', async () => {
    // 本番と同じ形: NDJSON の observed_at / business_date は ISO・営業日の文字列。
    // collect は append 後に regenerateIncrementalDerived(location, snapshot.business_date)
    // を呼ぶ。business_date は Date ではなく "2026-08-30" のような文字列。
    const snapshots = [
      snapshot('2026-08-30T11:00:00+09:00', [1, 2, 3, 4, 5], 25),
      snapshot('2026-08-30T11:16:03+09:00', [3, 4, 5, 6, 7], 23),
    ];
    assert.equal(typeof snapshots[0].observed_at, 'string');
    assert.equal(typeof snapshots[0].business_date, 'string');
    assert.equal(snapshots[0].business_date, '2026-08-30');

    const rawFile = path.join(rawDir, '2026', '08', '30.ndjson');
    await fs.mkdir(path.dirname(rawFile), { recursive: true });
    await fs.writeFile(rawFile, `${snapshots.map((row) => JSON.stringify(row)).join('\n')}\n`);

    // 既存の stats.json は JSON.parse したプレーンオブジェクト(Date ではない)。
    const persistedStats = {
      schema_version: 1,
      location_id: fixtureLocation.id,
      location_name: fixtureLocation.name,
      generated_at: '2026-08-07T01:02:46+09:00',
      observation_days: 1,
      date_range: { from: '2026-08-07', to: '2026-08-07' },
      snapshot_count: 4,
      rate_eligible_interval_count: 3,
      censored_interval_count: 0,
      weekday_hours: [
        {
          weekday: 0,
          hour: 11,
          rate_per_hour: 12,
          median_rate_per_hour: 12,
          interval_count: 3,
          advance_total: 12,
          duration_seconds: 3600,
          median_waitings_count: 24,
          max_waitings_count: 30,
          snapshot_count: 4,
        },
      ],
      hours: [],
      weekdays: [],
    };
    await fs.mkdir(derivedPath, { recursive: true });
    await fs.writeFile(
      path.join(derivedPath, 'stats.json'),
      `${JSON.stringify(persistedStats, null, 2)}\n`,
    );

    const result = await regenerateIncrementalDerived(fixtureLocation, '2026-08-30');

    assert.equal(result.days, 1);
    assert.equal(result.latest.business_date, '2026-08-30');
    assert.equal(result.latest.observed_at, '2026-08-30T11:16:03+09:00');
    assert.equal(result.latest.waitings_count, 23);
    assert.ok(Array.isArray(result.latest.available_dates));
    assert.ok(result.latest.available_dates.includes('2026-08-30'));
    assert.ok(result.written.length >= 1);
    assert.notEqual(result.latest.notes?.[0], '観測データがまだありません');

    const latestOnDisk = await readJson(path.join(derivedPath, 'latest.json'));
    assert.equal(latestOnDisk.observed_at, '2026-08-30T11:16:03+09:00');
    assert.equal(latestOnDisk.waitings_count, 23);

    const dayOnDisk = await readJson(path.join(derivedPath, '2026-08-30.json'));
    assert.equal(dayOnDisk.snapshot_count, 2);
    assert.equal(dayOnDisk.intervals.length, 1);
    assert.equal(typeof dayOnDisk.intervals[0].interval_start, 'string');
  });
});
