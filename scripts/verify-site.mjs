#!/usr/bin/env node
// 公開中のサイトを渡されたスナップショットと照合する読み取り専用の検査。認証情報は使わない。
// 再生成はしない。SNAPSHOT は build_archive.py と build_recent.py を通した deploy 時点の状態を渡す。
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { stageAssets } from './stage-static-assets.mjs';

const EXCLUDED = ['/scripts/stage-static-assets.mjs', '/scripts/build_archive.py', '/prompts/daily-article.md',
  '/wrangler.jsonc', '/CLAUDE.md', '/README.md', '/topics.md', '/docs/SETUP.md', '/.git/config',
  '/.github/workflows/daily-article.yml', '/__migration_missing__', '/archive/__migration_missing__.html'];
const MEDIA = {
  '.html': ['text/html'],
  '.css': ['text/css'],
  '.json': ['application/json'],
  '.xml': ['application/atom+xml', 'application/xml', 'text/xml'],
  '.png': ['image/png'],
  '.ico': ['image/x-icon', 'image/vnd.microsoft.icon'],
};
const DATED_ARTICLE = /^(\d{4}-\d{2}-\d{2})(?:-(\d+))?\.html$/;
const canonical = file => file === 'index.html' ? '/' : file.endsWith('/index.html')
  ? `/${file.slice(0, -10)}` : `/${file.replace(/\.html$/, '')}`;

// 同日おかわりの YYYY-MM-DD-2.html は文字列順だと YYYY-MM-DD.html より前に並ぶ。
function latestArticle(names) {
  const ranked = names.flatMap(name => {
    const match = name.match(DATED_ARTICLE);
    return match ? [{ name, date: match[1], serial: Number(match[2] ?? 1) }] : [];
  }).sort((a, b) => a.date === b.date ? a.serial - b.serial : a.date < b.date ? -1 : 1);
  if (!ranked.length) throw Error('No dated article in archive');
  return `archive/${ranked.at(-1).name}`;
}

export async function verifySite(source, origin, { log = console.log } = {}) {
  const base = new URL(origin);
  if (base.username || base.password || base.pathname !== '/' || base.search || base.hash ||
      (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)))) {
    throw Error('Expected an HTTPS origin (HTTP allowed only for loopback preview)');
  }
  const temp = await mkdtemp(path.join(tmpdir(), 'verify-site-'));
  try {
    const staged = path.join(temp, 'public');
    const stats = await stageAssets(source, staged);
    const files = ['index.html', 'style.css', 'feed.xml', 'favicon.ico', 'icon-192.png', 'apple-touch-icon.png',
      'archive/index.html', latestArticle(await readdir(path.join(staged, 'archive'))), 'data/articles.json'];
    async function get(route) {
      let url = new URL(route, base);
      const signal = AbortSignal.timeout(10000);
      for (let redirects = 0; redirects <= 3; redirects++) {
        const response = await fetch(url, { method: 'GET', redirect: 'manual', signal });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          await response.body?.cancel();
          if (!location) throw Error(`${route}: redirect without Location`);
          const next = new URL(location, url);
          if (next.origin !== base.origin || next.username || next.password) throw Error(`${route}: cross-origin redirect`);
          url = next;
          continue;
        }
        // 不正な host が巨大なレスポンスを流しても読み切らないように上限を置く。
        const chunks = []; let size = 0;
        for await (const chunk of response.body ?? []) {
          size += chunk.length;
          if (size > 25 * 1024 * 1024) throw Error(`${route}: response exceeds asset size limit`);
          chunks.push(chunk);
        }
        return { status: response.status, type: response.headers.get('content-type')?.split(';')[0].trim(),
          url, body: Buffer.concat(chunks) };
      }
      throw Error(`${route}: too many redirects`);
    }
    let checked = 0;
    for (const file of files) {
      const route = file === 'index.html' ? '/' : file === 'archive/index.html' ? '/archive/' : `/${file}`;
      const response = await get(route);
      if (response.status !== 200 || response.url.pathname !== canonical(file) || response.url.search || response.url.hash) {
        throw Error(`${route}: expected 200 at ${canonical(file)}, got ${response.status} at ${response.url.pathname}`);
      }
      if (!MEDIA[path.extname(file)].includes(response.type)) throw Error(`${route}: incorrect media type ${response.type}`);
      if (!response.body.equals(await readFile(path.join(staged, file)))) throw Error(`${route}: bytes differ from snapshot`);
      log(`PASS ${route}: canonical path, media type and source bytes`); checked++;
    }
    for (const route of EXCLUDED) {
      const response = await get(route);
      if (response.status !== 404) throw Error(`${route}: expected 404, got ${response.status}`);
      log(`PASS ${route}: 404`); checked++;
    }
    return { checked, staged: stats, origin: base.origin };
  } finally { await rm(temp, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const [source, origin, ...extra] = process.argv.slice(2);
  if (!source || !origin || extra.length) {
    console.error('usage: node scripts/verify-site.mjs REBUILT_SNAPSHOT HTTPS_ORIGIN'); process.exitCode = 1;
  } else {
    verifySite(source, origin).then(result => console.log(JSON.stringify(result))).catch(error => {
      console.error(`Site verification failed: ${error.message}`); process.exitCode = 1;
    });
  }
}
