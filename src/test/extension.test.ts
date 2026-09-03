import * as assert from 'assert';
import * as vscode from 'vscode';
import {
    buildCommitUrl,
    formatDiffRange,
    normalizeDiffSearchTarget,
    normalizeSearchMode,
    parseGlobPatterns,
    refsForResult,
    validateGitRef,
} from '../diffUtils';

suite('Owl Diff Search', () => {
    test('extension activates and exposes only diff-search commands', async () => {
        const extension = vscode.extensions.getExtension('owl-diff-search-local.owl-diff-search');
        assert.ok(extension, 'Extension was not discovered by the test host');
        await extension.activate();
        assert.ok(extension.isActive, 'Extension did not activate');

        const commands = await vscode.commands.getCommands(true);
        const expected = [
            'owlDiffSearch.open',
            'owlDiffSearch.startServer',
            'owlDiffSearch.stopServer',
            'owlDiffSearch.cancelEmbedding',
            'owlDiffSearch.setupEnv',
            'owlDiffSearch.clearCache',
            'owlDiffSearch.removeVenv',
        ];
        expected.forEach((command) => assert.ok(commands.includes(command), `${command} not found`));
        assert.ok(!commands.includes('owlDiffSearch.findSimilarSelection'));
        assert.ok(!commands.includes('owlDiffSearch.generateAgentSetup'));
    });

    test('normalizes target filter patterns', () => {
        assert.deepStrictEqual(
            parseGlobPatterns('src/**, .py\n./packages/api/**'),
            ['src/**', '*.py', 'packages/api/**'],
        );
    });

    test('normalizes the public diff-search options', () => {
        assert.strictEqual(normalizeSearchMode('hybrid'), 'hybrid');
        assert.strictEqual(normalizeSearchMode('random'), 'semantic');
        assert.strictEqual(normalizeDiffSearchTarget('diff_hunks'), 'diff_hunks');
        assert.strictEqual(normalizeDiffSearchTarget('unknown'), 'diff_hunks');
        assert.strictEqual(normalizeDiffSearchTarget('diff_commits'), 'diff_commits');
    });

    test('validates refs and formats compare ranges', () => {
        assert.strictEqual(validateGitRef(' origin/main '), 'origin/main');
        assert.throws(() => validateGitRef('--output=/tmp/file'));
        assert.throws(() => validateGitRef('main HEAD'));
        assert.strictEqual(formatDiffRange('', ''), 'HEAD → working tree');
        assert.strictEqual(formatDiffRange('origin/main', ''), 'origin/main → HEAD');
        assert.strictEqual(formatDiffRange('0123456789abcdef', 'fedcba9876543210'), '0123456 → fedcba9');
    });

    test('opens commit results against their parent', () => {
        assert.deepStrictEqual(refsForResult('abc123', 'main', 'HEAD'), {
            baseRef: 'abc123^',
            headRef: 'abc123',
        });
        assert.deepStrictEqual(refsForResult('', 'main', 'feature'), {
            baseRef: 'main',
            headRef: 'feature',
        });
    });

    test('builds commit URLs for common Git remotes', () => {
        assert.strictEqual(
            buildCommitUrl('git@github.com:owner/repo.git', 'abc123'),
            'https://github.com/owner/repo/commit/abc123',
        );
        assert.strictEqual(
            buildCommitUrl('https://gitlab.com/owner/repo.git', 'abc123'),
            'https://gitlab.com/owner/repo/-/commit/abc123',
        );
        assert.strictEqual(buildCommitUrl('not-a-remote', 'abc123'), undefined);
    });
});
