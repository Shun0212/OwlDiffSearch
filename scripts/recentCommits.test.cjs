const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '..', 'media', 'main.js'), 'utf8');
function setup(values = {}, branch = '') {
  const changes = [];
  const fields = Object.fromEntries(Object.entries(values).map(([id, value]) => [id, {
    value, dispatchEvent(event) { changes.push({ id, type: event.type }); },
  }]));
  const context = vm.createContext({ byId: (id) => fields[id], commitBranchFilter: branch,
    Event: class { constructor(type) { this.type = type; } }, fields, changes,
    updateTreeFilterControls() { fields.diffHeadRefInput.disabled = Boolean(context.commitBranchFilter); },
    requestGitCommits() { context.reloadedBranch = context.commitBranchFilter; },
  });
  for (const name of ['shortRef', 'isBranchSearch', 'effectiveRangeRefs', 'recentCommitLimit', 'selectCommitRange']) {
    const start = script.indexOf(`  function ${name}(`);
    const end = script.indexOf('\n  function ', start + 1);
    vm.runInContext(script.slice(start, end), context);
  }
  return context;
}

test('blank initial refs search the latest 100 commits at HEAD', () => {
  const ui = setup();
  assert.equal(ui.recentCommitLimit(), 100);
  assert.equal(ui.effectiveRangeRefs().base, 'Latest 100 commits');
  assert.equal(ui.effectiveRangeRefs().head, 'HEAD');
});

test('an explicit From overrides the limit while To or Branch selects its tip', () => {
  assert.equal(setup({ diffBaseRefInput: 'main' }).recentCommitLimit(), 0);
  const ui = setup({ diffHeadRefInput: 'release' });
  assert.equal(ui.recentCommitLimit(), 100);
  assert.equal(ui.effectiveRangeRefs().head, 'release');
  assert.equal(setup({ diffHeadRefInput: 'release' }, 'feature').effectiveRangeRefs().head, 'feature');
});

test('working tree and branch discovery do not apply the recent limit', () => {
  const ui = setup({ blankRangeModeSelect: 'working_tree' });
  assert.equal(ui.recentCommitLimit(), 0);
  assert.equal(ui.effectiveRangeRefs().base, 'HEAD');
  assert.equal(ui.effectiveRangeRefs().head, 'working tree');
  assert.equal(setup({ searchTargetSelect: 'diff_branches' }).recentCommitLimit(), 0);
});

test('Shift selection overrides a branch even when the selected To was saved previously', () => {
  for (const previous of ['', 'chosen']) {
    const ui = setup({ diffBaseRefInput: 'start', diffHeadRefInput: previous }, 'feature');
    ui.selectCommitRange('chosen', true);
    assert.equal(ui.effectiveRangeRefs().head, 'chosen');
    assert.equal(ui.effectiveRangeRefs().base, 'start');
    assert.equal(ui.commitBranchFilter, '');
    assert.equal(ui.fields.diffHeadRefInput.disabled, false);
    assert.equal(ui.reloadedBranch, '');
    assert.deepEqual(ui.changes, [{ id: 'diffHeadRefInput', type: 'change' }]);
  }
});

test('ordinary selection keeps the branch and repeated endpoint selection clears it', () => {
  const ui = setup({ diffBaseRefInput: '', diffHeadRefInput: '' }, 'feature');
  ui.selectCommitRange('start', false);
  assert.equal(ui.effectiveRangeRefs().base, 'start');
  assert.equal(ui.effectiveRangeRefs().head, 'feature');
  assert.equal(ui.reloadedBranch, undefined);
  ui.selectCommitRange('start', false);
  assert.equal(ui.fields.diffBaseRefInput.value, '');
  ui.selectCommitRange('chosen', true);
  ui.selectCommitRange('chosen', true);
  assert.equal(ui.fields.diffHeadRefInput.value, '');
});
