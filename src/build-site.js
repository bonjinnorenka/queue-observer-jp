/**
 * GitHub Pages にデプロイする静的ファイルを _site/ に組み立てる。
 * 公開するのは site/ 一式と、表示に必要な派生データのみ(rawは公開対象外)。
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { DATA_DIR, DERIVED_DIR, LOCATIONS_FILE, ROOT_DIR, STATUS_FILE } from './storage.js';

const OUT_DIR = path.join(ROOT_DIR, '_site');

async function copyIfExists(source, destination) {
  try {
    await fs.access(source);
  } catch {
    console.warn(`[skip] ${path.relative(ROOT_DIR, source)} が見つかりません`);
    return false;
  }
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.cp(source, destination, { recursive: true });
  return true;
}

await fs.rm(OUT_DIR, { recursive: true, force: true });
await fs.mkdir(OUT_DIR, { recursive: true });

await fs.cp(path.join(ROOT_DIR, 'site'), OUT_DIR, { recursive: true });
await copyIfExists(LOCATIONS_FILE, path.join(OUT_DIR, 'data', 'locations.json'));
await copyIfExists(STATUS_FILE, path.join(OUT_DIR, 'data', 'status.json'));
await copyIfExists(DERIVED_DIR, path.join(OUT_DIR, 'data', 'derived'));
await fs.writeFile(path.join(OUT_DIR, '.nojekyll'), '', 'utf8');

const files = await fs.readdir(OUT_DIR, { recursive: true });
console.log(
  `[site] ${path.relative(ROOT_DIR, OUT_DIR)} に ${files.length} エントリを出力しました (data: ${path.relative(ROOT_DIR, DATA_DIR)})`,
);
