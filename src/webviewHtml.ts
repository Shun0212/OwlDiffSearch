import { GEMINI_MODELS } from './queryExpansion';

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
  <title>OwlDiffSearch</title>
  <link rel="stylesheet" href="${options.styleUri}">
</head>
<body class="diff-only">
  <header class="header diff-header">
    <div class="brand">
      <img src="${options.owlPngUri}" alt="" class="brand-icon">
      <div>
        <div class="brand-title">OwlDiffSearch</div>
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
    <div class="search-unit-toolbar">
      <span class="search-unit-label">Find</span>
      <div class="segmented-control" data-select="searchTargetSelect" role="group" aria-label="Search unit">
        <button type="button" class="segment-btn active" data-value="diff_hunks">Hunks</button>
        <button type="button" class="segment-btn" data-value="diff_commits">Commits</button>
        <button type="button" class="segment-btn" data-value="diff_branches">Branches</button>
      </div>
      <select id="searchTargetSelect" class="hidden-select" aria-hidden="true" tabindex="-1">
        <option value="diff_hunks" selected>Unified diff hunks</option>
        <option value="diff_commits">Commits scored by best file diff</option>
        <option value="diff_branches">Branches ranked by matching changes</option>
      </select>
    </div>
    <section id="branchSearchOptions" class="branch-search-options" aria-label="Branch search scope" hidden>
      <label for="branchBaseRefSelect">Changes not in</label>
      <select id="branchBaseRefSelect" aria-describedby="branchSearchHint">
        <option value="">Auto (main / default branch)</option>
      </select>
      <div class="filter-note" id="branchSearchHint">Find branches by their changes outside this base. Searches all local and fetched remote branches, including merged-in commits.</div>
      <div class="branch-search-summary" id="branchSearchSummary" aria-live="polite"></div>
    </section>
    <div class="searchbar diff-searchbar">
      <input id="searchInput" type="text" autocomplete="off" placeholder="Describe the change to find" aria-label="Diff search query">
      <button id="searchBtn">Search</button>
    </div>

    <section class="diff-control-card" aria-label="Diff search options">
      <details class="option-panel search-settings-panel" id="searchSettingsPanel">
        <summary>
          <span>Settings</span>
          <span class="option-summary settings-state-summary" id="settingsStateSummary">
            <span class="settings-branch-name" id="settingsBranchName">All branches</span>
            <span aria-hidden="true"> · </span>
            <span id="settingsToggleSummary">No docs on · JA→EN off</span>
          </span>
        </summary>
        <div class="search-settings-body">
          <section class="settings-group search-behavior-settings" aria-labelledby="searchBehaviorHeading">
            <div class="settings-group-heading" id="searchBehaviorHeading">Search behavior</div>
            <div class="option-row compact-row">
              <span>Detected code languages</span>
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
          </section>

          <section class="settings-group target-filter-body" aria-labelledby="targetFilterHeading">
            <div class="settings-group-heading" id="targetFilterHeading">
              <span>Target filters</span>
              <span class="option-summary" id="targetFilterSummary">No docs</span>
            </div>
            <label>
              <span>Include</span>
              <input id="includePatternsInput" type="text" spellcheck="false" placeholder="src/**, .py">
            </label>
            <label>
              <span>Exclude</span>
              <input id="excludePatternsInput" type="text" spellcheck="false" placeholder="tests/**, docs/**">
            </label>
            <label class="target-filter-toggle">
              <input type="checkbox" id="excludeDocumentationToggle" checked>
              <span>Exclude documentation files</span>
            </label>
            <div class="filter-note">Excludes Markdown, reStructuredText, AsciiDoc, Org, and common extensionless documentation files. Dependency manifests remain searchable.</div>
            <div class="filter-note">Comma-separated repository paths or globs. Leave blank to search all text-file diffs.</div>
          </section>

          <section class="settings-group range-settings-body" aria-labelledby="rangeSettingsHeading">
            <div class="settings-group-heading" id="rangeSettingsHeading">
              <span>Compare range</span>
              <span class="option-summary" id="rangeSummary">Latest 100 commits → HEAD</span>
            </div>
            <div id="diffRangeBar" class="diff-range-bar" aria-label="Active diff range">
              <span class="diff-range-bar-label">Active range</span>
              <span id="activeBaseRef" class="active-range-ref active-range-base">Latest 100 commits</span>
              <span class="active-range-arrow" aria-hidden="true">→</span>
              <span id="activeHeadRef" class="active-range-ref active-range-head">HEAD</span>
            </div>
            <label class="commit-branch-picker">
              <span class="commit-branch-picker-label">When From is blank</span>
              <select id="blankRangeModeSelect">
                <option value="recent" selected>Latest 100 commits</option>
                <option value="working_tree">Working tree / manual range</option>
              </select>
            </label>
            <div class="range-editor" aria-label="Compare range endpoints">
              <div class="range-editor-heading">
                <span>Range endpoints</span>
                <span>From → To</span>
              </div>
              <label class="range-endpoint range-endpoint-base" for="diffBaseRefInput">
                <span class="range-endpoint-badge">FROM</span>
                <span class="range-endpoint-body">
                  <span class="range-endpoint-title">Start from</span>
                  <input id="diffBaseRefInput" type="text" spellcheck="false" placeholder="Latest 100 commits (default)" aria-describedby="baseEndpointHint">
                  <span class="range-endpoint-hint" id="baseEndpointHint">Click a commit below to set From</span>
                </span>
              </label>
              <div class="range-endpoint-connector" aria-hidden="true">
                <span>↓</span>
                <span>compare changes up to</span>
              </div>
              <label class="range-endpoint range-endpoint-head" for="diffHeadRefInput">
                <span class="range-endpoint-badge">TO</span>
                <span class="range-endpoint-body">
                  <span class="range-endpoint-title">End at</span>
                  <input id="diffHeadRefInput" type="text" spellcheck="false" placeholder="HEAD (default)" aria-describedby="headEndpointHint">
                  <span class="range-endpoint-hint" id="headEndpointHint">Shift+click a commit below to set To</span>
                </span>
              </label>
            </div>
            <div class="diff-actions">
              <button type="button" id="refreshDiffSearchBtn" class="secondary-action">Check for changes</button>
            </div>
            <div id="diffStatus" class="diff-status"></div>
          </section>

          <section class="settings-group history-settings-body" aria-labelledby="historySettingsHeading">
            <div class="settings-group-heading" id="historySettingsHeading">Commit history</div>
            <label class="commit-branch-picker">
              <span class="commit-branch-picker-label">Branch</span>
              <select id="commitBranchFilterSelect" aria-label="Branch shown in the commit tree and diff search">
                <option value="">All visible branches</option>
              </select>
            </label>
            <div class="history-settings-fields">
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
            </div>
            <div class="diff-actions">
              <button type="button" id="reloadCommitsBtn" class="secondary-action">Reload commits</button>
            </div>
            <div class="filter-note">Selecting a branch uses it as To for both the tree and search. Full history includes commits from merged branches. First parent keeps the branch's mainline and represents merged work at the merge commit.</div>
          </section>

          <section class="settings-group translation-body" aria-labelledby="translationSettingsHeading">
            <div class="settings-group-heading" id="translationSettingsHeading">
              <span>Gemini query preparation</span>
              <span class="option-summary" id="translationSummary">Off</span>
            </div>
            <label class="translation-toggle">
              <input type="checkbox" id="translateToggle">
              <span>Translate JP → EN with Gemini</span>
            </label>
            <label class="translation-toggle">
              <input type="checkbox" id="queryExpansionToggle">
              <span>Expand query with Gemini</span>
            </label>
            <div class="translation-note">Generate an English search query suited to the search mode. Includes translation. Keyword search uses your original input.</div>
            <label class="translation-toggle">
              <input type="checkbox" id="agenticSearchToggle">
              <span>Agentic search with Gemini</span>
            </label>
            <div class="translation-note">Gemini can run search and keyword lookup tools itself, then inspect matching lines to verify results. Sends result titles, paths and diff excerpts to Gemini. Uses up to 3 searches by default; overrides the translation and expansion options above.</div>
            <select id="geminiModelSelect" title="Gemini query model">
              ${GEMINI_MODELS.map(model => `<option value="${model}">${model}</option>`).join('')}
            </select>
            <div class="translation-note">Set <code>owlDiffSearch.geminiApiKey</code> in VS Code Settings.</div>
          </section>
        </div>
      </details>

      <div class="history-browser" aria-label="Commit history">
        <div class="commit-graph-wrap">
          <div class="commit-graph-toolbar">
            <span class="commit-graph-hint">Click = From · Shift+Click = To · Scroll for older commits</span>
            <span class="commit-range-legend" id="commitRangeLegend" hidden></span>
          </div>
          <div class="commit-graph" id="commitGraph">
            <div class="commit-graph-empty">Loading commits…</div>
          </div>
        </div>
      </div>
    </section>

    <div class="status-row" aria-live="polite">
      <div class="status" id="status" aria-busy="false"></div>
      <button id="cancelEmbeddingBtn" class="secondary-action compact-action" type="button" hidden>Cancel</button>
    </div>
    <div id="translatedQuery" class="translated-query" hidden></div>
    <details id="agentTrace" class="translated-query" hidden open>
      <summary>Agentic search</summary>
      <div id="agentTraceContent" aria-live="polite"></div>
    </details>

    <div id="resultSortControls" class="result-sort-controls" hidden>
      <label for="resultSortSelect">Sort results</label>
      <select id="resultSortSelect">
        <option value="relevance">Relevance (Gemini)</option>
        <option value="retrieval">Search ranking</option>
      </select>
    </div>
    <div class="results" id="results">
      <div class="empty-state" id="emptyState">
        <img src="${options.owlPngUri}" alt="" class="empty-owl">
        <div class="empty-title">Ready to search the diff</div>
        <div class="empty-hint">Search the latest 100 commits by default.<br>Choose From / To in Settings to search a different range.</div>
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
