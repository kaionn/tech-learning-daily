// 実際の bare origin と、受け取った argv / cwd / tree を記録する偽 npx でデプロイスクリプトを動かす。
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const repoRoot = path.resolve(import.meta.dirname, '../..');
const reviewedAssets = JSON.parse(readFileSync(path.join(repoRoot, 'wrangler.jsonc'), 'utf8')).assets;
export const dangerousConfigs = {
  'worker script': { main: 'index.mjs' },
  routes: { routes: ['tech-learn.example/*'] },
  route: { route: 'tech-learn.example/*' },
  crons: { triggers: { crons: ['* * * * *'] } },
  vars: { vars: { KEY: 'value' } },
  'kv binding': { kv_namespaces: [{ binding: 'KV', id: 'x' }] },
  'durable object binding': { durable_objects: { bindings: [{ name: 'D', class_name: 'C' }] } },
  'renamed Worker': { name: 'tech-learning-daily-other' },
  'workers_dev on': { workers_dev: true },
  'preview_urls on': { preview_urls: true },
  'assets directory at repo root': { assets: { ...reviewedAssets, directory: '.' } },
  'assets directory at the snapshot': { assets: { ...reviewedAssets, directory: './snapshot' } },
  'SPA fallback': { assets: { ...reviewedAssets, not_found_handling: 'single-page-application' } },
  'assets binding': { assets: { ...reviewedAssets, binding: 'ASSETS' } },
};
const PUBLIC_ROOT_FILES = ['index.html', 'style.css', 'feed.xml', 'favicon.ico', 'icon-192.png', 'apple-touch-icon.png'];
const INTERNAL_FILES = ['prompts/daily-article.md', 'topics.md', 'CLAUDE.md', 'README.md', 'docs/SETUP.md',
  '.github/workflows/daily-article.yml', 'archive/notes.md', 'data/.private/token.json'];
const COPIED_FROM_REPO = ['wrangler.jsonc', 'scripts/stage-static-assets.mjs', 'scripts/workers-config.mjs','scripts/build_archive.py', 'scripts/build_recent.py'];
const WRANGLER_CONFIGS = ['wrangler.json', 'wrangler.jsonc', 'wrangler.toml'];

const FAKE_NPX = `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const argv = process.argv.slice(2);
const capture = process.env.FAKE_NPX_CAPTURE;
const dir = path.join(capture, String(fs.readdirSync(capture).length));
fs.mkdirSync(dir);
const configIndex = argv.indexOf('--config');
let config = null, uploaded;
if (configIndex >= 0) {
  const configPath = path.resolve(argv[configIndex + 1]);
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  uploaded = path.resolve(path.dirname(configPath), config.assets.directory);
} else {
  uploaded = argv[argv.indexOf('deploy') + 1];
}
fs.cpSync(uploaded, path.join(dir, 'tree'), { recursive: true });
const visibleConfigs = [];
for (let at = process.cwd(); ; at = path.dirname(at)) {
  for (const name of ${JSON.stringify(WRANGLER_CONFIGS)}) if (fs.existsSync(path.join(at, name))) visibleConfigs.push(path.join(at, name));
  if (at === path.dirname(at)) break;
}
fs.writeFileSync(path.join(dir, 'call.json'), JSON.stringify({ argv, cwd: process.cwd(), visibleConfigs, config }));
process.exit(Number(process.env.FAKE_NPX_EXIT || 0));
`;

const tree = (base, prefix = '') => readdirSync(path.join(base, prefix), { withFileTypes: true })
  .flatMap(e => e.isDirectory() ? tree(base, path.join(prefix, e.name)) : [path.join(prefix, e.name)]).sort();

const article = (file, title) => ({ file, date: file.slice(0, 10), title, summary: `${title} summary`, category: 'network', difficulty: '基礎', readTime: 5, terms: ['term'] });

export const expectedPublicTree = articleFiles => [...PUBLIC_ROOT_FILES, 'archive/index.html', ...articleFiles.map(file => `archive/${file}`), 'data/articles.json'].sort();

export function createSite(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'deploy-site-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bare = path.join(dir, 'origin.git'), producer = path.join(dir, 'producer'), caller = path.join(dir, 'caller');
  const bin = path.join(dir, 'bin'), capture = path.join(dir, 'capture');
  for (const p of [producer, bin, capture]) mkdirSync(p);
  writeFileSync(path.join(bin, 'npx'), FAKE_NPX, { mode: 0o755 });

  const baseEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  delete baseEnv.SITE_DEPLOY_TARGET;
  delete baseEnv.GITHUB_REF;
  const git = (cwd, ...args) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: baseEnv });
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const write = (name, text) => {
    mkdirSync(path.dirname(path.join(producer, name)), { recursive: true });
    writeFileSync(path.join(producer, name), text);
  };
  const articles = [article('2026-11-01.html', 'First article'), article('2026-11-02.html', 'Second article')];
  const writeArticles = () => write('data/articles.json', JSON.stringify(articles));

  const site = {
    caller,
    articleFiles: () => articles.map(a => a.file),
    commit(files, removed = []) {
      for (const [name, text] of Object.entries(files)) write(name, text);
      for (const name of removed) rmSync(path.join(producer, name));
      git(producer, 'add', '-A');
      git(producer, 'commit', '-m', 'change');
      git(producer, 'push', 'origin', 'main');
      return git(producer, 'rev-parse', 'HEAD');
    },
    publishArticle(file, title) {
      articles.push(article(file, title));
      writeArticles();
      return site.commit({ [`archive/${file}`]: `article ${title}` });
    },
    originMainSeenByCaller: () => git(caller, 'rev-parse', 'origin/main'),
    callerHead: () => git(caller, 'rev-parse', 'HEAD'),
    run(script, env = {}) {
      const result = spawnSync('bash', [path.join(repoRoot, 'scripts', script)], {
        cwd: caller, encoding: 'utf8',
        env: { ...baseEnv, PATH: `${bin}:${process.env.PATH}`, FAKE_NPX_CAPTURE: capture, ...env },
      });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    },
    calls: () => readdirSync(capture).sort((a, b) => a - b).map(name => {
      const treeDir = path.join(capture, name, 'tree');
      return {
        ...JSON.parse(readFileSync(path.join(capture, name, 'call.json'), 'utf8')),
        tree: tree(treeDir),
        read: file => readFileSync(path.join(treeDir, file), 'utf8'),
      };
    }),
  };

  git(dir, 'init', '--bare', '-b', 'main', bare);
  git(producer, 'init', '-b', 'main');
  git(producer, 'config', 'user.name', 'Test');
  git(producer, 'config', 'user.email', 'test@example.invalid');
  git(producer, 'remote', 'add', 'origin', bare);
  for (const name of COPIED_FROM_REPO) {
    mkdirSync(path.dirname(path.join(producer, name)), { recursive: true });
    cpSync(path.join(repoRoot, name), path.join(producer, name));
  }
  for (const name of PUBLIC_ROOT_FILES) write(name, `committed ${name}`);
  // コミット済みの一覧をわざと古くして、再生成の有無を観測できるようにする。
  write('index.html', '<html>\n    <!-- recent:start -->\n    STALE RECENT\n    <!-- recent:end -->\n\n    <footer></footer>\n</html>\n');
  write('archive/index.html', 'STALE ARCHIVE LIST');
  for (const a of articles) write(`archive/${a.file}`, `article ${a.title}`);
  writeArticles();
  for (const name of INTERNAL_FILES) write(name, 'internal, never public');
  git(producer, 'add', '-A');
  git(producer, 'commit', '-m', 'initial');
  git(producer, 'push', 'origin', 'main');
  git(dir, 'clone', '--branch', 'main', bare, caller);
  return site;
}

export function assertRebuiltFromArticles(call, titles, olderFile) {
  const list = call.read('archive/index.html');
  assert.doesNotMatch(list, /STALE ARCHIVE LIST/);
  for (const title of titles) assert.match(list, new RegExp(title));
  const index = call.read('index.html');
  assert.doesNotMatch(index, /STALE RECENT/);
  assert.match(index, new RegExp(`archive/${olderFile}`));
}
