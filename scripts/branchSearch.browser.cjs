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
const graphFixture = [
  {
    hash: 'a'.repeat(40), short: 'aaaaaaa', parents: ['b'.repeat(40)],
    subject: 'Make authentication retries safe', author: 'Test Author', date: '2 days ago',
    refs: ['tag: release-1', 'origin/main', ...Array.from({ length: 20 }, (_, i) => `feature/very-long-branch-name-${i}`), 'HEAD -> main'],
  },
  {
    hash: 'b'.repeat(40), short: 'bbbbbbb', parents: ['c'.repeat(40)],
    subject: 'Add request validation', author: 'Test Author', date: '3 days ago',
    refs: ['feature/validation-with-a-very-long-name', 'origin/feature/validation-with-a-very-long-name'],
  },
  {
    hash: 'c'.repeat(40), short: 'ccccccc', parents: [],
    subject: 'Initial commit', author: 'Test Author', date: '4 days ago', refs: [],
  },
];

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
    await page.addInitScript(({ fixture, graphFixture }) => {
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
            type: 'results', results: window.testSearchResults || fixture.results, meta: fixture, searchRequestId: message.searchRequestId,
          };
          if (message.command === 'getGitCommits') reply = {
            type: 'gitCommits', commits: graphFixture, hasMore: false, requestId: message.requestId,
          };
          if (message.command === 'checkServerStatus') reply = { type: 'serverStatus', online: true };
          if (reply) setTimeout(() => window.dispatchEvent(new MessageEvent('message', { data: reply })), 0);
        },
      });
    }, { fixture, graphFixture });
    await page.goto(origin);
    assert.equal(await page.title(), 'OwlDiffSearch');
    assert.equal(await page.locator('.brand-title').innerText(), 'OwlDiffSearch');
    const currentRow = page.locator(`.commit-row[data-hash="${graphFixture[0].hash}"]`);
    const previousRow = page.locator(`.commit-row[data-hash="${graphFixture[1].hash}"]`);
    await currentRow.waitFor();
    assert.equal(await currentRow.locator('.commit-ref').count(), 1);
    assert.equal(await currentRow.locator('.commit-ref-label').innerText(), 'main');
    assert.equal(await currentRow.locator('.commit-ref-count').innerText(), '+22');
    assert.equal(await currentRow.locator('.commit-git-head').innerText(), 'Current');
    const allRefs = await currentRow.locator('.commit-ref').getAttribute('title');
    for (const ref of graphFixture[0].refs) assert.ok(allRefs.includes(ref.replace('HEAD -> ', '')));
    await previousRow.click();
    await currentRow.click({ modifiers: ['Shift'] });
    assert.equal(await previousRow.locator('.commit-badge-base').isVisible(), true);
    assert.equal(await currentRow.locator('.commit-badge-head').isVisible(), true);
    assert.equal(await previousRow.locator('.commit-badge-base').innerText(), 'From');
    assert.equal(await currentRow.locator('.commit-badge-head').innerText(), 'To');
    assert.equal(await currentRow.locator('.commit-git-head').isVisible(), true);
    for (const width of [280, 360, 520]) {
      await page.setViewportSize({ width, height: 900 });
      const layout = await currentRow.evaluate((row) => {
        const graph = document.getElementById('commitGraph');
        const rect = graph.getBoundingClientRect();
        const badges = ['.commit-git-head', '.commit-badge-head', '.commit-ref-count'].map((selector) => {
          const badge = row.querySelector(selector).getBoundingClientRect();
          return badge.width > 0 && badge.left >= rect.left && badge.right <= rect.right;
        });
        return { badges, overflow: graph.scrollWidth > graph.clientWidth, rowHeight: row.getBoundingClientRect().height };
      });
      assert.deepEqual(layout.badges, [true, true, true], `Current, To, and grouped refs must remain visible at ${width}px`);
      assert.equal(layout.overflow, false, `Commit refs must not cause horizontal scrolling at ${width}px`);
      assert.equal(layout.rowHeight, 34, 'Grouping must preserve graph alignment');
      await page.screenshot({ path: path.join(artifacts, `commit-refs-${width}.png`), fullPage: true });
    }
    // From and To may refer to the same commit; both endpoints and Current stay visible.
    await currentRow.click();
    assert.equal(await currentRow.locator('.commit-badge-base').isVisible(), true);
    await page.setViewportSize({ width: 280, height: 900 });
    assert.equal(await currentRow.locator('.commit-git-head').isVisible(), true);
    assert.equal(await currentRow.locator('.commit-badge-head').isVisible(), true);
    // Detached HEAD has no attached branch, but must still have its own marker.
    await page.evaluate((commits) => {
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'gitCommits', commits: [{ ...commits[0], refs: ['HEAD', 'tag: release-1'] }, ...commits.slice(1)], hasMore: false,
      } }));
    }, graphFixture);
    assert.match(await currentRow.locator('.commit-git-head').getAttribute('title'), /detached/);
    assert.equal(await currentRow.locator('.commit-ref-label').innerText(), 'tag: release-1');
    assert.equal(await currentRow.locator('.commit-ref-count').count(), 0);
    await page.evaluate((commits) => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'gitCommits', commits, hasMore: false } }));
    }, graphFixture);
    await currentRow.click();
    await currentRow.click({ modifiers: ['Shift'] });
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

    const commitResult = {
      ...fixture.results[0], symbol_kind: 'diff_commit', commit_subject: 'Update authentication and related files',
      scored_file_path: 'auth.py', commit_file_count: 2, commit_hunk_count: 2,
      commit_hunks: [
        { path: 'auth.py', file_path: '/repo/auth.py', diff_old_path: 'auth.py', diff_new_path: 'auth.py', is_representative: true },
        { path: 'tests/test_auth.py', file_path: '/repo/tests/test_auth.py', diff_old_path: 'tests/test_auth.py', diff_new_path: 'tests/test_auth.py' },
      ],
    };
    await page.evaluate((result) => { window.testSearchResults = [result]; }, commitResult);
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    const blueButton = page.getByRole('button', { name: 'Open Commit Diff', exact: true });
    await blueButton.click();
    const commitRequest = await page.evaluate(() => window.testMessages.at(-1));
    assert.equal(commitRequest.command, 'openCommitDiff');
    assert.equal(commitRequest.hash, commitResult.commit_hash);
    assert.equal(commitRequest.preferredFile, 'auth.py');
    await page.locator('.diff-commit-files > summary').click();
    await page.getByRole('button', { name: 'tests/test_auth.py', exact: true }).click();
    const fileRequest = await page.evaluate(() => window.testMessages.at(-1));
    assert.equal(fileRequest.command, 'openDiff', 'A file name must still open its individual diff');
    assert.equal(fileRequest.newPath, 'tests/test_auth.py');
    await page.getByRole('button', { name: 'Open Commit', exact: true }).click();
    assert.equal(await page.evaluate(() => window.testMessages.at(-1).command), 'openCommitRemote');
    await page.locator('.result-item .function-name').click();
    assert.equal(await page.evaluate(() => window.testMessages.at(-1).command), 'openCommitDiff');
    await page.setViewportSize({ width: 280, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: path.join(artifacts, 'commit-diff-button-280.png'), fullPage: true });
    await page.getByRole('button', { name: 'Hunks', exact: true }).click();
    await page.evaluate((result) => {
      window.testSearchResults = [{ ...result, symbol_kind: 'diff_hunk', commit_hunks: [] }];
    }, commitResult);
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await page.getByRole('button', { name: 'Open Diff', exact: true }).click();
    assert.equal(await page.evaluate(() => window.testMessages.at(-1).command), 'openDiff');
    await page.evaluate(() => { delete window.testSearchResults; });

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
    console.log(JSON.stringify({ ok: true, groupedCommitRefs: true, headVisible: true, branding: true, duplicateSearchesPrevented: true, staleResponsesIgnored: true, incrementalCacheStatus: true, artifacts }));
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
