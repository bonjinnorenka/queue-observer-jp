/**
 * data/ 配下のファイル入出力。
 * raw は追記のみ(再生成しない)、derived は毎回生データから作り直す。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { rawFileParts, toDate } from './util.js';

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));

export const ROOT_DIR = path.resolve(SRC_DIR, '..');
export const DATA_DIR = path.join(ROOT_DIR, 'data');
export const RAW_DIR = path.join(DATA_DIR, 'raw');
export const DERIVED_DIR = path.join(DATA_DIR, 'derived');
export const LOCATIONS_FILE = path.join(DATA_DIR, 'locations.json');
export const STATUS_FILE = path.join(DATA_DIR, 'status.json');

export async function readLocations() {
  const raw = await fs.readFile(LOCATIONS_FILE, 'utf8');
  const parsed = JSON.parse(raw);
  return parsed.locations;
}

export function rawFilePath(location, date) {
  const { year, month, day } = rawFileParts(date);
  return path.join(RAW_DIR, location.path, year, month, `${day}.ndjson`);
}

export function derivedDir(location) {
  return path.join(DERIVED_DIR, location.path);
}

export async function appendSnapshot(location, snapshot, date) {
  const file = rawFilePath(location, date);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${JSON.stringify(snapshot)}\n`, 'utf8');
  return file;
}

export async function readSnapshotFile(file) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const snapshots = [];
  for (const [index, line] of text.split('\n').entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      snapshots.push(JSON.parse(trimmed));
    } catch (error) {
      console.warn(`[warn] ${file}:${index + 1} を解析できませんでした: ${error.message}`);
    }
  }
  return snapshots.sort(
    (a, b) => new Date(a.observed_at).getTime() - new Date(b.observed_at).getTime(),
  );
}

export async function readSnapshotsForDate(location, date) {
  // 増分更新は business_date 文字列(YYYY-MM-DD)を渡す。パス計算は Date 前提。
  return readSnapshotFile(rawFilePath(location, toDate(date)));
}

/** 拠点配下の全rawファイルを日付昇順で列挙する。 */
export async function listRawFiles(location) {
  const base = path.join(RAW_DIR, location.path);
  const files = [];

  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.endsWith('.ndjson')) files.push(full);
    }
  }

  await walk(base);
  return files.sort();
}

export async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return file;
}

/**
 * 内容が実質的に変わっていなければ書き込まない。
 * generated_at だけが変わる過去日ファイルで無駄なコミットが発生するのを防ぐ。
 */
export async function writeJsonIfChanged(file, value, ignoreKeys = ['generated_at']) {
  const strip = (obj) => {
    if (!obj || typeof obj !== 'object') return obj;
    const copy = { ...obj };
    for (const key of ignoreKeys) delete copy[key];
    return copy;
  };
  const existing = await readJson(file);
  if (existing && JSON.stringify(strip(existing)) === JSON.stringify(strip(value))) {
    return { file, written: false };
  }
  await writeJson(file, value);
  return { file, written: true };
}

export async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}
