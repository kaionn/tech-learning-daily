import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, truncateSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { stageAssets } from '../stage-static-assets.mjs';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const PUBLIC_FIXTURE = ['index.html', 'style.css', 'feed.xml', 'favicon.ico', 'icon-192.png', 'apple-touch-icon.png',
  'archive/index.html', 'archive/2026-11-02.html', 'archive/nested/page.html', 'data/articles.json'];
const write = (base, name, text = name) => {
  mkdirSync(path.dirname(path.join(base, name)), { recursive: true });
  writeFileSync(path.join(base, name), text);
};
const tree = (base, prefix = '') => readdirSync(path.join(base, prefix), { withFileTypes: true })
  .flatMap(e => e.isDirectory() ? tree(base, path.join(prefix, e.name)) : [path.join(prefix, e.name)]).sort();

function workspace(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'stage-assets-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source'), output = path.join(dir, 'public');
  for (const name of PUBLIC_FIXTURE) write(source, name);
  return { dir, source, output };
}

test('stages exactly the allowlist with identical bytes and leaves internal files out', async t => {
  const { source, output } = workspace(t);
  for (const name of ['scripts/build_archive.py', 'prompts/daily-article.md', 'wrangler.jsonc', 'CLAUDE.md', 'README.md',
    'topics.md', 'docs/SETUP.md', '.github/workflows/daily-article.yml', '.claude/state.json',
    'archive/.hidden/secret.html', 'archive/.hidden.html', 'data/.private/token.json', 'archive/notes.md', 'data/notes.txt',
    'archive/data.json', 'data/page.html']) write(source, name, 'must not publish');
  const stats = await stageAssets(source, output);
  assert.deepEqual(tree(output), [...PUBLIC_FIXTURE].sort());
  assert.equal(stats.files, PUBLIC_FIXTURE.length);
  for (const name of PUBLIC_FIXTURE) assert.deepEqual(readFileSync(path.join(output, name)), readFileSync(path.join(source, name)));
});

test('refuses to reuse an existing output so stale assets cannot survive', async t => {
  const { source, output } = workspace(t);
  write(output, 'stale.html');
  await assert.rejects(stageAssets(source, output), /EEXIST/);
  assert.deepEqual(tree(output), ['stale.html']);
});

test('refuses overlapping source and output trees', async t => {
  const { dir, source } = workspace(t);
  await assert.rejects(stageAssets(source, path.join(source, 'public')), /separate trees/);
  await assert.rejects(stageAssets(source, source), /separate trees/);
  await assert.rejects(stageAssets(source, dir), /separate trees/);
});

for (const [label, plant, error] of [
  ['symlink inside a public tree', s => symlinkSync(path.join(s, 'index.html'), path.join(s, 'data/escape.json')), /symlink/],
  ['symlinked root file', s => { rmSync(path.join(s, 'style.css')); symlinkSync(path.join(s, 'index.html'), path.join(s, 'style.css')); }, /not a regular file/],
  ['symlinked public tree', s => { rmSync(path.join(s, 'data'), { recursive: true }); mkdirSync(path.join(s, 'elsewhere')); symlinkSync(path.join(s, 'elsewhere'), path.join(s, 'data')); }, /not a real directory/],
  ['missing root file', s => rmSync(path.join(s, 'favicon.ico')), /ENOENT/],
  ['missing public tree', s => rmSync(path.join(s, 'archive'), { recursive: true }), /ENOENT/],
  ['root file over 25MiB', s => truncateSync(path.join(s, 'favicon.ico'), 25 * 1024 * 1024 + 1), /file size limit/],
  ['tree file over 25MiB', s => truncateSync(path.join(s, 'data/articles.json'), 25 * 1024 * 1024 + 1), /file size limit/],
]) {
  test(`fails closed without creating output: ${label}`, async t => {
    const { source, output } = workspace(t);
    plant(source);
    await assert.rejects(stageAssets(source, output), error);
    assert.equal(existsSync(output), false);
  });
}

test('a file of exactly 25MiB is still accepted', async t => {
  const { source, output } = workspace(t);
  truncateSync(path.join(source, 'favicon.ico'), 25 * 1024 * 1024);
  await stageAssets(source, output);
  assert.equal(existsSync(path.join(output, 'favicon.ico')), true);
});

test('more than 20000 public files fails before output exists', async t => {
  const { source, output } = workspace(t);
  for (let i = PUBLIC_FIXTURE.length; i <= 20000; i++) write(source, `data/extra-${i}.json`, '{}');
  await assert.rejects(stageAssets(source, output), /file count limit/);
  assert.equal(existsSync(output), false);
});

test('command line exits nonzero on a contract failure, also when reached through a symlink', t => {
  const { dir, source, output } = workspace(t);
  symlinkSync(path.join(repoRoot, 'scripts'), path.join(dir, 'linked-scripts'));
  const script = path.join(dir, 'linked-scripts/stage-static-assets.mjs');
  rmSync(path.join(source, 'index.html'));
  const failed = spawnSync('node', [script, source, output], { encoding: 'utf8' });
  assert.equal(failed.status, 1);
  write(source, 'index.html');
  const passed = spawnSync('node', [script, source, output], { encoding: 'utf8' });
  assert.equal(passed.status, 0, passed.stderr);
  assert.equal(JSON.parse(passed.stdout).files, PUBLIC_FIXTURE.length);
});

// 公開ルーティング（html_handling: auto-trailing-slash）で解決できるかを staged tree 上で判定する。
const SITE = 'https://tech-learn.kaion-lab.com';
function localLinks(html, pageRoute) {
  const markup = html.replace(/<(pre|code)\b[\s\S]*?<\/\1>/g, '');
  return [...markup.matchAll(/<[a-zA-Z][^>]*?\s(?:href|src)=["']([^"']*)["']/g)]
    .map(match => new URL(match[1], new URL(pageRoute, SITE)))
    .filter(url => url.origin === SITE);
}
function resolves(staged, url) {
  const relative = decodeURI(url.pathname).slice(1);
  const candidates = relative === '' || relative.endsWith('/') ? [`${relative}index.html`]
    : [relative, `${relative}.html`, `${relative}/index.html`];
  return candidates.some(candidate => existsSync(path.join(staged, candidate)));
}

test('the real repository stages, and local links of the published pages resolve to staged files', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'stage-real-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const staged = path.join(dir, 'public');
  await stageAssets(repoRoot, staged);
  assert.deepEqual(readdirSync(staged).sort(), ['apple-touch-icon.png', 'archive', 'data', 'favicon.ico', 'feed.xml', 'icon-192.png', 'index.html', 'style.css']);
  assert.ok(tree(staged).every(name => /^archive\/.*\.html$/.test(name) || /^data\/.*\.json$/.test(name) || !name.includes(path.sep)));

  const articles = JSON.parse(readFileSync(path.join(repoRoot, 'data/articles.json'), 'utf8'));
  const order = a => [a.date, Number(a.file.match(/-(\d+)\.html$/)?.[1] ?? 1)];
  const latest = [...articles].sort((a, b) => {
    const [dateA, nA] = order(a), [dateB, nB] = order(b);
    return dateA === dateB ? nA - nB : dateA < dateB ? -1 : 1;
  }).at(-1).file;

  for (const [file, route] of [['index.html', '/'], ['archive/index.html', '/archive/'], [`archive/${latest}`, `/archive/${latest.replace(/\.html$/, '')}`]]) {
    const links = localLinks(readFileSync(path.join(staged, file), 'utf8'), route);
    assert.ok(links.some(url => url.pathname === '/style.css'), `${file}: link extraction found the stylesheet`);
    const broken = links.filter(url => !resolves(staged, url)).map(url => url.pathname);
    assert.deepEqual(broken, [], `${file}: unresolved local links`);
  }
});
