(function () {
  const vscode = acquireVsCodeApi();
  const sessionId = String(window.OWL_WEBVIEW_SESSION_ID || '');
  let currentResults = [];
  let currentResultsMeta = {};
  let currentFolderPath = '';
  let commitGraphData = [];
  let commitGraphHasMore = true;
  let commitGraphLoading = false;
  let commitGraphRequestId = 0;
  let commitGraphError = '';
  let gitBranches = [];
  let commitBranchFilter = '';
  let commitBranchLimit = 5;
  let commitTraversal = 'full';
  let translationRequestId = 0;
  let progressWasActive = false;
  let searchInFlight = false;
  let branchBaseRef = '';
  let searchSequence = 0;
  let activeSearchRequestId = null;
  let activePrepareRequestId = null;

  const byId = (id) => document.getElementById(id);

  function updateSearchAvailability() {
    const busy = searchInFlight || activePrepareRequestId !== null;
    if (byId('searchBtn')) byId('searchBtn').disabled = busy;
    if (byId('refreshDiffSearchBtn')) byId('refreshDiffSearchBtn').disabled = busy;
    if (byId('resultSortSelect')) byId('resultSortSelect').disabled = busy;
  }

  function invalidateSearch() {
    if (searchInFlight && activeSearchRequestId) vscode.postMessage({ command: 'cancelSearch', searchRequestId: activeSearchRequestId });
    activeSearchRequestId = null;
    activePrepareRequestId = null;
    searchInFlight = false;
    progressWasActive = false;
    currentResults = [];
    currentResultsMeta = {};
    if (byId('resultSortControls')) byId('resultSortControls').hidden = true;
    const results = byId('results');
    if (results) results.innerHTML = '<div class="empty-state" id="emptyState"><div class="empty-title">Search conditions changed</div><div class="empty-hint">Search again to see results for these conditions.</div></div>';
    if (byId('translatedQuery')) byId('translatedQuery').hidden = true;
    if (byId('agentTrace')) byId('agentTrace').hidden = true;
    if (byId('branchSearchSummary')) byId('branchSearchSummary').textContent = '';
    if (byId('diffStatus')) byId('diffStatus').textContent = '';
    setStatus('', false);
    updateSearchAvailability();
  }

  function isBranchSearch() {
    return byId('searchTargetSelect')?.value === 'diff_branches';
  }

  function updateSearchTargetUI() {
    const branches = isBranchSearch();
    document.body.classList.toggle('branch-search', branches);
    if (byId('branchSearchOptions')) byId('branchSearchOptions').hidden = !branches;
    const input = byId('searchInput');
    if (input) input.placeholder = branches ? 'Describe a change to find its branch' : 'Describe the change to find';
    const emptyTitle = byId('emptyState')?.querySelector('.empty-title');
    const emptyHint = byId('emptyState')?.querySelector('.empty-hint');
    if (emptyTitle) emptyTitle.textContent = branches ? 'Find the branch behind a change' : 'Ready to search the diff';
    if (emptyHint) emptyHint.textContent = branches
      ? 'Describe a change, then search to see matching branches and the commits behind them.'
      : 'Search the latest 100 commits by default. Choose From / To in Settings to search a different range.';
    updateSettingsStateSummary();
  }

  function renderBranchBaseOptions() {
    const select = byId('branchBaseRefSelect');
    if (!select) return;
    select.innerHTML = '<option value="">Auto (main / default branch)</option>';
    gitBranches.forEach((branch) => {
      const option = document.createElement('option');
      option.value = branch.ref;
      option.textContent = branch.name;
      select.appendChild(option);
    });
    if (branchBaseRef && !gitBranches.some((branch) => branch.ref === branchBaseRef)) {
      const option = document.createElement('option');
      option.value = branchBaseRef;
      option.textContent = `${branchBaseRef} (unavailable)`;
      select.appendChild(option);
    }
    select.value = branchBaseRef;
  }

  function updateBranchSearchSummary(meta) {
    const summary = byId('branchSearchSummary');
    if (summary && meta?.search_target === 'diff_branches') {
      summary.textContent = `${meta.num_diff_branches || 0} branches with changes not in ${meta.branch_base_ref || 'base'} · ${meta.num_branches_scanned || 0} checked`;
    }
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function shortRef(value) {
    const ref = String(value || '').trim();
    return /^[0-9a-f]{12,40}$/i.test(ref) ? ref.slice(0, 7) : ref;
  }

  function rangeText() {
    const { base, head } = effectiveRangeRefs();
    return `${base} → ${head}`;
  }

  function targetFilterText() {
    const includeCount = splitPatterns(byId('includePatternsInput')?.value).length;
    const excludeCount = splitPatterns(byId('excludePatternsInput')?.value).length;
    const parts = [];
    if (includeCount) parts.push(`Include ${includeCount}`);
    if (excludeCount) parts.push(`Exclude ${excludeCount}`);
    if (byId('excludeDocumentationToggle')?.checked) parts.push('No docs');
    return parts.length ? parts.join(' · ') : 'All text files';
  }

  function translationText() {
    const settings = translationSettings();
    if (!settings.enable && !settings.expand && !settings.agentic) return 'Off';
    const model = settings.model.replace(/^gemini-/, '');
    return `${settings.agentic ? 'Agentic' : settings.expand ? 'Expand' : 'JA→EN'} · ${model}`;
  }

  function updateSettingsStateSummary() {
    const summary = byId('settingsStateSummary');
    if (!summary) return;
    const branch = isBranchSearch() ? 'Find branches' : (commitBranchFilter || 'All branches');
    const noDocs = byId('excludeDocumentationToggle')?.checked ? 'on' : 'off';
    const translation = translationSettings().enable ? 'on' : 'off';
    const expansion = translationSettings().expand ? 'on' : 'off';
    const agentic = translationSettings().agentic ? ' · Agentic on' : '';
    const branchName = byId('settingsBranchName');
    const toggles = byId('settingsToggleSummary');
    const value = `${branch} · No docs ${noDocs} · JA→EN ${translation} · Expand ${expansion}${agentic}`;
    if (branchName) branchName.textContent = branch;
    if (toggles) toggles.textContent = `No docs ${noDocs} · JA→EN ${translation} · Expand ${expansion}${agentic}`;
    summary.style.setProperty('--settings-branch-color', branchColor(branch));
    summary.title = value;
  }

  function effectiveRangeRefs() {
    const baseInput = shortRef(byId('diffBaseRefInput')?.value || '');
    const headInput = shortRef(commitBranchFilter || byId('diffHeadRefInput')?.value || '');
    if (recentCommitLimit()) return { base: 'Latest 100 commits', head: headInput || 'HEAD' };
    return {
      base: baseInput || 'HEAD',
      head: headInput || (baseInput ? 'HEAD' : 'working tree'),
    };
  }

  function recentCommitLimit() {
    return !isBranchSearch() && byId('blankRangeModeSelect')?.value !== 'working_tree'
      && !byId('diffBaseRefInput')?.value.trim() ? 100 : 0;
  }

  function updateRange() {
    const { base, head } = effectiveRangeRefs();
    const value = rangeText();
    const activeBase = byId('activeBaseRef');
    const activeHead = byId('activeHeadRef');
    const summary = byId('rangeSummary');
    if (activeBase) activeBase.textContent = base;
    if (activeHead) {
      activeHead.textContent = head;
      activeHead.title = commitBranchFilter ? `Selected branch ${commitBranchFilter} is used as To` : '';
    }
    if (summary) summary.textContent = value;
    highlightCommitSelection();
  }

  function collectState() {
    return {
      sessionId,
      query: byId('searchInput')?.value || '',
      searchMode: byId('searchModeSelect')?.value || 'semantic',
      searchTarget: byId('searchTargetSelect')?.value || 'diff_hunks',
      includePatterns: byId('includePatternsInput')?.value || '',
      excludePatterns: byId('excludePatternsInput')?.value || '',
      excludeDocumentation: Boolean(byId('excludeDocumentationToggle')?.checked),
      diffBaseRef: byId('diffBaseRefInput')?.value || '',
      diffHeadRef: byId('diffHeadRefInput')?.value || '',
      blankRangeMode: byId('blankRangeModeSelect')?.value || 'recent',
      commitBranchFilter,
      commitBranchLimit,
      commitTraversal,
      branchBaseRef,
    };
  }

  function saveState() {
    const state = collectState();
    vscode.setState(state);
    vscode.postMessage({ command: 'persistState', state });
  }

  function restoreState(state) {
    if (!state || typeof state !== 'object') return;
    const fields = [
      ['searchInput', 'query'],
      ['searchModeSelect', 'searchMode'],
      ['searchTargetSelect', 'searchTarget'],
      ['includePatternsInput', 'includePatterns'],
      ['excludePatternsInput', 'excludePatterns'],
      ['diffBaseRefInput', 'diffBaseRef'],
      ['diffHeadRefInput', 'diffHeadRef'],
      ['blankRangeModeSelect', 'blankRangeMode'],
    ];
    fields.forEach(([id, key]) => {
      const element = byId(id);
      if (element && typeof state[key] === 'string') element.value = state[key];
    });
    if (typeof state.excludeDocumentation === 'boolean') {
      const toggle = byId('excludeDocumentationToggle');
      if (toggle) toggle.checked = state.excludeDocumentation;
    }
    if (typeof state.commitBranchFilter === 'string') commitBranchFilter = state.commitBranchFilter;
    if (typeof state.branchBaseRef === 'string') branchBaseRef = state.branchBaseRef;
    renderBranchBaseOptions();
    if ([0, 1, 3, 5, 10, 20].includes(state.commitBranchLimit)) commitBranchLimit = state.commitBranchLimit;
    if (state.commitTraversal === 'full' || state.commitTraversal === 'first_parent') {
      commitTraversal = state.commitTraversal;
    }
    syncSegmentedControls();
    updateSearchTargetUI();
    updateTreeFilterControls();
    updateTargetFilterSummary();
    updateRange();
    if (commitGraphData.length) renderCommitGraph(commitGraphData);
  }

  function splitPatterns(value) {
    return String(value || '').split(/[,\n]/).map((part) => part.trim()).filter(Boolean);
  }

  function updateTargetFilterSummary() {
    const summary = byId('targetFilterSummary');
    if (summary) summary.textContent = targetFilterText();
    updateSettingsStateSummary();
  }

  function setServerStatus(online, detail) {
    const status = byId('serverStatus');
    const text = byId('serverStatusText');
    status?.classList.toggle('online', Boolean(online));
    status?.classList.toggle('offline', !online);
    if (text) text.textContent = online ? `Online${detail ? ` (${detail})` : ''}` : 'Offline';
    if (!online && progressWasActive) {
      progressWasActive = false;
      searchInFlight = false;
      activeSearchRequestId = null;
      activePrepareRequestId = null;
      updateSearchAvailability();
      setStatus('Server stopped before embedding completed.', false);
    }
  }

  function setStatus(message, busy) {
    const status = byId('status');
    const cancel = byId('cancelEmbeddingBtn');
    if (status) {
      delete status.dataset.view;
      status.setAttribute('aria-busy', busy ? 'true' : 'false');
      status.innerHTML = busy
        ? `<span class="loading-spinner"></span><span class="loading-msg">${escapeHtml(message)}</span>`
        : escapeHtml(message);
    }
    if (cancel) cancel.hidden = !busy;
  }

  function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '';
    const rounded = Math.round(seconds);
    if (rounded < 60) return `${rounded}s`;
    return `${Math.floor(rounded / 60)}m${rounded % 60 ? `${rounded % 60}s` : ''}`;
  }

  function applyIndexProgress(progress) {
    if (!searchInFlight && activePrepareRequestId === null) return;
    const cancel = byId('cancelEmbeddingBtn');
    if (!progress?.active || !progress.total) {
      if (progressWasActive) {
        progressWasActive = false;
        const rankingUnit = isBranchSearch() ? 'branches' : byId('searchTargetSelect')?.value === 'diff_commits' ? 'commit file diffs' : 'diff hunks';
        setStatus(searchInFlight ? `Ranking ${rankingUnit}…` : '', searchInFlight);
      } else if (cancel && !searchInFlight) {
        cancel.hidden = true;
      }
      return;
    }
    progressWasActive = true;
    const percent = Math.max(0, Math.min(100, Math.round((progress.current / progress.total) * 100)));
    const timing = [];
    const elapsed = formatDuration(progress.elapsed);
    const eta = formatDuration(progress.eta);
    if (elapsed) timing.push(elapsed);
    if (eta) timing.push(`ETA ${eta}`);
    const progressUnit = isBranchSearch() ? 'branch file diffs' : byId('searchTargetSelect')?.value === 'diff_commits' ? 'commit file diffs' : 'diff hunks';
    const progressPhase = !progress.phase || progress.phase === 'Embedding'
      ? `Embedding ${progressUnit}`
      : progress.phase;
    const isDeterminate = !/^Loading\b/i.test(progressPhase);
    const countText = isDeterminate ? ` ${progress.current}/${progress.total} (${percent}%)` : '';
    const timingText = timing.length ? ` · ${timing.join(', ')}` : '';
    const status = byId('status');
    if (status) {
      status.setAttribute('aria-busy', 'true');
      if (status.dataset.view !== 'index-progress') {
        status.innerHTML =
          '<span class="loading-spinner"></span>' +
          '<span class="loading-msg index-progress-message"></span>' +
          '<div class="owl-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100">' +
          '<div class="owl-progress-bar"></div>' +
          '</div>';
        status.dataset.view = 'index-progress';
      }

      const messageElement = status.querySelector('.index-progress-message');
      const progressTrack = status.querySelector('.owl-progress');
      const progressBar = status.querySelector('.owl-progress-bar');
      if (messageElement) messageElement.textContent = `${progressPhase}${countText}${timingText}`;
      if (progressTrack) {
        progressTrack.setAttribute('aria-label', progressPhase);
        if (isDeterminate) {
          progressTrack.setAttribute('aria-valuenow', String(percent));
          progressTrack.removeAttribute('aria-valuetext');
        } else {
          progressTrack.removeAttribute('aria-valuenow');
          progressTrack.setAttribute('aria-valuetext', progressPhase);
        }
      }
      if (progressBar) {
        progressBar.classList.toggle('determinate', isDeterminate);
        progressBar.classList.toggle('active', isDeterminate);
        if (isDeterminate) progressBar.style.width = `${percent}%`;
        else progressBar.style.removeProperty('width');
      }
    }
    if (cancel) cancel.hidden = false;
  }

  function syncSegmentedControl(control) {
    const select = byId(control.getAttribute('data-select'));
    if (!select) return;
    control.querySelectorAll('.segment-btn').forEach((button) => {
      button.classList.toggle('active', button.getAttribute('data-value') === select.value);
    });
  }

  function syncSegmentedControls() {
    document.querySelectorAll('.segmented-control').forEach(syncSegmentedControl);
  }

  function bindSegmentedControls() {
    document.querySelectorAll('.segmented-control').forEach((control) => {
      const select = byId(control.getAttribute('data-select'));
      if (!select) return;
      control.querySelectorAll('.segment-btn').forEach((button) => {
        button.addEventListener('click', () => {
          select.value = button.getAttribute('data-value') || select.value;
          syncSegmentedControl(control);
          select.dispatchEvent(new Event('change', { bubbles: true }));
        });
      });
      syncSegmentedControl(control);
    });
  }

  function translationSettings() {
    return {
      enable: Boolean(byId('translateToggle')?.checked),
      expand: Boolean(byId('queryExpansionToggle')?.checked),
      agentic: Boolean(byId('agenticSearchToggle')?.checked),
      model: byId('geminiModelSelect')?.value || 'gemini-3.8-flash',
    };
  }

  function updateTranslationSummary() {
    const summary = byId('translationSummary');
    if (summary) summary.textContent = translationText();
    updateSettingsStateSummary();
  }

  function updateTranslationSettings(partial) {
    translationRequestId += 1;
    vscode.postMessage({
      command: 'updateTranslationSettings',
      requestId: translationRequestId,
      ...partial,
    });
  }

  const COMMIT_PAGE_SIZE = 100;

  function updateTreeFilterControls() {
    const branchSelect = byId('commitBranchFilterSelect');
    const limitSelect = byId('commitBranchLimitSelect');
    const traversalSelect = byId('commitTraversalSelect');
    if (branchSelect) branchSelect.value = commitBranchFilter;
    if (limitSelect) {
      limitSelect.value = String(commitBranchLimit);
      limitSelect.disabled = Boolean(commitBranchFilter);
    }
    if (traversalSelect) traversalSelect.value = commitTraversal;
    const headInput = byId('diffHeadRefInput');
    const headHint = byId('headEndpointHint');
    const headEndpoint = headInput?.closest('.range-endpoint');
    if (headInput) {
      headInput.disabled = Boolean(commitBranchFilter);
      headInput.title = commitBranchFilter ? `Branch filter uses ${commitBranchFilter} as To` : '';
    }
    headEndpoint?.classList.toggle('is-overridden', Boolean(commitBranchFilter));
    if (headHint) {
      headHint.textContent = commitBranchFilter
        ? `Branch “${commitBranchFilter}” is being used as To`
        : 'Shift+click a commit below to set To';
    }
    updateSettingsStateSummary();
    updateRange();
  }

  function renderBranchOptions(branches) {
    gitBranches = Array.isArray(branches) ? branches : [];
    renderBranchBaseOptions();
    const select = byId('commitBranchFilterSelect');
    if (!select) return;
    select.innerHTML = '';
    const allOption = document.createElement('option');
    allOption.value = '';
    allOption.textContent = 'All visible branches';
    select.appendChild(allOption);
    gitBranches.forEach((branch) => {
      const option = document.createElement('option');
      option.value = branch.name;
      const location = branch.remote ? 'remote' : 'local';
      option.textContent = `${branch.current ? '✓ ' : ''}${branch.name} (${location})`;
      select.appendChild(option);
    });
    if (commitBranchFilter && !gitBranches.some((branch) => branch.name === commitBranchFilter)) {
      const staleOption = document.createElement('option');
      staleOption.value = commitBranchFilter;
      staleOption.textContent = `${commitBranchFilter} (unavailable)`;
      select.appendChild(staleOption);
    }
    updateTreeFilterControls();
  }

  function requestGitBranches() {
    vscode.postMessage({ command: 'getGitBranches' });
  }

  function requestGitCommits(options = {}) {
    const append = Boolean(options.append);
    if (append && (commitGraphLoading || !commitGraphHasMore)) return;

    const graph = byId('commitGraph');
    if (!append) {
      commitGraphData = [];
      commitGraphHasMore = true;
      commitGraphError = '';
      if (graph) graph.innerHTML = '<div class="commit-graph-empty">Loading commits…</div>';
      highlightCommitSelection();
    }
    commitGraphLoading = true;
    commitGraphRequestId += 1;
    if (append) renderCommitGraph(commitGraphData);
    vscode.postMessage({
      command: 'getGitCommits',
      limit: COMMIT_PAGE_SIZE,
      offset: append ? commitGraphData.length : 0,
      requestId: commitGraphRequestId,
      branchFilter: commitBranchFilter,
      maxBranches: commitBranchLimit,
      firstParent: commitTraversal === 'first_parent',
    });
  }

  const COMMIT_LANE_WIDTH = 16;
  const COMMIT_ROW_HEIGHT = 34;
  const COMMIT_COLORS = ['#4f9cff', '#22b07d', '#e0a23a', '#d05ce3', '#ef5e7a', '#39bcc4', '#9b8cff'];

  function laneColor(column) {
    return COMMIT_COLORS[((column % COMMIT_COLORS.length) + COMMIT_COLORS.length) % COMMIT_COLORS.length];
  }

  function normalizeRefLabel(value) {
    return String(value || '')
      .trim()
      .replace(/^HEAD -> /, '')
      .replace(/^tag: /, '')
      .replace(/^refs\/(?:heads|remotes|tags)\//, '');
  }

  function branchColor(value) {
    const label = normalizeRefLabel(value);
    let hash = 0;
    for (let index = 0; index < label.length; index += 1) {
      hash = ((hash << 5) - hash + label.charCodeAt(index)) | 0;
    }
    return COMMIT_COLORS[Math.abs(hash) % COMMIT_COLORS.length];
  }

  function summarizeCommitRefs(refs, preferredRef = '') {
    let isHead = false;
    let currentBranch = '';
    const labels = new Set();
    (refs || []).forEach((value) => {
      const ref = String(value || '').trim();
      if (ref === 'HEAD') {
        isHead = true;
        return;
      }
      if (ref.startsWith('HEAD -> ')) {
        isHead = true;
        currentBranch = normalizeRefLabel(ref);
      }
      const label = normalizeRefLabel(ref);
      if (label) labels.add(/^(?:tag: |refs\/tags\/)/.test(ref) ? `tag: ${label}` : label);
    });
    const ordered = [...labels];
    const preferred = normalizeRefLabel(preferredRef);
    const representative = currentBranch || (labels.has(preferred) ? preferred : '')
      || ordered.find((label) => !label.startsWith('tag: ')) || ordered[0];
    return {
      isHead,
      currentBranch,
      labels: representative ? [representative, ...ordered.filter((label) => label !== representative)] : [],
    };
  }

  function computeCommitLayout(commits) {
    const columns = new Map();
    const lanes = [];
    let maxLanes = 1;
    commits.forEach((commit) => {
      let column = lanes.indexOf(commit.hash);
      if (column < 0) {
        column = lanes.indexOf(null);
        if (column < 0) {
          column = lanes.length;
          lanes.push(null);
        }
      }
      columns.set(commit.hash, column);
      lanes.forEach((hash, index) => {
        if (index !== column && hash === commit.hash) lanes[index] = null;
      });
      const parents = Array.isArray(commit.parents) ? commit.parents : [];
      lanes[column] = parents[0] || null;
      parents.slice(1).forEach((parent) => {
        if (!lanes.includes(parent)) {
          const free = lanes.indexOf(null);
          if (free < 0) lanes.push(parent);
          else lanes[free] = parent;
        }
      });
      while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
      maxLanes = Math.max(maxLanes, lanes.length, column + 1);
    });
    return { columns, maxLanes };
  }

  function svgElement(name, attributes) {
    const element = document.createElementNS('http://www.w3.org/2000/svg', name);
    Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, String(value)));
    return element;
  }

  function renderCommitGraph(commits) {
    const container = byId('commitGraph');
    if (!container) return;
    const previousScrollTop = container.scrollTop;
    container.innerHTML = '';
    if (!commits.length) {
	  const emptyMessage = commitGraphLoading ? 'Loading commits…' : (commitGraphError || 'No commits found.');
	  container.innerHTML = `<div class="commit-graph-empty">${escapeHtml(emptyMessage)}</div>`;
      highlightCommitSelection();
      return;
    }

    const indexOf = new Map(commits.map((commit, index) => [commit.hash, index]));
    const { columns, maxLanes } = computeCommitLayout(commits);
    const graphWidth = maxLanes * COMMIT_LANE_WIDTH + 8;
    const height = commits.length * COMMIT_ROW_HEIGHT;
    const x = (column) => column * COMMIT_LANE_WIDTH + COMMIT_LANE_WIDTH / 2 + 4;
    const y = (index) => index * COMMIT_ROW_HEIGHT + COMMIT_ROW_HEIGHT / 2;
    const svg = svgElement('svg', { class: 'commit-graph-svg', width: graphWidth, height });

    commits.forEach((commit, index) => {
      const column = columns.get(commit.hash) || 0;
      (commit.parents || []).forEach((parentHash) => {
        if (!indexOf.has(parentHash)) return;
        const parentIndex = indexOf.get(parentHash);
        const parentColumn = columns.get(parentHash) || 0;
        const startX = x(column);
        const startY = y(index);
        const endX = x(parentColumn);
        const endY = y(parentIndex);
        const midY = (startY + endY) / 2;
        const d = startX === endX
          ? `M ${startX} ${startY} L ${endX} ${endY}`
          : `M ${startX} ${startY} C ${startX} ${midY} ${endX} ${midY} ${endX} ${endY}`;
        svg.appendChild(svgElement('path', {
          d,
          fill: 'none',
          stroke: laneColor(Math.max(column, parentColumn)),
          'stroke-width': 1.6,
          class: 'commit-edge',
          'data-child-hash': commit.hash,
          'data-parent-hash': parentHash,
        }));
      });
    });
    commits.forEach((commit, index) => {
      const column = columns.get(commit.hash) || 0;
      svg.appendChild(svgElement('circle', {
        cx: x(column),
        cy: y(index),
        r: 4.5,
        fill: laneColor(column),
        class: 'commit-node',
        'data-hash': commit.hash,
      }));
    });

    const rows = document.createElement('div');
    rows.className = 'commit-rows';
    rows.style.marginLeft = `${graphWidth}px`;
    commits.forEach((commit) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'commit-row';
      row.style.height = `${COMMIT_ROW_HEIGHT}px`;
      row.dataset.hash = commit.hash;
      const refSummary = summarizeCommitRefs(commit.refs, commitBranchFilter);
      const headTitle = refSummary.isHead
        ? (refSummary.currentBranch ? `Current commit (Git HEAD) · branch: ${refSummary.currentBranch}` : 'Current commit (Git HEAD) · detached')
        : '';
      const refTitle = [headTitle, ...refSummary.labels].filter(Boolean).join('\n');
      row.title = `${commit.short} ${commit.subject}\n${commit.author} · ${commit.date}\n${refTitle ? `${refTitle}\n` : ''}Click: From · Shift+Click: To`;
      row.setAttribute('aria-label', row.title);
      row.classList.toggle('is-git-head', refSummary.isHead);
      const label = refSummary.labels[0];
      const refs = label
        ? `<span class="commit-ref" title="${escapeHtml(refTitle)}" style="--commit-ref-color: ${branchColor(label)}">`
          + `<span class="commit-ref-label">${escapeHtml(label)}</span>`
          + (refSummary.labels.length > 1 ? `<span class="commit-ref-count">+${refSummary.labels.length - 1}</span>` : '')
          + '</span>'
        : '';
      row.innerHTML =
        `<span class="commit-hash">${escapeHtml(commit.short)}</span>` +
        (refSummary.isHead ? `<span class="commit-git-head" title="${escapeHtml(headTitle)}">Current</span>` : '') +
        '<span class="commit-badge commit-badge-base" title="Compare range: From (start)">From</span>' +
        '<span class="commit-badge commit-badge-head" title="Compare range: To (end)">To</span>' +
        refs +
        `<span class="commit-subject">${escapeHtml(commit.subject)}</span>` +
        `<span class="commit-meta">${escapeHtml(commit.date)}</span>`;
      row.addEventListener('click', (event) => {
        const input = byId(event.shiftKey ? 'diffHeadRefInput' : 'diffBaseRefInput');
        if (!input) return;
        input.value = input.value === commit.hash ? '' : commit.hash;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
      rows.appendChild(row);
    });

    const layout = document.createElement('div');
    layout.className = 'commit-graph-layout';
    layout.style.height = `${height}px`;
    svg.style.position = 'absolute';
    svg.style.inset = '0 auto auto 0';
    layout.append(svg, rows);
    container.appendChild(layout);

    const footer = document.createElement('div');
    footer.className = 'commit-graph-footer';
    if (commitGraphError) {
      footer.textContent = commitGraphError;
      footer.classList.add('is-error');
    } else if (commitGraphLoading) {
      footer.textContent = 'Loading older commits…';
    } else if (commitGraphHasMore) {
      const loadMoreButton = document.createElement('button');
      loadMoreButton.type = 'button';
      loadMoreButton.className = 'commit-load-more';
      loadMoreButton.textContent = `Load older commits (${commits.length} loaded)`;
      loadMoreButton.addEventListener('click', () => requestGitCommits({ append: true }));
      footer.appendChild(loadMoreButton);
    } else {
      footer.textContent = `End of local history · ${commits.length} commits`;
    }
    container.appendChild(footer);
    container.scrollTop = previousScrollTop;
    highlightCommitSelection();
  }

  function matchesRef(ref, hash) {
    return Boolean(ref && hash && (ref === hash || (ref.length >= 4 && hash.startsWith(ref))));
  }

  function resolveGraphRef(ref, commits) {
    const value = String(ref || '').trim();
    if (!value || value.toLowerCase() === 'working tree') return '';
    const hashMatch = commits.find((commit) => matchesRef(value, commit.hash));
    if (hashMatch) return hashMatch.hash;
    if (/^[0-9a-f]{40}$/i.test(value)) return value;
    if (value.toUpperCase() === 'HEAD') {
      const headCommit = commits.find((commit) => (commit.refs || []).some((item) => item === 'HEAD' || item.startsWith('HEAD -> ')));
      return headCommit?.hash || '';
    }
    const normalized = normalizeRefLabel(value);
    const refCommit = commits.find((commit) => (commit.refs || []).some((item) => normalizeRefLabel(item) === normalized));
    return refCommit?.hash || '';
  }

  function collectVisibleAncestors(startHash, commitMap) {
    const ancestors = new Set();
    const pending = startHash && commitMap.has(startHash) ? [startHash] : [];
    while (pending.length) {
      const hash = pending.pop();
      if (!hash || ancestors.has(hash)) continue;
      ancestors.add(hash);
      const commit = commitMap.get(hash);
      (commit?.parents || []).forEach((parentHash) => {
        if (commitMap.has(parentHash) && !ancestors.has(parentHash)) pending.push(parentHash);
      });
    }
    return ancestors;
  }

  function computeRangeCommitHashes(baseHash, headHash, commits) {
    if (!baseHash || !headHash) return new Set();
    const commitMap = new Map(commits.map((commit) => [commit.hash, commit]));
    const range = collectVisibleAncestors(headHash, commitMap);
    collectVisibleAncestors(baseHash, commitMap).forEach((hash) => range.delete(hash));
    return range;
  }

  function highlightCommitSelection() {
    const { base, head } = effectiveRangeRefs();
    const baseHash = resolveGraphRef(base, commitGraphData);
    const headHash = resolveGraphRef(head, commitGraphData);
    const ancestors = collectVisibleAncestors(headHash, new Map(commitGraphData.map((commit) => [commit.hash, commit])));
    const rangeHashes = recentCommitLimit()
      ? new Set(commitGraphData.filter((commit) => ancestors.has(commit.hash)).slice(0, 100).map((commit) => commit.hash))
      : computeRangeCommitHashes(baseHash, headHash, commitGraphData);
    document.querySelectorAll('#commitGraph .commit-row').forEach((row) => {
      const hash = row.getAttribute('data-hash') || '';
      row.classList.toggle('is-in-range', rangeHashes.has(hash));
      row.classList.toggle('is-base', hash === baseHash);
      row.classList.toggle('is-head', hash === headHash);
    });
    document.querySelectorAll('#commitGraph .commit-node').forEach((node) => {
      const hash = node.getAttribute('data-hash') || '';
      node.classList.toggle('is-in-range', rangeHashes.has(hash));
      node.classList.toggle('is-base', hash === baseHash);
      node.classList.toggle('is-head', hash === headHash);
    });
    document.querySelectorAll('#commitGraph .commit-edge').forEach((edge) => {
      const childHash = edge.getAttribute('data-child-hash') || '';
      const parentHash = edge.getAttribute('data-parent-hash') || '';
      const connectsRange = rangeHashes.has(childHash)
        && (rangeHashes.has(parentHash) || parentHash === baseHash);
      edge.classList.toggle('is-in-range', connectsRange);
    });
    const legend = byId('commitRangeLegend');
    if (!legend) return;
    const hasCommitRange = Boolean((baseHash || recentCommitLimit()) && headHash);
    legend.hidden = !hasCommitRange;
    if (hasCommitRange) {
      const count = rangeHashes.size;
      legend.textContent = `Target range · ${shortRef(base)} → ${shortRef(head)} · ${count} visible commit${count === 1 ? '' : 's'}`;
    }
  }

  function requestPrepareDiff() {
    if (searchInFlight || activePrepareRequestId !== null) return;
    activePrepareRequestId = `${sessionId}:prepare:${++searchSequence}`;
    updateSearchAvailability();
    const searchTarget = byId('searchTargetSelect')?.value || 'diff_hunks';
    const unitLabel = isBranchSearch() ? 'branch changes' : searchTarget === 'diff_commits' ? 'commit file diffs' : 'diff hunks';
    if (byId('diffStatus')) byId('diffStatus').textContent = `Checking ${unitLabel}…`;
    vscode.postMessage({
      command: 'prepareDiffSearch',
      prepareRequestId: activePrepareRequestId,
      branchBaseRef,
      lang: 'auto',
      scope: 'changed',
      searchMode: byId('searchModeSelect')?.value || 'semantic',
      searchTarget,
      includePatterns: byId('includePatternsInput')?.value || '',
      excludePatterns: byId('excludePatternsInput')?.value || '',
      excludeDocumentation: Boolean(byId('excludeDocumentationToggle')?.checked),
      diffBaseRef: isBranchSearch() ? '' : byId('diffBaseRefInput')?.value || '',
      diffHeadRef: isBranchSearch() ? '' : byId('diffHeadRefInput')?.value || '',
      branchRef: commitBranchFilter,
      firstParent: commitTraversal === 'first_parent',
      force: false,
      recentCommitLimit: recentCommitLimit(),
    });
  }

  function runSearch() {
    if (searchInFlight || activePrepareRequestId !== null) return;
    const query = byId('searchInput')?.value.trim() || '';
    if (!query) {
      setStatus('Enter a query first.', false);
      byId('searchInput')?.focus();
      return;
    }
    searchInFlight = true;
    if (byId('agentTrace')) byId('agentTrace').hidden = true;
    if (byId('translatedQuery')) byId('translatedQuery').hidden = true;
    activeSearchRequestId = `${sessionId}:search:${++searchSequence}`;
    updateSearchAvailability();
    const searchTarget = byId('searchTargetSelect')?.value || 'diff_hunks';
    setStatus(isBranchSearch() ? 'Searching branches by their changes…' : searchTarget === 'diff_commits' ? 'Searching commit diffs…' : 'Searching diff hunks…', true);
    byId('emptyState')?.setAttribute('hidden', '');
    const translation = translationSettings();
    vscode.postMessage({
      command: 'search',
      searchRequestId: activeSearchRequestId,
      branchBaseRef,
      text: query,
      lang: 'auto',
      scope: 'changed',
      searchMode: byId('searchModeSelect')?.value || 'semantic',
      searchTarget,
      includePatterns: byId('includePatternsInput')?.value || '',
      excludePatterns: byId('excludePatternsInput')?.value || '',
      excludeDocumentation: Boolean(byId('excludeDocumentationToggle')?.checked),
      diffBaseRef: isBranchSearch() ? '' : byId('diffBaseRefInput')?.value || '',
      diffHeadRef: isBranchSearch() ? '' : byId('diffHeadRefInput')?.value || '',
      branchRef: commitBranchFilter,
      firstParent: commitTraversal === 'first_parent',
      translateEnabled: translation.enable,
      expandEnabled: translation.expand,
      agenticEnabled: translation.agentic,
      recentCommitLimit: recentCommitLimit(),
      geminiModel: translation.model,
    });
    saveState();
  }

  function relativePath(file) {
    const normalizedFile = String(file || '').replace(/\\/g, '/');
    const normalizedRoot = String(currentFolderPath || '').replace(/\\/g, '/').replace(/\/$/, '');
    return normalizedRoot && normalizedFile.startsWith(`${normalizedRoot}/`)
      ? normalizedFile.slice(normalizedRoot.length + 1)
      : normalizedFile;
  }

  function formatScore(value, searchMode) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return null;
    }
    return searchMode === 'bm25'
      ? `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`
      : value.toFixed(3);
  }

  function openResultDiff(result, file, line) {
    const commitHash = String(result.commit_hash || '').trim();
    vscode.postMessage({
      command: 'openDiff',
      file,
      line,
      baseRef: commitHash ? `${commitHash}^` : (byId('diffBaseRefInput')?.value || ''),
      headRef: commitHash || (byId('diffHeadRefInput')?.value || ''),
      oldPath: result.diff_old_path || '',
      newPath: result.diff_new_path || '',
    });
  }

  function resultTitle(result, file, line) {
    if (result.symbol_kind === 'diff_branch') return result.branch_name;
    if (result.symbol_kind === 'diff_commit') {
      return result.commit_subject || result.function_name || result.name || 'Working tree changes';
    }
    if (result.symbol_kind === 'diff_hunk') return `${relativePath(result.path || file) || 'Diff hunk'}:${line}`;
    const name = result.function_name || result.name || 'Changed function';
    return result.class_name ? `${result.class_name}.${name}` : name;
  }

  function resultContext(result, isCommitDiff) {
    if (result.symbol_kind === 'diff_branch') {
      return `${result.branch_commit_count} commits · ${result.branch_file_count} files · Best match: ${result.scored_file_path}`;
    }
    if (!isCommitDiff) return result.commit_subject || '';
    const parts = [];
    if (result.commit_hash) parts.push(shortRef(result.commit_hash));
    if (result.scored_file_path) {
      const fileLabel = result.commit_score_aggregation === 'whole_commit' ? 'Preview file' : result.commit_score_aggregation === 'first_matching_file' ? 'Matched file' : 'Best match';
      parts.push(`${fileLabel}: ${result.scored_file_path}`);
    }
    if (Number.isFinite(result.commit_file_count)) {
      parts.push(`${result.commit_file_count} files · ${result.commit_hunk_count || 0} hunks`);
    }
    return parts.join(' · ');
  }

  function sortResultsForDisplay(results, order) {
    const score = result => Number.isInteger(result.agent_relevance) && result.agent_relevance >= 0 && result.agent_relevance <= 100
      ? result.agent_relevance : -1;
    return [...results].sort((a, b) => {
      if (order === 'retrieval') return (a.agent_retrieval_rank ?? a.rank ?? 0) - (b.agent_retrieval_rank ?? b.rank ?? 0);
      return score(b) - score(a) || (a.rank ?? 0) - (b.rank ?? 0);
    });
  }

  function renderResults(results, folderPath, meta) {
    searchInFlight = false;
    progressWasActive = false;
    activeSearchRequestId = null;
    updateSearchAvailability();
    updateBranchSearchSummary(meta);
    currentResultsMeta = meta || {};
    const incoming = Array.isArray(results) ? results : [];
    const isAgentic = incoming.some(result => result.agent_result_id);
    currentResults = isAgentic ? sortResultsForDisplay(incoming, byId('resultSortSelect')?.value || 'relevance') : incoming;
    if (byId('resultSortControls')) byId('resultSortControls').hidden = !isAgentic;
    currentFolderPath = folderPath || currentFolderPath;
    const container = byId('results');
    if (!container) return;
    container.innerHTML = '';

    if (!currentResults.length) {
      container.innerHTML =
        '<div class="empty-state" id="emptyState">' +
        `<div class="empty-title">${meta?.search_target === 'diff_branches' ? 'No matching branches' : 'No matching changes'}</div>` +
        `<div class="empty-hint">${meta?.search_target === 'diff_branches' ? 'Try another query or comparison base. Branches already contained in the base have no changes to search.' : 'Check the file filters and compare range, or try another query.'}</div>` +
        '</div>';
      const cacheSuffix = meta?.diff_embedding_cache_hit ? ' · cached embeddings' : '';
      setStatus(`0 results${cacheSuffix}`, false);
      return;
    }

    const cacheSource = meta?.diff_embedding_cache_source;
    const cacheSuffix = cacheSource === 'incremental'
      ? ` · ${meta.num_reused_embeddings || 0} reused / ${meta.num_new_embeddings || 0} new embeddings`
      : cacheSource === 'memory' || cacheSource === 'disk' || cacheSource === 'units'
      ? ' · cached embeddings'
      : cacheSource === 'fresh' ? ' · embeddings saved' : '';
    setStatus(`${currentResults.length} result${currentResults.length === 1 ? '' : 's'}${cacheSuffix}`, false);
    currentResults.forEach((result, index) => {
      const card = document.createElement('article');
      const isBranch = result.symbol_kind === 'diff_branch';
      const isCommitDiff = result.symbol_kind === 'diff_commit';
      const hasCommitDiff = isCommitDiff && Boolean(result.commit_hash);
      const isDiff = result.symbol_kind === 'diff_hunk' || isCommitDiff || isBranch;
      card.className = `result-item${isDiff ? ' diff-item' : ''}${isBranch ? ' branch-result' : ''}`;
      const file = result.file_path || result.file || '';
      const line = Number(result.lineno || result.line_number || 1);
      const rankScore = result.hybrid_score ?? result.score ?? result.similarity;
      const score = formatScore(rankScore, result.search_mode);
      const scoreTitle = {
        semantic: 'Cosine similarity',
        hybrid: 'Hybrid score',
        bm25: 'Normalized BM25 score',
      }[result.search_mode] || 'Match score';
      const context = resultContext(result, isCommitDiff);
      const assessed = Number.isInteger(result.agent_relevance) && result.agent_relevance >= 0 && result.agent_relevance <= 100;
      card.innerHTML =
        '<div class="result-header">' +
        `<span class="result-rank${index < 3 ? ' rank-top' : ''}">${index + 1}</span>` +
        '<div class="result-heading">' +
        `<div class="function-name">${escapeHtml(resultTitle(result, file, line))}</div>` +
        (context ? `<div class="result-context">${escapeHtml(context)}</div>` : '') +
        '</div>' +
        (result.agent_result_id ? `<span class="score-badge" title="Gemini relevance estimate from observed diffs; not a probability">${assessed ? `Relevance ${result.agent_relevance}/100` : 'Not assessed'}</span>` : result.keyword_match ? '<span class="score-badge" title="All keywords matched">Match</span>' : score === null ? '' : `<span class="score-badge" title="${scoreTitle}">${score}</span>`) +
        '</div>';
      if (result.agent_change_summary) {
        const summary = document.createElement('div');
        summary.className = 'result-change-summary';
        summary.textContent = result.agent_change_summary;
        card.appendChild(summary);
      }
      if (result.agent_relevance_reason) {
        const explanation = document.createElement('div');
        explanation.className = 'result-context result-relevance-reason';
        explanation.textContent = `Why: ${result.agent_relevance_reason}`;
        card.appendChild(explanation);
      }
      if (Array.isArray(result.agent_queries)) {
        const evidence = document.createElement('div');
        evidence.className = 'result-context';
        evidence.textContent = `Found via: ${result.agent_queries.join(' · ')}`;
        card.appendChild(evidence);
      }
      if (Array.isArray(result.agent_keyword_checks) && result.agent_keyword_checks.length) {
        const checks = document.createElement('details');
        checks.className = 'agent-keyword-checks';
        checks.addEventListener('click', event => event.stopPropagation());
        const label = document.createElement('summary');
        label.textContent = `Keyword hits (${result.agent_keyword_checks.length})`;
        checks.appendChild(label);
        result.agent_keyword_checks.forEach(check => {
          const title = document.createElement('div');
          title.textContent = `${check.query} · ${check.path}`;
          checks.appendChild(title);
          (check.excerpts || []).forEach(excerpt => {
            const code = document.createElement('pre');
            code.textContent = `Diff line ${excerpt.diffLine}\n${excerpt.text}`;
            checks.appendChild(code);
          });
        });
        card.appendChild(checks);
      }

      const openPrimaryDiff = () => {
        if (hasCommitDiff) {
          vscode.postMessage({
            command: 'openCommitDiff',
            hash: result.commit_hash,
            preferredFile: result.scored_file_path || file,
          });
        } else {
          openResultDiff(result, file, line);
        }
      };
      card.addEventListener('click', openPrimaryDiff);

      if (isBranch) {
        if (result.branch_aliases?.length) {
          const aliases = document.createElement('div');
          aliases.className = 'result-context branch-aliases';
          aliases.textContent = `Also ${result.branch_aliases.join(', ')}`;
          card.appendChild(aliases);
        }
        const evidence = document.createElement('div');
        evidence.className = 'branch-evidence';
        const label = document.createElement('div');
        label.className = 'branch-evidence-label';
        label.textContent = 'Matching changes';
        evidence.appendChild(label);
        (result.matching_commits || []).forEach((entry) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'branch-evidence-item';
          button.innerHTML = `<span>${escapeHtml(entry.commit_subject)}</span><small>${escapeHtml(shortRef(entry.commit_hash))} · ${escapeHtml(entry.scored_file_path)}</small>`;
          button.addEventListener('click', (event) => {
            event.stopPropagation();
            openResultDiff(entry, entry.file_path, Number(entry.lineno || 1));
          });
          evidence.appendChild(button);
        });
        card.appendChild(evidence);
      }

      const commitFiles = Array.isArray(result.commit_hunks) ? result.commit_hunks : [];
      if (!isBranch && commitFiles.length > 1) {
        const details = document.createElement('details');
        details.className = 'diff-commit-files';
        details.addEventListener('click', (event) => event.stopPropagation());
        details.innerHTML = `<summary>Files in this commit (${commitFiles.length})</summary>`;
        commitFiles.forEach((entry) => {
          const fileButton = document.createElement('button');
          fileButton.type = 'button';
          fileButton.className = `diff-commit-hunk-head${entry.is_representative ? ' representative' : ''}`;
          const entryPath = entry.path || relativePath(entry.file_path || file);
          const representativeLabel = result.commit_score_aggregation === 'whole_commit' ? 'Preview file' : result.commit_score_aggregation === 'first_matching_file'
            ? 'Matched file'
            : 'Best match';
          fileButton.textContent = entry.is_representative ? `${representativeLabel} · ${entryPath}` : entryPath;
          fileButton.addEventListener('click', (event) => {
            event.stopPropagation();
            openResultDiff({
              ...result,
              diff_old_path: entry.diff_old_path || '',
              diff_new_path: entry.diff_new_path || '',
            }, entry.file_path || file, Number(entry.lineno || 1));
          });
          details.appendChild(fileButton);
        });
        card.appendChild(details);
      }

      const actions = document.createElement('div');
      actions.className = 'diff-result-actions';
      const openButton = document.createElement('button');
      openButton.type = 'button';
      openButton.className = 'diff-action-btn open-diff-action';
      openButton.textContent = hasCommitDiff ? 'Open Commit Diff' : isBranch ? 'Open Best Diff' : 'Open Diff';
      if (hasCommitDiff) openButton.title = 'Open all changed files in this commit';
      openButton.addEventListener('click', (event) => {
        event.stopPropagation();
        openPrimaryDiff();
      });
      actions.appendChild(openButton);
      if (result.commit_hash) {
        const commitButton = document.createElement('button');
        commitButton.type = 'button';
        commitButton.className = 'diff-action-btn open-commit-action';
        commitButton.textContent = 'Open Commit';
        commitButton.addEventListener('click', (event) => {
          event.stopPropagation();
          vscode.postMessage({ command: 'openCommitRemote', hash: result.commit_hash });
        });
        actions.appendChild(commitButton);
      }
      card.appendChild(actions);
      container.appendChild(card);
    });
  }

  function bindEvents() {
    bindSegmentedControls();
    byId('resultSortSelect')?.addEventListener('change', () => {
      if (!searchInFlight) renderResults(currentResults, currentFolderPath, currentResultsMeta);
    });
    byId('setupAndStartBtn')?.addEventListener('click', () => vscode.postMessage({ command: 'setupAndStart' }));
    byId('stopServerBtn')?.addEventListener('click', () => vscode.postMessage({ command: 'stopServer' }));
    byId('cancelEmbeddingBtn')?.addEventListener('click', () => vscode.postMessage({ command: 'cancelEmbedding', searchRequestId: activeSearchRequestId }));
    byId('searchBtn')?.addEventListener('click', runSearch);
    byId('searchInput')?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') runSearch();
    });
    byId('searchInput')?.addEventListener('input', invalidateSearch);
    byId('refreshDiffSearchBtn')?.addEventListener('click', requestPrepareDiff);
    byId('reloadCommitsBtn')?.addEventListener('click', () => {
      requestGitBranches();
      requestGitCommits();
    });
    byId('commitBranchFilterSelect')?.addEventListener('change', (event) => {
      invalidateSearch();
      commitBranchFilter = event.currentTarget.value || '';
      updateTreeFilterControls();
      saveState();
      requestGitCommits();
    });
    byId('commitBranchLimitSelect')?.addEventListener('change', (event) => {
      const value = Number(event.currentTarget.value);
      commitBranchLimit = [0, 1, 3, 5, 10, 20].includes(value) ? value : 5;
      updateTreeFilterControls();
      saveState();
      requestGitCommits();
    });
    byId('commitTraversalSelect')?.addEventListener('change', (event) => {
      invalidateSearch();
      commitTraversal = event.currentTarget.value === 'first_parent' ? 'first_parent' : 'full';
      updateTreeFilterControls();
      saveState();
      requestGitCommits();
    });
    byId('commitGraph')?.addEventListener('scroll', (event) => {
      const graph = event.currentTarget;
      if (!(graph instanceof HTMLElement)) return;
      const distanceFromBottom = graph.scrollHeight - graph.scrollTop - graph.clientHeight;
      if (distanceFromBottom <= 64) requestGitCommits({ append: true });
    });
    ['searchModeSelect', 'searchTargetSelect'].forEach((id) => {
      byId(id)?.addEventListener('change', () => {
        syncSegmentedControls();
        updateSearchTargetUI();
        invalidateSearch();
        saveState();
      });
    });
    byId('branchBaseRefSelect')?.addEventListener('change', (event) => {
      invalidateSearch();
      branchBaseRef = event.currentTarget.value;
      if (byId('branchSearchSummary')) byId('branchSearchSummary').textContent = '';
      saveState();
    });
    byId('blankRangeModeSelect')?.addEventListener('change', () => {
      invalidateSearch();
      updateRange();
      saveState();
    });
    ['diffBaseRefInput', 'diffHeadRefInput'].forEach((id) => {
      byId(id)?.addEventListener('input', () => {
        invalidateSearch();
        updateRange();
      });
      byId(id)?.addEventListener('change', () => {
        invalidateSearch();
        updateRange();
        saveState();
      });
    });
    ['includePatternsInput', 'excludePatternsInput'].forEach((id) => {
      byId(id)?.addEventListener('input', () => {
        invalidateSearch();
        updateTargetFilterSummary();
      });
      byId(id)?.addEventListener('change', saveState);
    });
    byId('excludeDocumentationToggle')?.addEventListener('change', () => {
      invalidateSearch();
      updateTargetFilterSummary();
      saveState();
    });
    byId('translateToggle')?.addEventListener('change', () => {
      invalidateSearch();
      updateTranslationSummary();
      updateTranslationSettings({ enable: Boolean(byId('translateToggle').checked) });
    });
    byId('geminiModelSelect')?.addEventListener('change', () => {
      invalidateSearch();
      updateTranslationSummary();
      updateTranslationSettings({ model: byId('geminiModelSelect').value });
    });
    byId('queryExpansionToggle')?.addEventListener('change', () => {
      invalidateSearch();
      updateTranslationSummary();
      updateTranslationSettings({ expand: Boolean(byId('queryExpansionToggle').checked) });
    });
    byId('agenticSearchToggle')?.addEventListener('change', () => {
      invalidateSearch();
      updateTranslationSummary();
      updateTranslationSettings({ agentic: Boolean(byId('agenticSearchToggle').checked) });
    });
  }

  window.addEventListener('message', (event) => {
    const message = event.data || {};
    if (typeof message.searchRequestId === 'string' && message.searchRequestId !== activeSearchRequestId) return;
    if (typeof message.prepareRequestId === 'string' && message.prepareRequestId !== activePrepareRequestId) return;
    if (['results', 'translatedQuery', 'agentTrace'].includes(message.type) && message.searchRequestId !== activeSearchRequestId) return;
    if (['diffPrepared', 'diffPrepareError'].includes(message.type) && message.prepareRequestId !== activePrepareRequestId) return;
    if (message.type === 'initState') {
      restoreState(message.state);
      requestGitCommits();
      return;
    }
    if (message.type === 'translationSettings') {
      if (typeof message.requestId === 'number' && message.requestId < translationRequestId) return;
      const toggle = byId('translateToggle');
      const expansion = byId('queryExpansionToggle');
      const agentic = byId('agenticSearchToggle');
      const model = byId('geminiModelSelect');
      if (toggle) toggle.checked = Boolean(message.enable);
      if (expansion) expansion.checked = Boolean(message.expand);
      if (agentic) agentic.checked = Boolean(message.agentic);
      if (model && typeof message.model === 'string') model.value = message.model;
      updateTranslationSummary();
      return;
    }
    if (message.type === 'translationSettingsError') {
      if (typeof message.requestId === 'number' && message.requestId < translationRequestId) return;
      setStatus(message.message || 'Failed to save Gemini settings.', false);
      vscode.postMessage({ command: 'requestTranslationSettings' });
      return;
    }
    if (message.type === 'agentTrace') {
      const trace = byId('agentTrace');
      const content = byId('agentTraceContent');
      if (!trace || !content) return;
      trace.hidden = false;
      const steps = Array.isArray(message.steps) ? message.steps : [];
      content.innerHTML = (steps.length ? '<ol>' + steps.map(step =>
        `<li><strong>${escapeHtml(step.tool || step.mode)}: ${escapeHtml(step.query)}</strong> — ${step.status === 'complete' ? `${Number(step.resultCount) || 0} results` : escapeHtml(step.status || '')}<br>${escapeHtml(step.reason || '')}</li>`
      ).join('') + '</ol>' : '') + `<p>${escapeHtml(message.summary || message.status || '')}</p>`;
      if (Array.isArray(message.warnings) && message.warnings.length) {
        content.innerHTML += '<ul>' + message.warnings.map(warning => `<li>${escapeHtml(warning)}</li>`).join('') + '</ul>';
      }
      if (Array.isArray(message.diagnostics) && message.diagnostics.length) {
        content.innerHTML += '<details><summary>Diagnostics</summary><ul>' + message.diagnostics.map(item =>
          `<li>${escapeHtml(item.phase)} / ${escapeHtml(item.code)}: ${escapeHtml(item.message)}</li>`
        ).join('') + '</ul></details>';
      }
      return;
    }
    if (message.type === 'translatedQuery') {
      const translated = byId('translatedQuery');
      if (!translated) return;
      if (message.original && message.translated && message.original !== message.translated) {
        translated.innerHTML = `${message.rewriteKind === 'expanded' ? 'Expanded query' : 'Translated'}: <strong>${escapeHtml(message.translated)}</strong>`;
        translated.hidden = false;
      } else {
        translated.hidden = true;
      }
      return;
    }
    if (message.type === 'serverStatus') {
      setServerStatus(message.online, message.port || '');
      return;
    }
    if (message.type === 'indexProgress') {
      applyIndexProgress(message.progress);
      return;
    }
    if (message.type === 'gitCommits') {
      if (typeof message.requestId === 'number' && message.requestId !== commitGraphRequestId) return;
      const incoming = Array.isArray(message.commits) ? message.commits : [];
      if (message.append) {
        const knownHashes = new Set(commitGraphData.map((commit) => commit.hash));
        commitGraphData = commitGraphData.concat(incoming.filter((commit) => !knownHashes.has(commit.hash)));
      } else {
        commitGraphData = incoming;
      }
      commitGraphLoading = false;
      commitGraphHasMore = Boolean(message.hasMore);
      commitGraphError = typeof message.error === 'string' ? message.error : '';
      renderCommitGraph(commitGraphData);
      return;
    }
    if (message.type === 'gitBranches') {
      renderBranchOptions(message.branches);
      return;
    }
    if (message.type === 'diffPrepared') {
      activePrepareRequestId = null;
      progressWasActive = false;
      updateSearchAvailability();
      const data = message.data || {};
      setStatus(data.cancelled ? data.message || 'Diff preparation cancelled.' : '', false);
      updateBranchSearchSummary(data);
      const status = byId('diffStatus');
      const unitCount = data.num_diff_units ?? data.num_diff_hunks ?? 0;
      const source = data.diff_embedding_cache_source;
      const embeddingState = source === 'incremental'
        ? `${data.num_reused_embeddings || 0} reused / ${data.num_new_embeddings || 0} new`
        : source === 'memory' || source === 'disk' || source === 'units'
        ? `cached (${source})`
        : source === 'fresh' ? 'saved' : source;
      if (status) {
        status.textContent = data.search_target === 'diff_commits'
          ? `${data.num_diff_commits || 0} commits / ${unitCount} file diff groups · embeddings ${embeddingState || 'ready'}`
          : `${unitCount} hunks / ${data.num_files || 0} files · embeddings ${embeddingState || 'ready'}`;
      }
      return;
    }
    if (message.type === 'diffPrepareError') {
      activePrepareRequestId = null;
      progressWasActive = false;
      updateSearchAvailability();
      setStatus('', false);
      const status = byId('diffStatus');
      if (status) status.textContent = message.message || 'Failed to prepare the diff.';
      return;
    }
    if (message.type === 'status') {
      const statusMessage = message.message || '';
      const finished = /cancelled|completed|failed|ready/i.test(statusMessage);
      const busy = !finished && /agent|searching|expanding|translating|indexing|embedding|setting up|starting|checking|cancelling|cancellation requested/i.test(statusMessage);
      setStatus(statusMessage, busy);
      return;
    }
    if (message.type === 'error') {
      searchInFlight = false;
      progressWasActive = false;
      activeSearchRequestId = null;
      updateSearchAvailability();
      setStatus(message.message || 'An error occurred.', false);
      return;
    }
    if (message.type === 'results') {
      renderResults(message.results, message.folderPath || '', message.meta || {});
    }
  });

  bindEvents();
  restoreState(vscode.getState());
  updateSearchTargetUI();
  updateRange();
  updateTargetFilterSummary();
  updateTranslationSummary();
  requestGitBranches();
  requestGitCommits();
  vscode.postMessage({ command: 'requestInitState' });
  vscode.postMessage({ command: 'requestTranslationSettings' });
  vscode.postMessage({ command: 'checkServerStatus' });
})();
