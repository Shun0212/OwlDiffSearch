const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const styles = fs.readFileSync(path.join(__dirname, '..', 'media', 'styles.css'), 'utf8');
const script = fs.readFileSync(path.join(__dirname, '..', 'media', 'main.js'), 'utf8');
const htmlBuilder = fs.readFileSync(path.join(__dirname, '..', 'src', 'webviewHtml.ts'), 'utf8');
const modelBackend = fs.readFileSync(path.join(__dirname, '..', 'model_server', 'model.py'), 'utf8');

function declarationBlock(selector) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = styles.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `${selector} declaration block is missing`);
  return match[1];
}

test('anchors the absolutely positioned commit graph SVG to its row layout', () => {
  const layout = declarationBlock('.commit-graph-layout');
  const svg = declarationBlock('.commit-graph-svg');

  assert.match(layout, /(?:^|;)\s*position\s*:\s*relative\s*;/);
  assert.match(svg, /(?:^|;)\s*pointer-events\s*:\s*none\s*;/);
  assert.match(script, /svg\.style\.position\s*=\s*['"]absolute['"]/);
});

test('loads the commit graph through the end of local history', () => {
  assert.match(script, /offset:\s*append \? commitGraphData\.length : 0/);
  assert.match(script, /distanceFromBottom <= 64/);
  assert.match(script, /End of local history/);
  assert.match(script, /Load older commits/);
  assert.match(htmlBuilder, /Scroll for older commits/);
});

test('renders determinate embedding progress from the start of the track', () => {
  const determinate = declarationBlock('.owl-progress-bar.determinate');
  const active = declarationBlock('.owl-progress-bar.determinate.active::after');
  const indeterminateAnimation = styles.match(/@keyframes owl-progress-slide\s*\{([\s\S]*?)\n\}/);

  assert.match(determinate, /(?:^|;)\s*left\s*:\s*0\s*;/);
  assert.match(active, /animation\s*:\s*owl-progress-shimmer/);
  assert.ok(indeterminateAnimation, 'indeterminate progress animation is missing');
  assert.match(indeterminateAnimation[1], /translateX\(-110%\)/);
  assert.match(indeterminateAnimation[1], /translateX\(300%\)/);
  assert.match(script, /role="progressbar"/);
  assert.match(script, /setAttribute\('aria-valuenow'/);
  assert.match(script, /setAttribute\('aria-valuetext'/);
  assert.match(script, /status\.dataset\.view !== 'index-progress'/);
  assert.match(script, /progressBar\.style\.width = `\$\{percent\}%`/);
  assert.match(script, /!\/\^Loading\\b\/i\.test\(progressPhase\)/);
  assert.match(modelBackend, /progress\.start\("Loading embedding model"/);
  assert.match(script, /Server stopped before embedding completed/);
});

test('keeps the standalone UI English-first with hunk and commit diff units', () => {
  assert.match(htmlBuilder, /<html lang="en">/);
  assert.match(htmlBuilder, /placeholder="Describe the change to find"/);
  assert.doesNotMatch(htmlBuilder, /data-value="functions"/);
  assert.match(htmlBuilder, /data-value="diff_hunks">Hunks</);
  assert.match(htmlBuilder, /data-value="diff_commits">Commits</);
  assert.match(script, /searchTarget:\s*byId\('searchTargetSelect'\).*'diff_hunks'/);
  assert.match(htmlBuilder, />Detected languages</);
  assert.doesNotMatch(htmlBuilder, /<select id="languageSelect"/);
  assert.match(script, /lang:\s*'auto'/);
  assert.match(htmlBuilder, />Target filters</);
  assert.match(htmlBuilder, /id="includePatternsInput"/);
  assert.match(htmlBuilder, /id="excludePatternsInput"/);
  assert.match(script, /includePatterns:/);
  assert.match(script, /excludePatterns:/);
});

test('keeps result cards compact without inline diff bodies', () => {
  assert.match(script, /result-rank\$\{index < 3 \? ' rank-top' : ''\}/);
  assert.match(script, /<span class="score-badge"[^>]*>\$\{score\}%<\/span>/);
  assert.doesNotMatch(script, /renderDiffSnippet/);
  assert.doesNotMatch(script, /class="result-snippet/);
  assert.doesNotMatch(script, /Semantic \$\{semantic\}/);
  assert.doesNotMatch(script, /BM25 \$\{bm25\}/);
  assert.doesNotMatch(script, /class="result-meta"/);
});

test('uses distinct filled actions for opening diffs and commits', () => {
  assert.match(script, /className = 'diff-action-btn open-diff-action'/);
  assert.match(script, /className = 'diff-action-btn open-commit-action'/);
  assert.match(declarationBlock('.open-diff-action'), /background\s*:\s*var\(--vscode-button-background/);
  assert.match(declarationBlock('.open-commit-action'), /background\s*:\s*var\(--vscode-statusBarItem-remoteBackground/);
});
