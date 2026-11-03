import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { verifySite } from '../verify-site.mjs';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const LATEST = 'archive/2026-11-02-10.html';
const FILES = ['index.html', 'style.css', 'feed.xml', 'favicon.ico', 'icon-192.png', 'apple-touch-icon.png',
  'archive/index.html', 'archive/2026-11-01.html', 'archive/2026-11-02.html', 'archive/2026-11-02-2.html', LATEST,
  'data/articles.json'];
const EXCLUDED = ['/scripts/stage-static-assets.mjs', '/scripts/build_archive.py', '/prompts/daily-article.md',
  '/wrangler.jsonc', '/CLAUDE.md', '/README.md', '/topics.md', '/docs/SETUP.md', '/.git/config',
  '/.github/workflows/daily-article.yml', '/__migration_missing__', '/archive/__migration_missing__.html'];
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.xml': 'application/atom+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const quiet = { log: () => {} };
const reply = (status, type, body, headers = {}) => res => {
  res.writeHead(status, { ...(type ? { 'content-type': type } : {}), ...headers });
  res.end(body);
};

function listen(t, handler) {
  const server = createServer(handler);
  t.after(() => { server.closeAllConnections(); server.close(); });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

// auto-trailing-slash の正常な host を模す。overrides で route ごとに応答を差し替える。
async function site(t, overrides = {}, fallback) {
  const source = mkdtempSync(path.join(tmpdir(), 'verify-source-'));
  t.after(() => rmSync(source, { recursive: true, force: true }));
  const routes = new Map();
  for (const file of FILES) {
    mkdirSync(path.dirname(path.join(source, file)), { recursive: true });
    writeFileSync(path.join(source, file), `bytes of ${file}`);
    const ok = reply(200, TYPES[path.extname(file)], `bytes of ${file}`);
    if (file === 'index.html') routes.set('/', ok);
    else if (file === 'archive/index.html') routes.set('/archive/', ok);
    else if (file.endsWith('.html')) {
      const pretty = `/${file.replace(/\.html$/, '')}`;
      routes.set(pretty, ok);
      routes.set(`/${file}`, reply(308, null, undefined, { location: pretty }));
    } else routes.set(`/${file}`, ok);
  }
  const requests = [];
  const origin = await listen(t, (req, res) => {
    const { pathname } = new URL(req.url, 'http://x');
    requests.push(pathname);
    (overrides[pathname] ?? routes.get(pathname) ?? fallback ?? reply(404, 'text/plain', 'missing'))(res);
  });
  return { source, origin, requests };
}

test('a host matching the snapshot passes every sample and excluded path', async t => {
  const { source, origin, requests } = await site(t);
  const result = await verifySite(source, origin, quiet);
  assert.equal(result.checked, 9 + EXCLUDED.length);
  assert.equal(result.staged.files, FILES.length);
  for (const route of EXCLUDED) assert.ok(requests.includes(route), `${route} was requested`);
});

test('the sampled article is the latest by date and serial, not by string order', async t => {
  const { source, origin, requests } = await site(t);
  await verifySite(source, origin, quiet);
  assert.ok(requests.includes(`/${LATEST.replace(/\.html$/, '')}`));
  assert.ok(!requests.includes('/archive/2026-11-02'));
  assert.ok(!requests.includes('/archive/2026-11-02-2'));
});

for (const [route, file, types] of [
  ['/favicon.ico', 'favicon.ico', ['image/x-icon', 'image/vnd.microsoft.icon']],
  ['/feed.xml', 'feed.xml', ['application/atom+xml', 'application/xml', 'text/xml']],
]) {
  for (const type of types) {
    test(`${route} accepts ${type}`, async t => {
      const { source, origin } = await site(t, { [route]: reply(200, type, `bytes of ${file}`) });
      await verifySite(source, origin, quiet);
    });
  }
}

for (const route of ['/', '/archive/', '/style.css', '/feed.xml', '/favicon.ico', '/icon-192.png', '/apple-touch-icon.png', '/data/articles.json', `/${LATEST.replace(/\.html$/, '')}`]) {
  test(`stale bytes at ${route} are rejected`, async t => {
    const { source, origin } = await site(t, { [route]: reply(200, TYPES[path.extname(route)] ?? TYPES['.html'], 'stale') });
    await assert.rejects(verifySite(source, origin, quiet), /bytes differ/);
  });
}

for (const [route, file, type] of [
  ['/', 'index.html', 'text/plain'],
  ['/style.css', 'style.css', 'text/plain'],
  ['/feed.xml', 'feed.xml', 'text/html'],
  ['/favicon.ico', 'favicon.ico', 'image/png'],
  ['/icon-192.png', 'icon-192.png', 'image/jpeg'],
  ['/data/articles.json', 'data/articles.json', 'text/plain'],
]) {
  test(`wrong media ${type} at ${route} is rejected`, async t => {
    const { source, origin } = await site(t, { [route]: reply(200, type, `bytes of ${file}`) });
    await assert.rejects(verifySite(source, origin, quiet), /media type/);
  });
}

test('SPA-style fallback answering every unknown path with 200 root HTML is rejected', async t => {
  const { source, origin } = await site(t, {}, reply(200, TYPES['.html'], 'bytes of index.html'));
  await assert.rejects(verifySite(source, origin, quiet), /expected 404/);
});

for (const route of EXCLUDED) {
  test(`200 at excluded path ${route} is rejected`, async t => {
    const { source, origin } = await site(t, { [route]: reply(200, 'text/plain', 'internal') });
    await assert.rejects(verifySite(source, origin, quiet), /expected 404/);
  });
}

test('a missing sample is rejected', async t => {
  const { source, origin } = await site(t, { '/style.css': reply(404, 'text/plain', 'missing') });
  await assert.rejects(verifySite(source, origin, quiet), /expected 200/);
});

test('a dated page served without the canonical redirect is rejected', async t => {
  const { source, origin } = await site(t, { [`/${LATEST}`]: reply(200, TYPES['.html'], `bytes of ${LATEST}`) });
  await assert.rejects(verifySite(source, origin, quiet), /expected 200 at/);
});

test('cross-origin redirect is rejected without contacting the other origin', async t => {
  let otherHits = 0;
  const other = await listen(t, (req, res) => { otherHits++; res.end(); });
  const { source, origin } = await site(t, { '/': reply(302, null, undefined, { location: `${other}/` }) });
  await assert.rejects(verifySite(source, origin, quiet), /cross-origin/);
  assert.equal(otherHits, 0);
});

test('redirect loops and redirects without Location are rejected', async t => {
  const loop = await site(t, { '/': reply(302, null, undefined, { location: '/' }) });
  await assert.rejects(verifySite(loop.source, loop.origin, quiet), /too many redirects/);
  const bare = await site(t, { '/': reply(302, null, undefined) });
  await assert.rejects(verifySite(bare.source, bare.origin, quiet), /without Location/);
});

for (const origin of ['http://site.example', 'http://10.0.0.1', 'https://site.example/path', 'https://user:pass@site.example', 'https://site.example/?query', 'https://site.example/#hash']) {
  test(`unsafe origin ${origin} is rejected before any request`, async () => {
    await assert.rejects(verifySite('/unused', origin, quiet), /HTTPS origin/);
  });
}

test('connection failure is a failure, not a pass', async t => {
  const { source } = await site(t);
  await assert.rejects(verifySite(source, 'http://127.0.0.1:1', quiet));
});

test('a snapshot with no dated article is rejected', async t => {
  const { source, origin } = await site(t);
  for (const file of FILES.filter(file => /^archive\/\d/.test(file))) rmSync(path.join(source, file));
  await assert.rejects(verifySite(source, origin, quiet), /No dated article/);
});

test('command line reports pass and failure by exit code, also when reached through a symlink', async t => {
  const run = promisify(execFile);
  const dir = mkdtempSync(path.join(tmpdir(), 'verify-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  symlinkSync(path.join(repoRoot, 'scripts'), path.join(dir, 'linked-scripts'));
  const script = path.join(dir, 'linked-scripts/verify-site.mjs');

  const good = await site(t);
  const { stdout } = await run('node', [script, good.source, good.origin]);
  assert.match(stdout, /"checked":21/);

  const bad = await site(t, { '/': reply(200, TYPES['.html'], 'stale') });
  await assert.rejects(run('node', [script, bad.source, bad.origin]), error => error.code === 1);
  await assert.rejects(run('node', [script]), error => error.code === 1);
});
