import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createSite, expectedPublicTree, assertRebuiltFromArticles, repoRoot, dangerousConfigs } from './deploy-fixture.mjs';

const SCRIPT = 'deploy-workers-preview.sh';
const MAIN = { GITHUB_REF: 'refs/heads/main' };
const reviewed = JSON.parse(readFileSync(path.join(repoRoot, 'wrangler.jsonc'), 'utf8'));

for (const [label, env] of [['other branch', { GITHUB_REF: 'refs/heads/kaionn/x' }], ['tag', { GITHUB_REF: 'refs/tags/main' }], ['unset ref', {}]]) {
  test(`${label}: rejected before fetch or upload`, t => {
    const site = createSite(t);
    const before = site.originMainSeenByCaller();
    site.publishArticle('2026-11-03.html', 'Third article');
    const result = site.run(SCRIPT, env);
    assert.notEqual(result.status, 0);
    assert.equal(site.originMainSeenByCaller(), before);
    assert.deepEqual(site.calls(), []);
  });
}

test('main: latest snapshot goes to the preview Worker only, rebuilt, with name and workers_dev rewritten', t => {
  const site = createSite(t);
  const sha = site.publishArticle('2026-11-03.html', 'Third article');
  const result = site.run(SCRIPT, MAIN);
  assert.equal(result.status, 0, result.stderr);

  const calls = site.calls();
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.deepEqual(call.argv.filter(arg => !arg.includes(path.sep)), ['--yes', 'wrangler@4', 'deploy', '--config', '--message', `preview main ${sha}`]);
  assert.deepEqual(call.config, { ...reviewed, name: 'tech-learning-daily-site-preview', workers_dev: true });
  assert.deepEqual(call.tree, expectedPublicTree(site.articleFiles()));
  assertRebuiltFromArticles(call, ['First article', 'Second article', 'Third article'], '2026-11-02.html');
});

for (const target of ['bogus', 'pages', '']) {
  test(`SITE_DEPLOY_TARGET=${JSON.stringify(target)} has no effect on the preview`, t => {
    const site = createSite(t);
    const result = site.run(SCRIPT, { ...MAIN, SITE_DEPLOY_TARGET: target });
    assert.equal(result.status, 0, result.stderr);
    const [call] = site.calls();
    assert.equal(call.config.name, 'tech-learning-daily-site-preview');
    assert.ok(!call.argv.includes('pages'));
  });
}

test('upload failure propagates and nothing else is attempted', t => {
  const site = createSite(t);
  const result = site.run(SCRIPT, { ...MAIN, FAKE_NPX_EXIT: '17' });
  assert.equal(result.status, 17);
  assert.equal(site.calls().length, 1);
});

test('rebuild failure stops before upload', t => {
  const site = createSite(t);
  site.commit({ 'data/articles.json': '{ not json' });
  assert.notEqual(site.run(SCRIPT, MAIN).status, 0);
  assert.deepEqual(site.calls(), []);
});

for (const [label, change] of Object.entries(dangerousConfigs)) {
  test(`config with ${label}: rejected before upload`, t => {
    const site = createSite(t);
    site.commit({ 'wrangler.jsonc': JSON.stringify({ ...reviewed, ...change }) });
    const result = site.run(SCRIPT, MAIN);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /reviewed assets-only/);
    assert.deepEqual(site.calls(), []);
  });
}

test('unparseable config: rejected before upload', t => {
  const site = createSite(t);
  site.commit({ 'wrangler.jsonc': '{ // comment\n}' });
  assert.notEqual(site.run(SCRIPT, MAIN).status, 0);
  assert.deepEqual(site.calls(), []);
});
