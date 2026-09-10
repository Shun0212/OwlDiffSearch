const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function webview() {
  function element() {
    return { value: '', checked: false, hidden: true, events: {}, children: [],
      addEventListener(name, listener) { this.events[name] = listener; },
      appendChild(child) { this.children.push(child); },
      set innerHTML(value) { this.html = value; this.children = []; },
      get innerHTML() { return this.html || ''; },
    };
  }
  const fields = Object.fromEntries(['searchInput', 'searchBtn', 'searchTargetSelect', 'searchModeSelect', 'translateToggle',
    'queryExpansionToggle', 'agenticSearchToggle', 'geminiModelSelect', 'agentTrace', 'agentTraceContent', 'translatedQuery',
    'results', 'resultSortSelect', 'resultSortControls'].map(id => [id, element()]));
  fields.searchInput.value = '認証';
  fields.searchTargetSelect.value = 'diff_commits';
  fields.searchModeSelect.value = 'semantic';
  fields.resultSortSelect.value = 'relevance';
  const messages = [];
  let receive;
  const context = vm.createContext({
    acquireVsCodeApi: () => ({ postMessage: message => messages.push(message), setState() {} }),
    window: { OWL_WEBVIEW_SESSION_ID: 'test', addEventListener: (_name, listener) => { receive = listener; } },
    document: { getElementById: id => fields[id], querySelectorAll: () => [], createElement: element },
  });
  const source = fs.readFileSync(path.join(__dirname, '../media/main.js'), 'utf8');
  // Bind real event handlers; leave unrelated initial Git history loading out of this fixture.
  vm.runInContext(source.slice(0, source.lastIndexOf('\n  bindEvents();')) + '\n  bindEvents();\n})();', context);
  return { fields, messages, receive: message => receive({ data: message }) };
}

test('restores and persists the agentic option, then includes it in search requests', () => {
  const ui = webview();
  ui.receive({ type: 'translationSettings', agentic: true, model: 'gemini-3.8-flash' });
  assert.equal(ui.fields.agenticSearchToggle.checked, true);
  ui.fields.agenticSearchToggle.events.change();
  assert.equal(ui.messages.at(-1).agentic, true);
  ui.fields.searchBtn.events.click();
  const request = ui.messages.find(item => item.command === 'search');
  assert.equal(request.agenticEnabled, true);
  assert.equal(request.searchTarget, 'diff_commits');
  assert.equal(request.text, '認証');
  assert.equal(request.geminiModel, 'gemini-3.8-flash');
});

test('escapes agent output and ignores stale traces after query changes cancel the current search', () => {
  const ui = webview();
  ui.fields.searchBtn.events.click();
  const request = ui.messages.find(item => item.command === 'search');
  const trace = { type: 'agentTrace', searchRequestId: request.searchRequestId,
    steps: [{ query: '<script>bad()</script>', mode: 'bm25', reason: '<img>', resultCount: 2, status: 'complete' }], summary: '<b>summary</b>',
    warnings: ['Skipped <img>'], diagnostics: [{ phase: 'gemini', code: 'http_429', message: 'Quota <script>' }] };
  ui.receive(trace);
  assert.equal(ui.fields.agentTrace.hidden, false);
  assert.match(ui.fields.agentTraceContent.innerHTML, /&lt;script&gt;/);
  assert.doesNotMatch(ui.fields.agentTraceContent.innerHTML, /<script>|<img>|<b>/);
  assert.match(ui.fields.agentTraceContent.innerHTML, /Diagnostics/);
  assert.match(ui.fields.agentTraceContent.innerHTML, /http_429/);
  assert.match(ui.fields.agentTraceContent.innerHTML, /Skipped &lt;img&gt;/);
  ui.fields.searchInput.events.input();
  assert.equal(ui.messages.at(-1).command, 'cancelSearch');
  assert.equal(ui.messages.at(-1).searchRequestId, request.searchRequestId);
  assert.equal(ui.fields.agentTrace.hidden, true);
  ui.receive(trace);
  assert.equal(ui.fields.agentTrace.hidden, true);
});

test('renders relevance, literal change summaries and reasons; switches ranking locally', () => {
  const ui = webview();
  ui.fields.searchBtn.events.click();
  const request = ui.messages.find(item => item.command === 'search');
  const results = [
    { name: 'first', path: 'first.py', agent_result_id: 'r1', rank: 2, agent_retrieval_rank: 1, agent_relevance: 30,
      agent_change_summary: '低い関連度の修正', agent_relevance_reason: '間接的な変更' },
    { name: 'second', path: 'second.py', agent_result_id: 'r2', rank: 1, agent_retrieval_rank: 2, agent_relevance: 95,
      agent_change_summary: '<img onerror=bad()> を除去した', agent_relevance_reason: '目的の修正 <script>' },
    { name: 'third', path: 'third.py', agent_result_id: 'r3', rank: 3, agent_retrieval_rank: 3, agent_relevance: null },
  ];
  ui.receive({ type: 'results', searchRequestId: request.searchRequestId, results, meta: {} });
  assert.equal(ui.fields.resultSortControls.hidden, false);
  let cards = ui.fields.results.children;
  assert.match(cards[0].innerHTML, /Relevance 95\/100/);
  assert.match(cards[2].innerHTML, /Not assessed/);
  const summary = cards[0].children.find(child => child.className === 'result-change-summary');
  assert.equal(summary.textContent, '<img onerror=bad()> を除去した');
  assert.equal(summary.innerHTML, '');
  assert.equal(cards[0].children.find(child => child.className?.includes('result-relevance-reason')).textContent, 'Why: 目的の修正 <script>');
  const count = ui.messages.length;
  ui.fields.resultSortSelect.value = 'retrieval';
  ui.fields.resultSortSelect.events.change();
  cards = ui.fields.results.children;
  assert.match(cards[0].innerHTML, /Relevance 30\/100/);
  ui.fields.resultSortSelect.value = 'relevance';
  ui.fields.resultSortSelect.events.change();
  assert.match(ui.fields.results.children[0].innerHTML, /Relevance 95\/100/);
  assert.equal(ui.messages.length, count);
});

test('keeps ordinary search ranking and hides Gemini sort controls', () => {
  const ui = webview();
  ui.fields.searchBtn.events.click();
  const request = ui.messages.find(item => item.command === 'search');
  ui.receive({ type: 'results', searchRequestId: request.searchRequestId, meta: {}, results: [
    { name: 'first', path: 'first.py', search_mode: 'semantic', score: 0.8 },
    { name: 'second', path: 'second.py', search_mode: 'semantic', score: 0.7 },
  ] });
  assert.equal(ui.fields.resultSortControls.hidden, true);
  assert.doesNotMatch(ui.fields.results.children[0].innerHTML, /Relevance|Not assessed/);
});
