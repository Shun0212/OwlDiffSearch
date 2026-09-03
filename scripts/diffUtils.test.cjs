const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildCommitUrl,
  formatDiffRange,
  normalizeCommitPage,
  normalizeDiffSearchTarget,
  normalizeSearchMode,
  parseGlobPatterns,
  refsForResult,
  validateGitRef,
} = require('../out/diffUtils.js');

test('normalizes commit graph pagination safely', () => {
  assert.deepEqual(normalizeCommitPage(undefined, undefined), { limit: 200, offset: 0 });
  assert.deepEqual(normalizeCommitPage(250, 400), { limit: 250, offset: 400 });
  assert.deepEqual(normalizeCommitPage(5000, -10), { limit: 1000, offset: 0 });
});

test('normalizes diff-only search options', () => {
  assert.equal(normalizeSearchMode('hybrid'), 'hybrid');
  assert.equal(normalizeSearchMode('random'), 'semantic');
  assert.equal(normalizeDiffSearchTarget('diff_hunks'), 'diff_hunks');
  assert.equal(normalizeDiffSearchTarget('unknown'), 'diff_hunks');
  assert.equal(normalizeDiffSearchTarget('diff_commits'), 'diff_commits');
});

test('parses compact include and exclude glob input', () => {
  assert.deepEqual(
    parseGlobPatterns(' src/**, .py\n./packages/api/**, src/** '),
    ['src/**', '*.py', 'packages/api/**'],
  );
  assert.deepEqual(parseGlobPatterns(['tests/**', null, ' docs/** ']), ['tests/**', 'docs/**']);
});

test('validates Git refs and formats ranges', () => {
  assert.equal(validateGitRef(' origin/main '), 'origin/main');
  assert.throws(() => validateGitRef('--output=/tmp/file'));
  assert.throws(() => validateGitRef('main HEAD'));
  assert.equal(formatDiffRange('', ''), 'HEAD → working tree');
  assert.equal(formatDiffRange('origin/main', ''), 'origin/main → HEAD');
  assert.equal(formatDiffRange('0123456789abcdef', 'fedcba9876543210'), '0123456 → fedcba9');
});

test('uses a commit parent for commit-attributed results', () => {
  assert.deepEqual(refsForResult('abc123', 'main', 'HEAD'), {
    baseRef: 'abc123^',
    headRef: 'abc123',
  });
  assert.deepEqual(refsForResult('', 'main', 'feature'), {
    baseRef: 'main',
    headRef: 'feature',
  });
});

test('builds GitHub and GitLab commit URLs', () => {
  assert.equal(
    buildCommitUrl('git@github.com:owner/repo.git', 'abc123'),
    'https://github.com/owner/repo/commit/abc123',
  );
  assert.equal(
    buildCommitUrl('https://gitlab.com/owner/repo.git', 'abc123'),
    'https://gitlab.com/owner/repo/-/commit/abc123',
  );
  assert.equal(buildCommitUrl('not-a-remote', 'abc123'), undefined);
});
