const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { readCommitChanges } = require('../out/commitDiff.js');
const { createCommitDiffFixture } = require('../out/test/commitDiffFixture.js');

test('loads every changed file from Git and puts the matching file first', async (t) => {
  const fixture = createCommitDiffFixture();
  t.after(fixture.dispose);
  const commit = await readCommitChanges(fixture.repo, fixture.hash, fixture.preferredFile);
  assert.equal(commit.hash, fixture.hash);
  assert.equal(commit.parent, fixture.parent);
  assert.equal(commit.files.length, 6);
  assert.equal(commit.files[0].newPath, fixture.preferredFile);
  assert.ok(commit.files.some((file) => file.newPath === 'README.md'), 'Search documentation exclusions must not hide commit changes');
  assert.deepEqual(commit.files.find((file) => file.status.startsWith('R')), {
    status: 'R100', oldPath: 'old name.txt', newPath: 'new name.txt',
  });
  assert.deepEqual(commit.files.find((file) => file.oldPath === 'remove.txt'), {
    status: 'D', oldPath: 'remove.txt', newPath: undefined,
  });
  assert.deepEqual(commit.files.find((file) => file.newPath === 'added.txt'), {
    status: 'A', oldPath: undefined, newPath: 'added.txt',
  });
  assert.ok(commit.files.some((file) => file.newPath === 'tab\t日本語.txt'));
  const absoluteMatch = await readCommitChanges(fixture.repo, fixture.hash.slice(0, 9), path.join(fixture.repo, fixture.preferredFile));
  assert.deepEqual(absoluteMatch.files, commit.files);
});

test('opens an initial commit as added files without a nonexistent parent', async (t) => {
  const fixture = createCommitDiffFixture();
  t.after(fixture.dispose);
  const commit = await readCommitChanges(fixture.repo, fixture.parent);
  assert.equal(commit.parent, undefined);
  assert.equal(commit.files.length, 4);
  assert.ok(commit.files.every((file) => file.status === 'A' && file.oldPath === undefined));
});

test('compares a merge against its first parent and reads committed content', async (t) => {
  const fixture = createCommitDiffFixture();
  t.after(fixture.dispose);
  fixture.git('checkout', '-qb', 'feature');
  fixture.write('feature.txt', 'new feature\n');
  fixture.git('add', '.');
  fixture.git('commit', '-qm', 'Add feature');
  fixture.git('checkout', '-q', 'main');
  fixture.git('merge', '--no-ff', '-qm', 'Merge feature', 'feature');
  const merge = fixture.git('rev-parse', 'HEAD');
  fixture.write('local.txt', 'uncommitted content\n');
  const commit = await readCommitChanges(fixture.repo, merge);
  assert.equal(commit.parent, fixture.hash);
  assert.deepEqual(commit.files, [{ status: 'A', oldPath: undefined, newPath: 'feature.txt' }]);
});

test('handles empty commits and rejects invalid or missing commits', async (t) => {
  const fixture = createCommitDiffFixture();
  t.after(fixture.dispose);
  fixture.git('commit', '--allow-empty', '-qm', 'No changes');
  assert.deepEqual((await readCommitChanges(fixture.repo, fixture.git('rev-parse', 'HEAD'))).files, []);
  await assert.rejects(readCommitChanges(fixture.repo, '--output=/tmp/unsafe'), /commit hash/);
  await assert.rejects(readCommitChanges(fixture.repo, 'f'.repeat(40)));
});
