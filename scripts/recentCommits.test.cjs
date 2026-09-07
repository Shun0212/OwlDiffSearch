const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '..', 'media', 'main.js'), 'utf8');
function setup(values = {}, branch = '') {
  const fields = Object.fromEntries(Object.entries(values).map(([id, value]) => [id, { value }]));
  const context = vm.createContext({ byId: (id) => fields[id], commitBranchFilter: branch });
  for (const name of ['shortRef', 'isBranchSearch', 'effectiveRangeRefs', 'recentCommitLimit']) {
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
