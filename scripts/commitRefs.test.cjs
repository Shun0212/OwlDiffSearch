const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const script = fs.readFileSync(path.join(root, 'media', 'main.js'), 'utf8');
const context = vm.createContext({});
for (const name of ['normalizeRefLabel', 'summarizeCommitRefs']) {
  const start = script.indexOf(`  function ${name}(`);
  const end = script.indexOf('\n  function ', start + 1);
  assert.ok(start >= 0 && end > start, `${name} must exist`);
  vm.runInContext(script.slice(start, end), context);
}
const summarize = (refs, preferred) => JSON.parse(JSON.stringify(context.summarizeCommitRefs(refs, preferred)));

test('keeps Git HEAD separate and prioritizes its branch among many refs', () => {
  const refs = ['origin/main', ...Array.from({ length: 30 }, (_, i) => `feature/${i}`), 'HEAD -> main'];
  const result = summarize(refs, 'feature/9');
  assert.equal(result.isHead, true);
  assert.equal(result.currentBranch, 'main');
  assert.equal(result.labels[0], 'main');
  assert.equal(result.labels.length, 32);
  assert.equal(refs.at(-1), 'HEAD -> main', 'The Git refs must not be modified');
});

test('keeps detached HEAD visible without counting it as a branch', () => {
  assert.deepEqual(summarize(['HEAD']), { isHead: true, currentBranch: '', labels: [] });
  assert.deepEqual(summarize(['origin/main', 'HEAD']), { isHead: true, currentBranch: '', labels: ['origin/main'] });
});

test('does not mistake a remote HEAD alias for the checked-out commit', () => {
  assert.equal(summarize(['origin/HEAD', 'origin/main']).isHead, false);
});

test('deduplicates labels while keeping tags and branches distinct', () => {
  assert.deepEqual(summarize(['HEAD -> refs/heads/main', 'main', 'refs/heads/main', 'tag: main', 'refs/tags/main']).labels,
    ['main', 'tag: main']);
});

test('prefers the selected branch, then a branch over tags', () => {
  const refs = ['tag: v1', 'origin/main', 'release'];
  assert.equal(summarize(refs, 'refs/heads/release').labels[0], 'release');
  assert.equal(summarize(refs).labels[0], 'origin/main');
  assert.deepEqual(summarize(['tag: v1']).labels, ['tag: v1']);
});

test('handles commits with no refs', () => {
  assert.deepEqual(summarize(undefined), { isHead: false, currentBranch: '', labels: [] });
  assert.deepEqual(summarize(['', null, ' ']).labels, []);
});

test('recognizes attached and detached HEAD from real Git decorations', (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'owl-commit-refs-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', timeout: 10000 }).trim();
  git('init', '-q', '-b', 'main');
  git('-c', 'user.name=Test Author', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false',
    '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '--allow-empty', '-m', 'Graph fixture');
  for (let i = 0; i < 8; i += 1) git('branch', `feature/${i}`);
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('tag', 'v1');
  const refs = () => git('-c', 'log.decorate=full', 'log', '--decorate=short', '-1', '--format=%D').split(',').map((ref) => ref.trim());
  assert.ok(refs().includes('HEAD -> main'));
  const attached = summarize(refs());
  assert.equal(attached.isHead, true);
  assert.equal(attached.labels[0], 'main');
  assert.equal(attached.labels.length, 11);
  git('-c', 'core.hooksPath=/dev/null', 'checkout', '-q', '--detach', 'HEAD');
  const detached = summarize(refs());
  assert.equal(detached.isHead, true);
  assert.equal(detached.currentBranch, '');
  assert.equal(detached.labels.length, attached.labels.length);
});

test('uses OwlDiffSearch branding without changing extension or setting identifiers', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const html = fs.readFileSync(path.join(root, 'src', 'webviewHtml.ts'), 'utf8');
  assert.equal(manifest.displayName, 'OwlDiffSearch');
  assert.equal(manifest.name, 'owl-diff-search');
  assert.equal(manifest.publisher, 'owl-diff-search-local');
  assert.equal(manifest.contributes.viewsContainers.activitybar[0].title, 'OwlDiffSearch');
  assert.equal(manifest.contributes.views.owlDiffSearch[0].name, 'OwlDiffSearch');
  for (const command of manifest.contributes.commands) {
    assert.match(command.title, /^OwlDiffSearch: /);
    assert.match(command.command, /^owlDiffSearch\./);
  }
  assert.equal(manifest.contributes.configuration.title, 'OwlDiffSearch');
  assert.ok(Object.keys(manifest.contributes.configuration.properties).every((key) => key.startsWith('owlDiffSearch.')));
  assert.match(html, /<title>OwlDiffSearch<\/title>/);
  assert.match(html, /class="brand-title">OwlDiffSearch<\/div>/);
});
