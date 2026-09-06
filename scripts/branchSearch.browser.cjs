// Optional browser smoke test: OWL_PLAYWRIGHT_MODULE may point to an existing installation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require(process.env.OWL_PLAYWRIGHT_MODULE || 'playwright');
const { buildDiffSearchWebviewHtml } = require('../out/webviewHtml.js');

const root = path.resolve(__dirname, '..');
const fixtureOutput = execFileSync(path.join(root, 'model_server/.venv/bin/python'), ['-B', '-c', `
import json
from tests.test_branch_search import BranchSearchTests
case = BranchSearchTests()
case.setUp()
try:
    result = case.search()
    print('FIXTURE:' + json.dumps(result))
finally:
    case.doCleanups()
`], { cwd: path.join(root, 'model_server'), encoding: 'utf8' });
const fixture = JSON.parse(fixtureOutput.split('\n').find((line) => line.startsWith('FIXTURE:')).slice(8));
const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'owl-branch-ui-'));

async function main() {
  let origin;
  const server = http.createServer((req, res) => {
    if (req.url === '/') {
      const html = buildDiffSearchWebviewHtml({
        cspSource: origin, nonce: 'branch-test', scriptUri: '/main.js', styleUri: '/styles.css',
        owlPngUri: '/owl.png', languages: ['.py'], sessionId: 'branch-test',
      }).replace('</head>', '<link rel="stylesheet" href="/theme.css"></head>');
      res.setHeader('Content-Type', 'text/html');
      res.end(html);
    } else if (req.url === '/theme.css') {
      res.setHeader('Content-Type', 'text/css');
      res.end(':root { --vscode-sideBar-background: #181818; --vscode-editor-background: #1f1f1f; --vscode-foreground: #ccc; --vscode-font-family: system-ui; font-size: 13px; }');
    } else {
      const file = { '/main.js': 'main.js', '/styles.css': 'styles.css', '/owl.png': 'owl.png' }[req.url];
      if (!file) { res.writeHead(404); res.end(); return; }
      res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'image/png');
      res.end(fs.readFileSync(path.join(root, 'media', file)));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ headless: true, channel: process.env.OWL_BROWSER_CHANNEL });
    const page = await browser.newPage({ viewport: { width: 360, height: 900 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(({ fixture }) => {
      let state;
      window.testMessages = [];
      window.acquireVsCodeApi = () => ({
        getState: () => state,
        setState: (value) => { state = value; },
        postMessage: (message) => {
          window.testMessages.push(message);
          let reply;
          if (message.command === 'getGitBranches') reply = {
            type: 'gitBranches', branches: [
              { name: 'main', ref: 'refs/heads/main', current: true },
              { name: 'feature/auth', ref: 'refs/heads/feature/auth' },
              { name: 'feature/cache', ref: 'refs/heads/feature/cache' },
            ],
          };
          if (message.command === 'search' && !window.testHoldSearch) reply = {
            type: 'results', results: fixture.results, meta: fixture, searchRequestId: message.searchRequestId,
          };
          if (message.command === 'checkServerStatus') reply = { type: 'serverStatus', online: true };
          if (reply) setTimeout(() => window.dispatchEvent(new MessageEvent('message', { data: reply })), 0);
        },
      });
    }, { fixture });
    await page.goto(origin);
    await page.getByRole('button', { name: 'Branches', exact: true }).click();
    assert.equal(await page.locator('#branchSearchOptions').isVisible(), true);
    assert.equal(await page.locator('.history-browser').isVisible(), false);
    await page.getByLabel('Changes not in', { exact: true }).selectOption('refs/heads/main');
    await page.getByRole('textbox', { name: 'Diff search query' }).fill('retry_authentication');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await page.locator('.branch-result').first().waitFor();
    assert.deepEqual(await page.locator('.branch-result .function-name').allTextContents(), ['feature/auth', 'feature/shared']);
    assert.deepEqual(await page.locator('.branch-result .score-badge').allTextContents(), ['Match', 'Match']);
    const request = await page.evaluate(() => window.testMessages.find((message) => message.command === 'search'));
    assert.equal(request.searchTarget, 'diff_branches');
    assert.equal(request.branchBaseRef, 'refs/heads/main');
    assert.equal(request.diffBaseRef, '');
    assert.match(await page.locator('#branchSearchSummary').innerText(), /3 branches.*main/);

    await page.locator('.branch-evidence-item').first().click();
    let opened = await page.evaluate(() => window.testMessages.filter((message) => message.command === 'openDiff').at(-1));
    assert.equal(opened.headRef, fixture.results[0].commit_hash);
    assert.equal(opened.baseRef, `${fixture.results[0].commit_hash}^`);
    assert.equal(opened.newPath, 'auth.py');
    await page.getByRole('button', { name: 'Open Best Diff' }).first().click();
    opened = await page.evaluate(() => window.testMessages.filter((message) => message.command === 'openDiff').at(-1));
    assert.equal(opened.headRef, fixture.results[0].commit_hash);

    for (const width of [280, 360, 520]) {
      await page.setViewportSize({ width, height: 900 });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      assert.equal(overflow, false, `horizontal overflow at ${width}px`);
      await page.screenshot({ path: path.join(artifacts, `branches-${width}.png`), fullPage: true });
    }
    await page.getByRole('button', { name: 'Commits', exact: true }).click();
    assert.equal(await page.locator('#branchSearchOptions').isVisible(), false);
    assert.equal(await page.locator('.history-browser').isVisible(), true);
    assert.equal(await page.locator('.result-item').count(), 0, 'Changing the search unit must clear old results');

    await page.getByRole('button', { name: 'Branches', exact: true }).click();
    await page.evaluate(() => { window.testHoldSearch = true; });
    const searchCount = () => page.evaluate(() => window.testMessages.filter((message) => message.command === 'search').length);
    const before = await searchCount();
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await page.getByRole('textbox', { name: 'Diff search query' }).press('Enter');
    await page.getByRole('textbox', { name: 'Diff search query' }).press('Enter');
    assert.equal(await searchCount(), before + 1, 'Repeated Enter must not send duplicate searches');
    assert.equal(await page.locator('#searchBtn').isEnabled(), false);
    const staleId = await page.evaluate(() => window.testMessages.filter((message) => message.command === 'search').at(-1).searchRequestId);
    await page.getByLabel('Changes not in', { exact: true }).selectOption('refs/heads/feature/cache');
    assert.equal(await page.locator('#searchBtn').isEnabled(), true);
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    const latestId = await page.evaluate(() => window.testMessages.filter((message) => message.command === 'search').at(-1).searchRequestId);
    assert.notEqual(staleId, latestId);
    await page.evaluate(({ staleId, fixture }) => {
      for (const payload of [
        { type: 'results', results: fixture.results, meta: fixture },
        { type: 'translatedQuery', original: 'old', translated: 'stale translation' },
        { type: 'status', message: 'old status' },
        { type: 'error', message: 'old error' },
      ]) window.dispatchEvent(new MessageEvent('message', { data: { ...payload, searchRequestId: staleId } }));
    }, { staleId, fixture });
    assert.equal(await page.locator('.result-item').count(), 0, 'Late results must not restore the old scope');
    assert.equal(await page.locator('#searchBtn').isEnabled(), false, 'Late errors must not end the new request');
    assert.equal(await page.locator('#translatedQuery').isVisible(), false);
    assert.doesNotMatch(await page.locator('#status').innerText(), /old error|old status/);
    await page.evaluate(({ latestId, fixture }) => {
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'results', searchRequestId: latestId, results: fixture.results.slice(0, 1),
        meta: { ...fixture, diff_embedding_cache_source: 'incremental', num_reused_embeddings: 2, num_new_embeddings: 1 },
      } }));
    }, { latestId, fixture });
    assert.equal(await page.locator('.result-item').count(), 1);
    assert.equal(await page.locator('#searchBtn').isEnabled(), true);
    assert.match(await page.locator('#status').innerText(), /2 reused \/ 1 new embeddings/);
    await page.getByRole('textbox', { name: 'Diff search query' }).fill('a different change');
    assert.equal(await page.locator('.result-item').count(), 0, 'Editing the query must invalidate results');

    await page.getByRole('button', { name: 'Commits', exact: true }).click();
    await page.locator('#searchSettingsPanel > summary').click();
    await page.getByRole('button', { name: 'Check for changes' }).click();
    const prepareId = await page.evaluate(() => window.testMessages.filter((message) => message.command === 'prepareDiffSearch').at(-1).prepareRequestId);
    assert.equal(await page.locator('#searchBtn').isEnabled(), false);
    await page.locator('#includePatternsInput').fill('src/**');
    await page.evaluate((prepareId) => {
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'diffPrepared', prepareRequestId: prepareId, data: { num_diff_units: 999 },
      } }));
    }, prepareId);
    assert.equal(await page.locator('#diffStatus').innerText(), '');
    assert.equal(await page.locator('#searchBtn').isEnabled(), true);
    await page.getByRole('button', { name: 'Check for changes' }).click();
    const currentPrepareId = await page.evaluate(() => window.testMessages.filter((message) => message.command === 'prepareDiffSearch').at(-1).prepareRequestId);
    await page.evaluate((prepareRequestId) => {
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'indexProgress', progress: { active: true, total: 10, current: 2, phase: 'Embedding' },
      } }));
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'diffPrepared', prepareRequestId, data: { num_diff_units: 10 },
      } }));
    }, currentPrepareId);
    assert.equal(await page.locator('#cancelEmbeddingBtn').isVisible(), false);
    assert.equal(await page.locator('#status').getAttribute('aria-busy'), 'false');
    assert.equal(await page.locator('#searchBtn').isEnabled(), true);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, duplicateSearchesPrevented: true, staleResponsesIgnored: true, incrementalCacheStatus: true, artifacts }));
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
