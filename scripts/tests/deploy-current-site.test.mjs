import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createSite, expectedPublicTree, assertRebuiltFromArticles, repoRoot, dangerousConfigs } from './deploy-fixture.mjs';

const SCRIPT = 'deploy-current-site.sh';

for (const [label, env] of [['unset', {}], ['empty', { SITE_DEPLOY_TARGET: '' }], ['pages', { SITE_DEPLOY_TARGET: 'pages' }]]) {
  test(`target ${label}: Pages receives latest main with the rebuilt list and no Worker config in reach`, t => {
    const site = createSite(t);
    const sha = site.publishArticle('2026-11-03.html', 'Third article');
    const result = site.run(SCRIPT, env);
    assert.equal(result.status, 0, result.stderr);

    const calls = site.calls();
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.deepEqual(call.argv.slice(0, 4), ['--yes', 'wrangler@4', 'pages', 'deploy']);
    assert.deepEqual(call.argv.slice(5), ['--project-name=tech-learning-daily', '--branch=main', `--commit-hash=${sha}`, '--commit-message=change']);
    assert.deepEqual(call.visibleConfigs, []);
    assert.equal(call.config, null);
    assertRebuiltFromArticles(call, ['First article', 'Second article', 'Third article'], '2026-11-02.html');
    assert.equal(call.read('archive/2026-11-03.html'), 'article Third article');
    assert.ok(!call.tree.some(name => name.includes('__pycache__')), 'bytecode is not uploaded');
  });
}

test('target workers: Worker receives only the allowlist, rebuilt, with the reviewed config', t => {
  const site = createSite(t);
  const sha = site.publishArticle('2026-11-03.html', 'Third article');
  const result = site.run(SCRIPT, { SITE_DEPLOY_TARGET: 'workers' });
  assert.equal(result.status, 0, result.stderr);

  const calls = site.calls();
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.deepEqual(call.argv.filter(arg => !arg.includes(path.sep)), ['--yes', 'wrangler@4', 'deploy', '--config', '--message', `main ${sha}`]);
  assert.deepEqual(call.tree, expectedPublicTree(site.articleFiles()));
  assert.equal(call.config.name, 'tech-learning-daily-site');
  assert.equal(call.config.workers_dev, false);
  assert.equal(call.config.preview_urls, false);
  assert.deepEqual(call.config.assets, { directory: './public', html_handling: 'auto-trailing-slash', not_found_handling: 'none' });
  for (const forbidden of ['main', 'routes', 'triggers', 'vars', 'durable_objects', 'kv_namespaces']) assert.equal(call.config[forbidden], undefined);
  assertRebuiltFromArticles(call, ['First article', 'Second article', 'Third article'], '2026-11-02.html');
});

for (const target of ['worker', 'PAGES', 'cloudflare', ' pages']) {
  test(`unknown target ${JSON.stringify(target)}: nonzero before any fetch or upload`, t => {
    const site = createSite(t);
    const before = site.originMainSeenByCaller();
    const newest = site.publishArticle('2026-11-03.html', 'Third article');
    assert.notEqual(before, newest);
    const result = site.run(SCRIPT, { SITE_DEPLOY_TARGET: target });
    assert.notEqual(result.status, 0);
    assert.equal(site.originMainSeenByCaller(), before, 'caller did not fetch');
    assert.deepEqual(site.calls(), []);
  });
}

for (const target of ['pages', 'workers']) {
  test(`${target}: upload failure propagates and no other host is attempted`, t => {
    const site = createSite(t);
    const result = site.run(SCRIPT, { SITE_DEPLOY_TARGET: target, FAKE_NPX_EXIT: '17' });
    assert.equal(result.status, 17);
    assert.equal(site.calls().length, 1);
  });

  test(`${target}: old caller HEAD with local edits still deploys committed latest main`, t => {
    const site = createSite(t);
    const oldHead = site.callerHead();
    const sha = site.publishArticle('2026-11-03.html', 'Third article');
    writeFileSync(path.join(site.caller, 'style.css'), 'DIRTY CALLER FILE');
    writeFileSync(path.join(site.caller, 'data/untracked.json'), '{"untracked":true}');
    const result = site.run(SCRIPT, { SITE_DEPLOY_TARGET: target });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(site.callerHead(), oldHead);
    const [call] = site.calls();
    assert.ok(call.argv.join(' ').includes(sha));
    assert.equal(call.read('archive/2026-11-03.html'), 'article Third article');
    assert.equal(call.read('style.css'), 'committed style.css');
    assert.ok(!call.tree.includes('data/untracked.json'));
  });

  test(`${target}: rebuild failure stops before any upload`, t => {
    const site = createSite(t);
    site.commit({ 'data/articles.json': '{ not json' });
    const result = site.run(SCRIPT, { SITE_DEPLOY_TARGET: target });
    assert.notEqual(result.status, 0);
    assert.deepEqual(site.calls(), []);
  });
}

test('workers: a snapshot missing a required public file stops before upload', t => {
  const site = createSite(t);
  site.commit({}, ['favicon.ico']);
  const result = site.run(SCRIPT, { SITE_DEPLOY_TARGET: 'workers' });
  assert.notEqual(result.status, 0);
  assert.deepEqual(site.calls(), []);
});

for (const [label, change] of Object.entries(dangerousConfigs)) {
  test(`workers: config with ${label} is rejected before upload`, t => {
    const site = createSite(t);
    const reviewed = JSON.parse(readFileSync(path.join(repoRoot, 'wrangler.jsonc'), 'utf8'));
    site.commit({ 'wrangler.jsonc': JSON.stringify({ ...reviewed, ...change }) });
    const result = site.run(SCRIPT, { SITE_DEPLOY_TARGET: 'workers' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /reviewed assets-only/);
    assert.deepEqual(site.calls(), []);
  });
}

test('the checked-in wrangler.jsonc parses as plain JSON', () => {
  assert.equal(JSON.parse(readFileSync(path.join(repoRoot, 'wrangler.jsonc'), 'utf8')).name, 'tech-learning-daily-site');
});
