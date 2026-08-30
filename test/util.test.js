import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { jstParts, rawFileParts, toDate } from '../src/util.js';

describe('toDate', () => {
  it('Date はそのまま返す', () => {
    const date = new Date('2026-08-30T11:16:03+09:00');
    assert.equal(toDate(date), date);
  });

  it('ISO文字列を Date に変換する', () => {
    const date = toDate('2026-08-30T11:16:03+09:00');
    assert.ok(date instanceof Date);
    assert.equal(date.getTime(), new Date('2026-08-30T11:16:03+09:00').getTime());
  });

  it('YYYY-MM-DD は JST 暦日として扱う', () => {
    const date = toDate('2026-08-30');
    assert.ok(date instanceof Date);
    assert.equal(date.getTime(), new Date('2026-08-30T00:00:00+09:00').getTime());
  });
});

describe('jstParts / rawFileParts', () => {
  it('営業日文字列でも getTime せず JST の年月日を返す', () => {
    // regenerateIncrementalDerived は business_date 文字列を rawFilePath に渡す。
    assert.deepEqual(rawFileParts('2026-08-30'), { year: '2026', month: '08', day: '30' });
    assert.equal(jstParts('2026-08-30').year, 2026);
    assert.equal(jstParts('2026-08-30').month, 8);
    assert.equal(jstParts('2026-08-30').day, 30);
  });

  it('ISO文字列からも JST 部品を取り出す', () => {
    const parts = jstParts('2026-08-30T11:16:03+09:00');
    assert.equal(parts.year, 2026);
    assert.equal(parts.month, 8);
    assert.equal(parts.day, 30);
    assert.equal(parts.hour, 11);
    assert.equal(parts.minute, 16);
    assert.equal(parts.second, 3);
  });
});
