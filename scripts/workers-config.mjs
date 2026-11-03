#!/usr/bin/env node
// 本番とプレビューの両方で、レビュー済みの assets だけの形から外れた設定を upload 前に止める。
import { readFileSync, writeFileSync } from 'node:fs';

const PRODUCTION_NAME = 'tech-learning-daily-site';
const ALLOWED_KEYS = new Set(['$schema', 'name', 'compatibility_date', 'workers_dev', 'preview_urls', 'assets']);
const ASSETS = { directory: './public', html_handling: 'auto-trailing-slash', not_found_handling: 'none' };

const [source, output, mode, ...extra] = process.argv.slice(2);
if (!source || !output || extra.length || (mode !== undefined && mode !== '--preview')) {
  console.error('usage: workers-config.mjs SNAPSHOT_CONFIG OUTPUT [--preview]');
  process.exit(1);
}
const config = JSON.parse(readFileSync(source, 'utf8'));
if (Object.keys(config).some(key => !ALLOWED_KEYS.has(key)) || config.name !== PRODUCTION_NAME ||
    config.workers_dev !== false || config.preview_urls !== false ||
    JSON.stringify(config.assets) !== JSON.stringify(ASSETS)) {
  console.error('Workers deploy requires the reviewed assets-only configuration');
  process.exit(1);
}
if (mode === '--preview') {
  config.name = `${PRODUCTION_NAME}-preview`;
  config.workers_dev = true;
}
writeFileSync(output, JSON.stringify(config, null, 2) + '\n');
