import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildInterval,
  buildIntervals,
  calculateQueueAdvance,
  classifyTransitions,
  detectNumberReset,
  intervalExclusions,
  rateOverWindow,
} from '../src/derive.js';
import { normalizeSnapshot } from '../src/snapshot.js';
import { businessDate, toJstIso } from '../src/util.js';

const location = { id: 'test-location', name: 'テスト拠点', path: 'test/location' };

function entries(numbers, status = 4) {
  return numbers.map((number) => ({ number, status }));
}

/** observed_at を指定してスナップショットを組み立てるテスト用ヘルパー。 */
function snapshot({ observedAt, waitings, pendings = [], waitingsCount, pendingsCount }) {
  const date = new Date(observedAt);
  const payload = {
    waitings: entries(waitings),
    pendings: entries(pendings, 5),
    waitingscount: waitingsCount ?? waitings.length,
    pendingscount: pendingsCount ?? pendings.length,
  };
  return normalizeSnapshot(location, payload, date);
}

describe('calculateQueueAdvance', () => {
  it('前回配列で最初に生き残っている番号のインデックスを進捗とする', () => {
    const previous = entries([167, 175, 176, 177, 178]);
    const current = entries([177, 178, 179, 180]);
    assert.deepEqual(calculateQueueAdvance(previous, current), { advance: 3, censored: false });
  });

  it('番号の引き算では判定しない(欠番があっても組数で数える)', () => {
    // 167 -> 177 は差10だが、実際に消えたのは 167,175,176 の3組のみ。
    const previous = entries([167, 175, 176, 177, 178]);
    const current = entries([177, 178]);
    assert.equal(calculateQueueAdvance(previous, current).advance, 3);
  });

  it('前回の番号が全件消えた場合は下限値として打ち切りにする', () => {
    const previous = entries([1, 2, 3]);
    const current = entries([50, 51]);
    assert.deepEqual(calculateQueueAdvance(previous, current), { advance: 3, censored: true });
  });

  it('前回が空なら進捗0で打ち切りではない', () => {
    assert.deepEqual(calculateQueueAdvance([], entries([1])), { advance: 0, censored: false });
  });

  it('先頭が変わらなければ進捗0', () => {
    const previous = entries([167, 175, 176]);
    assert.deepEqual(calculateQueueAdvance(previous, previous), { advance: 0, censored: false });
  });
});

describe('classifyTransitions', () => {
  it('waitingsから消えた番号をpending移動と行方不明に分類する', () => {
    const previous = entries([167, 175, 176, 177]);
    const current = entries([177]);
    const pendings = entries([167, 175], 5);
    const result = classifyTransitions(previous, current, pendings);

    assert.deepEqual(result.stillWaiting, [177]);
    assert.deepEqual(result.movedToPending, [167, 175]);
    assert.deepEqual(result.unknownExits, [176]);
  });
});

describe('detectNumberReset', () => {
  it('番号が全体的に巻き戻ったらリセットと判定する', () => {
    assert.equal(detectNumberReset(entries([200, 201]), entries([1, 2])), true);
  });

  it('通常の進行ではリセットとしない', () => {
    assert.equal(detectNumberReset(entries([200, 201]), entries([201, 202])), false);
  });

  it('どちらかが空ならリセット判定できない', () => {
    assert.equal(detectNumberReset([], entries([1])), false);
  });
});

describe('intervalExclusions', () => {
  const base = snapshot({ observedAt: '2026-08-04T11:07:03+09:00', waitings: [10, 11] });

  it('通常の20分区間は除外理由なし', () => {
    const next = snapshot({ observedAt: '2026-08-04T11:27:04+09:00', waitings: [11, 12] });
    assert.deepEqual(intervalExclusions(base, next, 1201), []);
  });

  it('前後とも待ち0の区間は速度0として扱わない', () => {
    const empty = snapshot({ observedAt: '2026-08-04T08:00:00+09:00', waitings: [] });
    const stillEmpty = snapshot({ observedAt: '2026-08-04T08:20:00+09:00', waitings: [] });
    assert.deepEqual(intervalExclusions(empty, stillEmpty, 1200), ['queue_empty']);
  });

  it('待機列が空になった区間は除外する', () => {
    const emptied = snapshot({ observedAt: '2026-08-04T11:27:04+09:00', waitings: [] });
    assert.deepEqual(intervalExclusions(base, emptied, 1201), ['queue_emptied']);
  });

  it('観測が飛んだ長い区間は除外する', () => {
    const late = snapshot({ observedAt: '2026-08-04T13:30:00+09:00', waitings: [11, 12] });
    assert.deepEqual(intervalExclusions(base, late, 8577), ['observation_gap']);
  });

  it('営業日が変わる区間は除外する', () => {
    const nextDay = snapshot({ observedAt: '2026-08-05T09:00:00+09:00', waitings: [1, 2] });
    const reasons = intervalExclusions(base, nextDay, 1200);
    assert.ok(reasons.includes('business_date_change'));
    assert.ok(reasons.includes('number_reset'));
  });

  it('間隔が短すぎる区間は除外する', () => {
    const soon = snapshot({ observedAt: '2026-08-04T11:07:30+09:00', waitings: [10, 11] });
    assert.deepEqual(intervalExclusions(base, soon, 27), ['interval_too_short']);
  });
});

describe('buildInterval', () => {
  it('20分で3組進んだ区間を9組/時として記録する', () => {
    const previous = snapshot({
      observedAt: '2026-08-04T11:07:03+09:00',
      waitings: [167, 175, 176, 177, 178, 179],
      waitingsCount: 39,
      pendings: [161],
      pendingsCount: 7,
    });
    const current = snapshot({
      observedAt: '2026-08-04T11:27:03+09:00',
      waitings: [177, 178, 179, 180, 181],
      waitingsCount: 36,
      pendings: [161, 167, 175],
      pendingsCount: 8,
    });

    const interval = buildInterval(previous, current);

    assert.equal(interval.duration_seconds, 1200);
    assert.equal(interval.queue_advance_observed, 3);
    assert.equal(interval.queue_exits_observed, 3);
    assert.equal(interval.moved_to_pending, 2);
    assert.equal(interval.unknown_exits, 1);
    assert.equal(interval.still_waiting, 3);
    assert.equal(interval.queue_exit_rate_per_hour, 9);
    assert.equal(interval.censored, false);
    assert.equal(interval.rate_eligible, true);
    assert.deepEqual(interval.exclusion_reasons, []);
  });

  it('打ち切り区間は速度計算に使わない', () => {
    const previous = snapshot({
      observedAt: '2026-08-04T11:07:03+09:00',
      waitings: [101, 102, 103],
      waitingsCount: 30,
    });
    const current = snapshot({
      observedAt: '2026-08-04T11:27:03+09:00',
      waitings: [140, 141],
      waitingsCount: 25,
    });

    const interval = buildInterval(previous, current);
    assert.equal(interval.censored, true);
    assert.equal(interval.rate_eligible, false);
    assert.equal(interval.queue_advance_observed, 3);
  });
});

describe('rateOverWindow', () => {
  const intervals = buildIntervals([
    snapshot({ observedAt: '2026-08-04T10:00:00+09:00', waitings: [1, 2, 3, 4, 5, 6, 7, 8], waitingsCount: 20 }),
    snapshot({ observedAt: '2026-08-04T10:20:00+09:00', waitings: [2, 3, 4, 5, 6, 7, 8, 9], waitingsCount: 20 }),
    snapshot({ observedAt: '2026-08-04T10:40:00+09:00', waitings: [9, 10, 11, 12, 13, 14, 15], waitingsCount: 20 }),
    snapshot({ observedAt: '2026-08-04T11:00:00+09:00', waitings: [13, 14, 15, 16, 17], waitingsCount: 20 }),
  ]);

  it('区間ごとの速度を平均せず、合計消化数を合計観測時間で割る', () => {
    // 進捗は 1 + 7 + 4 = 12組、観測時間は60分。
    const result = rateOverWindow(intervals, new Date('2026-08-04T11:00:00+09:00'), 60);
    assert.equal(result.advance_total, 12);
    assert.equal(result.duration_seconds, 3600);
    assert.equal(result.rate_per_hour, 12);
    assert.equal(result.interval_count, 3);
  });

  it('直近20分だけなら最後の区間のみを使う', () => {
    const result = rateOverWindow(intervals, new Date('2026-08-04T11:00:00+09:00'), 20);
    assert.equal(result.interval_count, 1);
    assert.equal(result.rate_per_hour, 12);
  });

  it('有効な区間がなければnullを返す', () => {
    const result = rateOverWindow([], new Date('2026-08-04T11:00:00+09:00'), 60);
    assert.equal(result.rate_per_hour, null);
    assert.equal(result.interval_count, 0);
  });
});

describe('normalizeSnapshot', () => {
  it('API配列の順番をpositionとして保存し、番号順に並べ直さない', () => {
    const observedAt = new Date('2026-08-04T11:27:04+09:00');
    const result = normalizeSnapshot(
      location,
      {
        waitings: [
          { number: 180, status: 4, answer1: null, answer2: null },
          { number: 167, status: 8, answer1: 2, answer2: null },
        ],
        pendings: [],
        waitingscount: 36,
        pendingscount: 0,
      },
      observedAt,
    );

    assert.equal(result.observed_at, toJstIso(observedAt));
    assert.equal(result.business_date, businessDate(observedAt));
    assert.equal(result.waitings_count, 36);
    assert.equal(result.waitings_truncated, true);
    assert.deepEqual(result.waitings[0], { position: 0, number: 180, status: 4 });
    assert.deepEqual(result.waitings[1], { position: 1, number: 167, status: 8, answer1: 2 });
  });
});
