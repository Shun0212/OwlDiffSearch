type WebviewHtmlOptions = {
	cspSource: string;
	nonce: string;
	scriptUri: string;
	styleUri: string;
	owlPngUri: string;
	languages: string[];
	sessionId: string;
};

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#039;');
}

export function buildDiffSearchWebviewHtml(options: WebviewHtmlOptions): string {
	const languageNames: Record<string, string> = {
		'.py': 'Python',
		'.java': 'Java',
		'.ts': 'TypeScript',
		'.tsx': 'TSX',
		'.js': 'JavaScript',
		'.jsx': 'JSX',
	};
	const detectedLanguageBadges = options.languages.length
		? options.languages
			.map((extension) => `<span class="detected-language">${escapeHtml(languageNames[extension] || extension)}</span>`)
			.join('')
		: '<span class="detected-language empty">None detected</span>';

	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${options.cspSource}; style-src ${options.cspSource}; script-src 'nonce-${options.nonce}';">
  <title>Owl Diff Search</title>
  <link rel="stylesheet" href="${options.styleUri}">
</head>
<body class="diff-only">
  <header class="header diff-header">
    <div class="brand">
      <img src="${options.owlPngUri}" alt="" class="brand-icon">
      <div>
        <div class="brand-title">Owl Diff Search</div>
        <div class="brand-subtitle">Search only what changed</div>
      </div>
    </div>
    <span class="server-status offline" id="serverStatus">
      <span class="status-dot"></span>
      <span id="serverStatusText">Offline</span>
    </span>
  </header>

  <div class="actions server-actions">
    <button id="setupAndStartBtn">Setup / Start</button>
    <button id="stopServerBtn" class="danger-action">Stop</button>
  </div>

  <main>
    <div class="searchbar diff-searchbar">
      <input id="searchInput" type="text" autocomplete="off" placeholder="Describe the change to find" aria-label="Diff search query">
      <button id="searchBtn">Search</button>
    </div>

    <div id="diffRangeBar" class="diff-range-bar" aria-label="Active diff range">
      <span class="diff-range-bar-label">Active range</span>
      <span id="activeBaseRef" class="active-range-ref active-range-base">HEAD</span>
      <span class="active-range-arrow" aria-hidden="true">→</span>
      <span id="activeHeadRef" class="active-range-ref active-range-head">working tree</span>
    </div>

    <section class="diff-control-card" aria-label="Diff search options">
      <div class="option-row compact-row">
        <span>Detected languages</span>
        <div class="detected-languages" id="detectedLanguages">${detectedLanguageBadges}</div>
      </div>

      <div class="option-row stacked-row">
        <span>Search mode</span>
        <div class="segmented-control" data-select="searchModeSelect" role="group" aria-label="Search mode">
          <button type="button" class="segment-btn active" data-value="semantic">Semantic</button>
          <button type="button" class="segment-btn" data-value="hybrid">Hybrid</button>
          <button type="button" class="segment-btn" data-value="bm25">BM25</button>
          <button type="button" class="segment-btn" data-value="keyword">Keyword</button>
        </div>
        <select id="searchModeSelect" class="hidden-select" aria-hidden="true" tabindex="-1">
          <option value="semantic" selected>Semantic</option>
          <option value="hybrid">Hybrid</option>
          <option value="bm25">BM25</option>
          <option value="keyword">Keyword</option>
        </select>
      </div>

      <div class="option-row stacked-row">
        <span>Search unit</span>
        <div class="segmented-control" data-select="searchTargetSelect" role="group" aria-label="Search unit">
          <button type="button" class="segment-btn active" data-value="diff_hunks">Hunks</button>
          <button type="button" class="segment-btn" data-value="diff_commits">Commits</button>
        </div>
        <select id="searchTargetSelect" class="hidden-select" aria-hidden="true" tabindex="-1">
          <option value="diff_hunks" selected>Unified diff hunks</option>
          <option value="diff_commits">Commits scored by best file diff</option>
        </select>
      </div>

      <details class="option-panel target-filter-panel" id="targetFilterPanel">
        <summary>
          <span>Target filters</span>
          <span class="option-summary" id="targetFilterSummary">All supported files</span>
        </summary>
        <div class="target-filter-body">
          <label>
            <span>Include</span>
            <input id="includePatternsInput" type="text" spellcheck="false" placeholder="src/**, .py">
          </label>
          <label>
            <span>Exclude</span>
            <input id="excludePatternsInput" type="text" spellcheck="false" placeholder="tests/**, docs/**">
          </label>
          <div class="filter-note">Comma-separated repository paths or globs. Leave blank to search all detected languages.</div>
        </div>
      </details>

      <details class="option-panel diff-range-panel" open>
        <summary>
          <span>Compare range</span>
          <span class="option-summary" id="rangeSummary">HEAD → working tree</span>
        </summary>
        <div class="diff-options">
          <div class="range-editor" aria-label="Compare range endpoints">
            <div class="range-editor-heading">
              <span>Range endpoints</span>
              <span>Base → Head</span>
            </div>
            <label class="range-endpoint range-endpoint-base" for="diffBaseRefInput">
              <span class="range-endpoint-badge">BASE</span>
              <span class="range-endpoint-body">
                <span class="range-endpoint-title">Start from</span>
                <input id="diffBaseRefInput" type="text" spellcheck="false" placeholder="HEAD (default)" aria-describedby="baseEndpointHint">
                <span class="range-endpoint-hint" id="baseEndpointHint">Click a commit below to set Base</span>
              </span>
            </label>
            <div class="range-endpoint-connector" aria-hidden="true">
              <span>↓</span>
              <span>compare changes up to</span>
            </div>
            <label class="range-endpoint range-endpoint-head" for="diffHeadRefInput">
              <span class="range-endpoint-badge">HEAD</span>
              <span class="range-endpoint-body">
                <span class="range-endpoint-title">End at</span>
                <input id="diffHeadRefInput" type="text" spellcheck="false" placeholder="Working tree (default)" aria-describedby="headEndpointHint">
                <span class="range-endpoint-hint" id="headEndpointHint">Shift+click a commit below to set Head</span>
              </span>
            </label>
          </div>
          <div class="diff-actions">
            <button type="button" id="refreshDiffSearchBtn" class="secondary-action">Check for changes</button>
            <button type="button" id="reloadCommitsBtn" class="secondary-action">Reload commits</button>
          </div>
          <div id="diffStatus" class="diff-status"></div>
          <label class="commit-branch-picker">
            <span class="commit-branch-picker-label">Branch</span>
            <select id="commitBranchFilterSelect" aria-label="Branch shown in the commit tree and diff search">
              <option value="">All visible branches</option>
            </select>
          </label>
          <details class="tree-filter-panel">
            <summary>
              <span>More tree options</span>
              <span class="option-summary" id="treeFilterSummary">Max 5 · full history</span>
            </summary>
            <div class="tree-filter-body">
              <label>
                <span>Max branches</span>
                <select id="commitBranchLimitSelect">
                  <option value="1">1</option>
                  <option value="3">3</option>
                  <option value="5" selected>5</option>
                  <option value="10">10</option>
                  <option value="20">20</option>
                  <option value="0">All</option>
                </select>
              </label>
              <label>
                <span>History</span>
                <select id="commitTraversalSelect">
                  <option value="full">Full history</option>
                  <option value="first_parent">First parent</option>
                </select>
              </label>
              <div class="filter-note">Selecting a branch uses it as Head for both the tree and search. Full history includes commits from merged branches. First parent keeps the branch's mainline and represents merged work at the merge commit.</div>
            </div>
          </details>
          <div class="commit-graph-wrap">
            <div class="commit-graph-toolbar">
              <span class="commit-graph-hint">Click = Base · Shift+Click = Head · Scroll for older commits</span>
            </div>
            <div class="commit-graph" id="commitGraph">
              <div class="commit-graph-empty">Loading commits…</div>
            </div>
          </div>
        </div>
      </details>

      <details class="option-panel translation-settings" id="translationPanel">
        <summary>
          <span>Japanese-to-English translation</span>
          <span class="option-summary" id="translationSummary">Off</span>
        </summary>
        <div class="translation-body">
          <label class="translation-toggle">
            <input type="checkbox" id="translateToggle">
            <span>Translate JP → EN with Gemini</span>
          </label>
          <select id="geminiModelSelect" title="Gemini translation model">
            <option value="gemini-3.5-flash">Gemini 3.5 Flash</option>
            <option value="gemini-3.1-flash-lite">Gemini 3.1 Flash-Lite</option>
            <option value="gemini-3.1-pro-preview">Gemini 3.1 Pro Preview</option>
          </select>
          <div class="translation-note">Set <code>owlDiffSearch.geminiApiKey</code> in VS Code Settings.</div>
        </div>
      </details>
    </section>

    <div class="status-row" aria-live="polite">
      <div class="status" id="status" aria-busy="false"></div>
      <button id="cancelEmbeddingBtn" class="secondary-action compact-action" type="button" hidden>Cancel</button>
    </div>
    <div id="translatedQuery" class="translated-query" hidden></div>

    <div class="results" id="results">
      <div class="empty-state" id="emptyState">
        <img src="${options.owlPngUri}" alt="" class="empty-owl">
        <div class="empty-title">Ready to search the diff</div>
        <div class="empty-hint">Blank refs compare HEAD with the working tree.<br>Choose commits above for branch or commit review.</div>
      </div>
    </div>
  </main>

  <script nonce="${options.nonce}">
    window.OWL_WEBVIEW_SESSION_ID = "${escapeHtml(options.sessionId)}";
  </script>
  <script nonce="${options.nonce}" src="${options.scriptUri}"></script>
</body>
</html>`;
}
