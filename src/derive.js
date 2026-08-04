/**
 * 連続する2つのスナップショットから「列がどれだけ進んだか」を求める。
 *
 * 受付番号の引き算は使わない。番号には欠番・キャンセル・優先呼出・別種別が混ざるため、
 * 同一番号の存在・消滅・状態遷移だけを追跡する。
 */

import { round, sum } from './util.js';

/** 想定観測間隔(20分)に対する許容範囲。外れた区間は速度計算に使わない。 */
export const MIN_INTERVAL_SECONDS = 60;
export const MAX_INTERVAL_SECONDS = 3600;

/**
 * 前回の待機列の先頭から何件が列を離れたかを求める。
 * 前回見えていた番号が今回すべて消えている場合は「少なくともN件」という下限しか分からない。
 */
export function calculateQueueAdvance(previous, current) {
  if (!previous.length) {
    return { advance: 0, censored: false };
  }
  const currentNumbers = new Set(current.map((entry) => entry.number));
  const firstSurvivorIndex = previous.findIndex((entry) => currentNumbers.has(entry.number));

  if (firstSurvivorIndex === -1) {
    return { advance: previous.length, censored: true };
  }
  return { advance: firstSurvivorIndex, censored: false };
}

/**
 * 前回waitingsにいた番号が今回どこにいるかを分類する。
 * waitings配列はAPI側で先頭20件程度に切られるため、列の並び替えが起きると
 * unknown_exits が過大に出る可能性がある。主指標は queue_advance 側。
 */
export function classifyTransitions(previousWaitings, currentWaitings, currentPendings) {
  const currentWaitingNumbers = new Set(currentWaitings.map((entry) => entry.number));
  const currentPendingNumbers = new Set(currentPendings.map((entry) => entry.number));

  const stillWaiting = [];
  const movedToPending = [];
  const unknownExits = [];

  for (const entry of previousWaitings) {
    if (currentWaitingNumbers.has(entry.number)) stillWaiting.push(entry.number);
    else if (currentPendingNumbers.has(entry.number)) movedToPending.push(entry.number);
    else unknownExits.push(entry.number);
  }

  return { stillWaiting, movedToPending, unknownExits };
}

/**
 * 受付番号のリセット(日付またぎ・受付開始時のリセット)検出。
 * 今回の最大番号が前回の最小番号を下回っていれば、番号体系が巻き戻ったと判断する。
 */
export function detectNumberReset(previousWaitings, currentWaitings) {
  if (!previousWaitings.length || !currentWaitings.length) return false;
  const previousMin = Math.min(...previousWaitings.map((entry) => entry.number));
  const currentMax = Math.max(...currentWaitings.map((entry) => entry.number));
  return currentMax < previousMin;
}

/**
 * 区間を速度計算に使えない理由を列挙する。空配列なら採用可。
 */
export function intervalExclusions(previous, current, durationSeconds) {
  const reasons = [];

  if (previous.business_date !== current.business_date) reasons.push('business_date_change');
  if (detectNumberReset(previous.waitings, current.waitings)) reasons.push('number_reset');
  if (durationSeconds < MIN_INTERVAL_SECONDS) reasons.push('interval_too_short');
  if (durationSeconds > MAX_INTERVAL_SECONDS) reasons.push('observation_gap');

  // 待機列が空だった時間を「速度0」として扱わない。処理する利用者がいなかっただけ。
  if (previous.waitings_count === 0 && current.waitings_count === 0) reasons.push('queue_empty');
  else if (previous.waitings_count === 0) reasons.push('queue_empty_at_start');
  else if (current.waitings_count === 0) reasons.push('queue_emptied');

  return reasons;
}

export function buildInterval(previous, current) {
  const start = new Date(previous.observed_at);
  const end = new Date(current.observed_at);
  const durationSeconds = Math.round((end.getTime() - start.getTime()) / 1000);

  const { advance, censored } = calculateQueueAdvance(previous.waitings, current.waitings);
  const { stillWaiting, movedToPending, unknownExits } = classifyTransitions(
    previous.waitings,
    current.waitings,
    current.pendings,
  );

  const exclusions = intervalExclusions(previous, current, durationSeconds);
  // 打ち切り区間は「下限値」しか分からないため速度の平均には混ぜない。
  const rateEligible = exclusions.length === 0 && !censored;
  const ratePerHour = durationSeconds > 0 ? advance / (durationSeconds / 3600) : null;

  return {
    interval_start: previous.observed_at,
    interval_end: current.observed_at,
    duration_seconds: durationSeconds,
    waiting_count_before: previous.waitings_count,
    waiting_count_after: current.waitings_count,
    pending_count_before: previous.pendings_count,
    pending_count_after: current.pendings_count,
    queue_advance_observed: advance,
    queue_exits_observed: movedToPending.length + unknownExits.length,
    moved_to_pending: movedToPending.length,
    unknown_exits: unknownExits.length,
    still_waiting: stillWaiting.length,
    queue_exit_rate_per_hour: round(ratePerHour),
    censored,
    rate_eligible: rateEligible,
    exclusion_reasons: exclusions,
  };
}

export function buildIntervals(snapshots) {
  const ordered = [...snapshots].sort(
    (a, b) => new Date(a.observed_at).getTime() - new Date(b.observed_at).getTime(),
  );
  const intervals = [];
  for (let i = 1; i < ordered.length; i += 1) {
    intervals.push(buildInterval(ordered[i - 1], ordered[i]));
  }
  return intervals;
}

/**
 * 直近windowMinutes分の区間をまとめて列消化速度を求める。
 * 1区間ごとの速度はばらつきが大きいので、合計消化数 ÷ 合計観測時間で算出する。
 */
export function rateOverWindow(intervals, referenceTime, windowMinutes) {
  const windowStartMs = referenceTime.getTime() - windowMinutes * 60_000;
  const inWindow = intervals.filter(
    (interval) => new Date(interval.interval_end).getTime() > windowStartMs,
  );
  const used = inWindow.filter((interval) => interval.rate_eligible);
  const censoredCount = inWindow.filter((interval) => interval.censored).length;

  if (!used.length) {
    return {
      window_minutes: windowMinutes,
      rate_per_hour: null,
      interval_count: 0,
      censored_interval_count: censoredCount,
      advance_total: 0,
      duration_seconds: 0,
    };
  }

  const advanceTotal = sum(used.map((interval) => interval.queue_advance_observed));
  const durationSeconds = sum(used.map((interval) => interval.duration_seconds));

  return {
    window_minutes: windowMinutes,
    rate_per_hour: round(advanceTotal / (durationSeconds / 3600)),
    interval_count: used.length,
    censored_interval_count: censoredCount,
    advance_total: advanceTotal,
    duration_seconds: durationSeconds,
  };
}
