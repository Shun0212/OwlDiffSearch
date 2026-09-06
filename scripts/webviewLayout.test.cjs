const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const styles = fs.readFileSync(path.join(__dirname, '..', 'media', 'styles.css'), 'utf8');
const script = fs.readFileSync(path.join(__dirname, '..', 'media', 'main.js'), 'utf8');
const htmlBuilder = fs.readFileSync(path.join(__dirname, '..', 'src', 'webviewHtml.ts'), 'utf8');
const extension = fs.readFileSync(path.join(__dirname, '..', 'src', 'extension.ts'), 'utf8');
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

test('filters the commit tree and diff search by branch and traversal', () => {
  assert.match(htmlBuilder, /class="commit-branch-picker"/);
  assert.doesNotMatch(htmlBuilder, />More tree options</);
  assert.match(htmlBuilder, /id="commitBranchFilterSelect"/);
  assert.match(htmlBuilder, /id="commitBranchLimitSelect"/);
  assert.match(htmlBuilder, /id="commitTraversalSelect"/);
  assert.match(htmlBuilder, />Full history<\/option>/);
  assert.match(htmlBuilder, />First parent<\/option>/);
  assert.doesNotMatch(htmlBuilder, /data-commit-view=/);
  assert.match(script, /branchFilter: commitBranchFilter/);
  assert.match(script, /maxBranches: commitBranchLimit/);
  assert.match(script, /branchRef: commitBranchFilter/);
  assert.match(script, /firstParent: commitTraversal === 'first_parent'/);
  assert.match(extension, /'getGitBranches'/);
  assert.match(extension, /'git',\s*\['for-each-ref'/);
  assert.match(extension, /\.\.\.\(firstParent \? \['--first-parent'\] : \[\]\)/);
  assert.match(extension, /parents: firstParent \? parentHashes\.slice\(0, 1\) : parentHashes/);
  assert.match(extension, /branch_ref: branchRef/);
  assert.match(extension, /first_parent: !!msg\.firstParent/);
});

test('keeps From and To available as explicit range endpoints in Settings', () => {
  assert.match(htmlBuilder, /id="activeBaseRef"/);
  assert.match(htmlBuilder, /id="activeHeadRef"/);
  assert.match(htmlBuilder, /class="range-endpoint range-endpoint-base"/);
  assert.match(htmlBuilder, /class="range-endpoint range-endpoint-head"/);
  assert.match(htmlBuilder, /class="range-endpoint-badge">FROM<\/span>/);
  assert.match(htmlBuilder, /class="range-endpoint-badge">TO<\/span>/);
  assert.match(script, /function effectiveRangeRefs\(\)/);
  assert.match(script, /headEndpoint\?\.classList\.toggle\('is-overridden'/);
  assert.match(declarationBlock('.diff-range-bar'), /grid-template-columns\s*:\s*minmax\(0, 1fr\) auto minmax\(0, 1fr\)/);
  assert.match(declarationBlock('.range-settings-body .range-endpoint'), /grid-template-columns\s*:\s*3\.6em minmax\(0, 1fr\)/);
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
  assert.match(htmlBuilder, />Detected code languages</);
  assert.doesNotMatch(htmlBuilder, /<select id="languageSelect"/);
  assert.match(script, /lang:\s*'auto'/);
  assert.match(htmlBuilder, />Target filters</);
  assert.match(htmlBuilder, />No docs</);
  assert.match(script, /'All text files'/);
  assert.match(htmlBuilder, /search all text-file diffs/);
  assert.match(htmlBuilder, /id="includePatternsInput"/);
  assert.match(htmlBuilder, /id="excludePatternsInput"/);
  assert.match(htmlBuilder, /id="excludeDocumentationToggle" checked/);
  assert.match(htmlBuilder, />Exclude documentation files</);
  assert.match(script, /includePatterns:/);
  assert.match(script, /excludePatterns:/);
  assert.match(script, /excludeDocumentation:/);
});

test('consolidates low-frequency controls behind one Settings item', () => {
  assert.match(htmlBuilder, /id="searchSettingsPanel"/);
  assert.match(htmlBuilder, />Settings</);
  assert.match(htmlBuilder, /id="settingsStateSummary"/);
  assert.match(htmlBuilder, /id="settingsBranchName">All branches</);
  assert.match(htmlBuilder, /id="settingsToggleSummary">No docs on · JA→EN off</);
  assert.match(htmlBuilder, />Target filters</);
  assert.match(htmlBuilder, />Compare range</);
  assert.match(htmlBuilder, />Japanese-to-English translation</);
  assert.doesNotMatch(htmlBuilder, /class="option-panel target-filter-panel"/);
  assert.doesNotMatch(htmlBuilder, /class="option-panel diff-range-panel"/);
  assert.doesNotMatch(htmlBuilder, /class="option-panel translation-settings"/);
  assert.match(script, /function updateSettingsStateSummary\(\)/);
  assert.match(script, /commitBranchFilter \|\| 'All branches'/);
  assert.match(script, /--settings-branch-color/);
  assert.equal((htmlBuilder.match(/<details class="option-panel/g) || []).length, 1);

  const settingsStart = htmlBuilder.indexOf('id="searchSettingsPanel"');
  const settingsEnd = htmlBuilder.indexOf('</details>', htmlBuilder.indexOf('id="searchSettingsPanel"'));
  const settingsState = htmlBuilder.indexOf('id="settingsStateSummary"');
  const detectedLanguages = htmlBuilder.indexOf('id="detectedLanguages"');
  const searchMode = htmlBuilder.indexOf('id="searchModeSelect"');
  const searchUnit = htmlBuilder.indexOf('id="searchTargetSelect"');
  const activeRange = htmlBuilder.indexOf('id="diffRangeBar"');
  const branchPicker = htmlBuilder.indexOf('class="commit-branch-picker"');
  const historyOptions = htmlBuilder.indexOf('id="commitBranchLimitSelect"');
  const commitGraph = htmlBuilder.indexOf('id="commitGraph"');
  [settingsState, detectedLanguages, searchMode, activeRange, branchPicker, historyOptions].forEach((position) => {
    assert.ok(position > settingsStart && position < settingsEnd, 'secondary controls should stay inside Settings');
  });
  assert.ok(searchUnit < settingsStart, 'search unit should be visible above Settings');
  assert.ok(commitGraph > settingsEnd, 'commit graph should remain visible outside Settings');
});

test('highlights the visible commit range across rows, nodes, and edges', () => {
  assert.match(htmlBuilder, /id="commitRangeLegend" hidden/);
  assert.match(script, /function resolveGraphRef\(ref, commits\)/);
  assert.match(script, /function computeRangeCommitHashes\(baseHash, headHash, commits\)/);
  assert.match(script, /classList\.toggle\('is-in-range', rangeHashes\.has\(hash\)\)/);
  assert.match(script, /parentHash === baseHash/);
  assert.match(script, /Target range · \$\{shortRef\(base\)\} → \$\{shortRef\(head\)\}/);
  assert.match(declarationBlock('.commit-row.is-in-range'), /background\s*:\s*rgba\(34, 176, 125, 0\.1\)/);
  assert.match(declarationBlock('.commit-graph-svg .commit-edge.is-in-range'), /stroke-width\s*:\s*3\.2/);
});

test('assigns stable colors to branch labels', () => {
  assert.match(script, /function branchColor\(value\)/);
  assert.match(script, /--commit-ref-color: \$\{branchColor\(label\)\}/);
  assert.match(declarationBlock('.commit-ref'), /color\s*:\s*var\(--commit-ref-color/);
  assert.match(declarationBlock('.settings-branch-name'), /--settings-branch-color/);
});

test('keeps result cards compact without inline diff bodies', () => {
  assert.match(script, /result-rank\$\{index < 3 \? ' rank-top' : ''\}/);
  assert.match(script, /<span class="score-badge"[^>]*>\$\{score\}<\/span>/);
  assert.doesNotMatch(script, /renderDiffSnippet/);
  assert.doesNotMatch(script, /class="result-snippet/);
  assert.doesNotMatch(script, /Semantic \$\{semantic\}/);
  assert.doesNotMatch(script, /BM25 \$\{bm25\}/);
  assert.doesNotMatch(script, /class="result-meta"/);
});

test('identifies the file diff that supplies a commit score', () => {
  assert.match(script, /result\.scored_file_path/);
  assert.match(script, /'Best match'/);
  assert.match(script, /entry\.is_representative/);
  assert.match(declarationBlock('.diff-commit-hunk-head.representative'), /background\s*:\s*rgba\(224, 162, 58, 0\.14\)/);
});

test('uses distinct filled actions for opening diffs and commits', () => {
  assert.match(script, /className = 'diff-action-btn open-diff-action'/);
  assert.match(script, /className = 'diff-action-btn open-commit-action'/);
  assert.match(declarationBlock('.open-diff-action'), /background\s*:\s*var\(--vscode-button-background/);
  assert.match(declarationBlock('.open-commit-action'), /background\s*:\s*var\(--vscode-statusBarItem-remoteBackground/);
});
