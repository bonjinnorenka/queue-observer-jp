/**
 * 生データ(raw NDJSON)からサイト表示用の派生データを再生成する。
 * derived 配下は常に raw から作り直せる。statusの解釈や計算式を変えたら rebuild すればよい。
 */

import path from 'node:path';

import { buildIntervals, rateOverWindow } from './derive.js';
import {
  derivedDir,
  listRawFiles,
  readSnapshotFile,
  writeJsonIfChanged,
} from './storage.js';
import { jstParts, median, round, sum, toJstIso } from './util.js';

export const DERIVED_SCHEMA_VERSION = 1;

const RATE_WINDOWS = [20, 60, 120];

/** 拠点の全生データを営業日ごとにまとめて読み込む。 */
export async function loadAllDays(location) {
  const files = await listRawFiles(location);
  const byDate = new Map();

  for (const file of files) {
    for (const snapshot of await readSnapshotFile(file)) {
      const date = snapshot.business_date;
      if (!date) continue;
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date).push(snapshot);
    }
  }

  return [...byDate.keys()]
    .sort()
    .map((businessDate) => {
      const snapshots = byDate
        .get(businessDate)
        .sort((a, b) => new Date(a.observed_at).getTime() - new Date(b.observed_at).getTime());
      return { business_date: businessDate, snapshots, intervals: buildIntervals(snapshots) };
    });
}

function compactSnapshot(snapshot) {
  return {
    observed_at: snapshot.observed_at,
    waitings_count: snapshot.waitings_count,
    pendings_count: snapshot.pendings_count,
    waitings_truncated: snapshot.waitings_truncated ?? null,
    head_number: snapshot.waitings?.[0]?.number ?? null,
  };
}

export function buildDayFile(location, day) {
  return {
    schema_version: DERIVED_SCHEMA_VERSION,
    location_id: location.id,
    location_name: location.name,
    business_date: day.business_date,
    generated_at: toJstIso(new Date()),
    snapshot_count: day.snapshots.length,
    snapshots: day.snapshots.map(compactSnapshot),
    intervals: day.intervals,
  };
}

function bucketKey(weekday, hour) {
  return `${weekday}-${hour}`;
}

function summarizeBucket(bucket) {
  const durationSeconds = sum(bucket.intervals.map((interval) => interval.duration_seconds));
  const advanceTotal = sum(bucket.intervals.map((interval) => interval.queue_advance_observed));
  const perIntervalRates = bucket.intervals.map((interval) => interval.queue_exit_rate_per_hour);

  return {
    rate_per_hour: durationSeconds > 0 ? round(advanceTotal / (durationSeconds / 3600)) : null,
    median_rate_per_hour: round(median(perIntervalRates)),
    interval_count: bucket.intervals.length,
    advance_total: advanceTotal,
    duration_seconds: durationSeconds,
    median_waitings_count: round(median(bucket.waitingCounts), 1),
    max_waitings_count: bucket.waitingCounts.length ? Math.max(...bucket.waitingCounts) : null,
    snapshot_count: bucket.waitingCounts.length,
  };
}

/**
 * 曜日×時間帯の履歴統計。速度は「有効区間の消化数合計 ÷ 観測時間合計」で求める。
 */
export function buildStats(location, days) {
  const buckets = new Map();
  const hours = new Map();
  const weekdays = new Map();

  const touch = (map, key, seed) => {
    if (!map.has(key)) map.set(key, { ...seed, intervals: [], waitingCounts: [] });
    return map.get(key);
  };

  let snapshotCount = 0;
  let rateEligibleCount = 0;
  let censoredCount = 0;

  for (const day of days) {
    for (const snapshot of day.snapshots) {
      snapshotCount += 1;
      const { weekday, hour } = jstParts(new Date(snapshot.observed_at));
      touch(buckets, bucketKey(weekday, hour), { weekday, hour }).waitingCounts.push(
        snapshot.waitings_count,
      );
      touch(hours, hour, { hour }).waitingCounts.push(snapshot.waitings_count);
      touch(weekdays, weekday, { weekday }).waitingCounts.push(snapshot.waitings_count);
    }

    for (const interval of day.intervals) {
      if (interval.censored) censoredCount += 1;
      if (!interval.rate_eligible) continue;
      rateEligibleCount += 1;
      const { weekday, hour } = jstParts(new Date(interval.interval_start));
      touch(buckets, bucketKey(weekday, hour), { weekday, hour }).intervals.push(interval);
      touch(hours, hour, { hour }).intervals.push(interval);
      touch(weekdays, weekday, { weekday }).intervals.push(interval);
    }
  }

  const dates = days.map((day) => day.business_date);

  return {
    schema_version: DERIVED_SCHEMA_VERSION,
    location_id: location.id,
    location_name: location.name,
    generated_at: toJstIso(new Date()),
    observation_days: days.length,
    date_range: dates.length ? { from: dates[0], to: dates[dates.length - 1] } : null,
    snapshot_count: snapshotCount,
    rate_eligible_interval_count: rateEligibleCount,
    censored_interval_count: censoredCount,
    weekday_hours: [...buckets.values()]
      .sort((a, b) => a.weekday - b.weekday || a.hour - b.hour)
      .map((bucket) => ({ weekday: bucket.weekday, hour: bucket.hour, ...summarizeBucket(bucket) })),
    hours: [...hours.values()]
      .sort((a, b) => a.hour - b.hour)
      .map((bucket) => ({ hour: bucket.hour, ...summarizeBucket(bucket) })),
    weekdays: [...weekdays.values()]
      .sort((a, b) => a.weekday - b.weekday)
      .map((bucket) => ({ weekday: bucket.weekday, ...summarizeBucket(bucket) })),
  };
}

function historyRate(stats, referenceTime) {
  const { weekday, hour } = jstParts(referenceTime);
  const bucket = stats.weekday_hours.find(
    (entry) => entry.weekday === weekday && entry.hour === hour,
  );
  if (bucket?.rate_per_hour) return { rate: bucket.rate_per_hour, source: 'weekday_hour_history' };
  const hourBucket = stats.hours.find((entry) => entry.hour === hour);
  if (hourBucket?.rate_per_hour) return { rate: hourBucket.rate_per_hour, source: 'hour_history' };
  return null;
}

function confidenceFor(source, window) {
  if (source === '60m') {
    if (window.interval_count >= 3 && window.censored_interval_count === 0) return 'high';
    if (window.interval_count >= 2) return 'medium';
    return 'low';
  }
  if (source === '120m') return window.interval_count >= 3 ? 'medium' : 'low';
  return 'low';
}

/**
 * サイト表示用の最新値。表示に使う速度は直近60分を第一候補とする。
 * historyStats には当日を除いた履歴を渡す。当日の観測を「過去平均」として比べると循環するため。
 */
export function buildLatest(location, day, historyStats, availableDates) {
  const stats = historyStats;
  const snapshot = day?.snapshots?.[day.snapshots.length - 1] ?? null;
  const generatedAt = toJstIso(new Date());

  if (!snapshot) {
    return {
      schema_version: DERIVED_SCHEMA_VERSION,
      location_id: location.id,
      location_name: location.name,
      generated_at: generatedAt,
      observed_at: null,
      available_dates: availableDates,
      notes: ['観測データがまだありません'],
    };
  }

  const referenceTime = new Date(snapshot.observed_at);
  const windows = {};
  for (const minutes of RATE_WINDOWS) {
    windows[`${minutes}m`] = rateOverWindow(day.intervals, referenceTime, minutes);
  }

  const notes = [];
  let rate = null;
  let rateSource = null;

  if (windows['60m'].rate_per_hour) {
    rate = windows['60m'].rate_per_hour;
    rateSource = '60m';
  } else if (windows['120m'].rate_per_hour) {
    rate = windows['120m'].rate_per_hour;
    rateSource = '120m';
    notes.push('直近60分に有効な観測がないため、直近120分の速度を使用しています');
  } else {
    const fallback = historyRate(stats, referenceTime);
    if (fallback) {
      rate = fallback.rate;
      rateSource = fallback.source;
      notes.push('当日の有効な観測が不足しているため、同じ時間帯の履歴平均を使用しています');
    }
  }

  const window60 = windows['60m'];
  const rateIsLowerBound = rateSource === '60m' && window60.censored_interval_count > 0;
  if (rateIsLowerBound) {
    notes.push('表示20件が全件消化された区間があるため、実際の速度はこれ以上の可能性があります');
  }
  if (snapshot.waitings_truncated) {
    notes.push('APIは待機列の先頭20件のみを返すため、消化数は観測できた範囲の値です');
  }
  if (snapshot.pendings_count > 0) {
    notes.push('保留(pending)の扱いが未確定のため、待ち時間の計算には含めていません');
  }

  let estimatedWaitMinutes = null;
  if (snapshot.waitings_count === 0) estimatedWaitMinutes = 0;
  else if (rate && rate > 0) estimatedWaitMinutes = Math.round((snapshot.waitings_count / rate) * 60);

  const { weekday, hour } = jstParts(referenceTime);
  const historyBucket = stats.weekday_hours.find(
    (entry) => entry.weekday === weekday && entry.hour === hour,
  );

  return {
    schema_version: DERIVED_SCHEMA_VERSION,
    location_id: location.id,
    location_name: location.name,
    generated_at: generatedAt,
    observed_at: snapshot.observed_at,
    business_date: day.business_date,
    waitings_count: snapshot.waitings_count,
    pendings_count: snapshot.pendings_count,
    waitings_truncated: snapshot.waitings_truncated ?? null,
    head_number: snapshot.waitings?.[0]?.number ?? snapshot.head_number ?? null,
    queue_exit_rate_20m: windows['20m'].rate_per_hour,
    queue_exit_rate_60m: windows['60m'].rate_per_hour,
    queue_exit_rate_120m: windows['120m'].rate_per_hour,
    queue_exit_rate_used: rate,
    rate_source: rateSource,
    rate_is_lower_bound: rateIsLowerBound,
    rate_windows: windows,
    estimated_wait_minutes: estimatedWaitMinutes,
    estimate_confidence: rateSource ? confidenceFor(rateSource, windows[rateSource] ?? window60) : null,
    history: historyBucket
      ? {
          weekday,
          hour,
          rate_per_hour: historyBucket.rate_per_hour,
          median_waitings_count: historyBucket.median_waitings_count,
          interval_count: historyBucket.interval_count,
        }
      : null,
    available_dates: availableDates,
    notes,
  };
}

/** 生データから derived 配下を再生成する。 */
export async function regenerateDerived(location, { allDays = null } = {}) {
  const days = allDays ?? (await loadAllDays(location));
  const dir = derivedDir(location);
  const availableDates = days.map((day) => day.business_date);
  const written = [];

  for (const day of days) {
    const result = await writeJsonIfChanged(
      path.join(dir, `${day.business_date}.json`),
      buildDayFile(location, day),
    );
    if (result.written) written.push(result.file);
  }

  const stats = buildStats(location, days);
  const statsResult = await writeJsonIfChanged(path.join(dir, 'stats.json'), stats);
  if (statsResult.written) written.push(statsResult.file);

  // 「過去平均との差」には当日を含めない。
  const historyStats = buildStats(location, days.slice(0, -1));
  const latest = buildLatest(
    location,
    days[days.length - 1] ?? null,
    historyStats,
    availableDates,
  );
  const latestResult = await writeJsonIfChanged(path.join(dir, 'latest.json'), latest);
  if (latestResult.written) written.push(latestResult.file);

  return { days: days.length, latest, stats, written };
}
