/**
 * 生データを取得せず、既存の raw NDJSON から derived 配下だけを作り直す。
 * statusの解釈や速度計算の式を変更したときに使う。
 */

import { regenerateDerived } from './aggregate.js';
import { readLocations } from './storage.js';

const locations = await readLocations();

for (const location of locations) {
  const { days, written } = await regenerateDerived(location);
  console.log(`[rebuild] ${location.id} days=${days} updated=${written.length}`);
}
