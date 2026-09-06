import * as assert from 'assert';
import * as vscode from 'vscode';
import { buildGitShowUri, openCommitDiff } from '../commitDiffEditor';
import { createCommitDiffFixture } from './commitDiffFixture';
import {
    buildCommitUrl,
    formatDiffRange,
    normalizeDiffSearchTarget,
    normalizeSearchMode,
    parseGlobPatterns,
    refsForResult,
    validateGitRef,
} from '../diffUtils';

suite('OwlDiffSearch', () => {
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

    test('opens all commit files in one native diff tab with readable revision content', async function () {
        this.timeout(20000);
        const fixture = createCommitDiffFixture();
        try {
            await vscode.extensions.getExtension('owl-diff-search-local.owl-diff-search')!.activate();
            await vscode.commands.executeCommand('workbench.action.closeAllEditors');
            await openCommitDiff(fixture.repo, fixture.hash, fixture.preferredFile);
            const expectedTitle = `${fixture.hash.slice(0, 7)} · Update requests and related files (6 files)`;
            for (let attempt = 0; attempt < 100; attempt++) {
                if (vscode.window.tabGroups.activeTabGroup.activeTab?.label === expectedTitle) { break; }
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
            const tabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs);
            assert.strictEqual(tabs.length, 1, 'The commit must open in a single tab');
            assert.strictEqual(tabs[0].label, expectedTitle);
            const original = await vscode.workspace.openTextDocument(buildGitShowUri(fixture.repo, fixture.parent, fixture.preferredFile));
            const modified = await vscode.workspace.openTextDocument(buildGitShowUri(fixture.repo, fixture.hash, fixture.preferredFile));
            assert.strictEqual(original.getText(), 'timeout = 1\n');
            assert.strictEqual(modified.getText(), 'timeout = 10\n');
            for (const [ref, file, expected] of [
                [fixture.hash, 'README.md', 'new documentation\n'],
                [fixture.hash, 'added.txt', 'added content\n'],
                [fixture.parent, 'remove.txt', 'removed content\n'],
                [fixture.parent, 'old name.txt', 'renamed content\n'],
                [fixture.hash, 'new name.txt', 'renamed content\n'],
            ]) {
                const document = await vscode.workspace.openTextDocument(buildGitShowUri(fixture.repo, ref, file));
                assert.strictEqual(document.getText(), expected);
            }
            await vscode.commands.executeCommand('workbench.action.closeAllEditors');
            await openCommitDiff(fixture.repo, fixture.parent);
            const rootTitle = `${fixture.parent.slice(0, 7)} · Initial files (4 files)`;
            for (let attempt = 0; attempt < 100; attempt++) {
                if (vscode.window.tabGroups.activeTabGroup.activeTab?.label === rootTitle) { break; }
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
            assert.strictEqual(vscode.window.tabGroups.activeTabGroup.activeTab?.label, rootTitle);
        } finally {
            await vscode.commands.executeCommand('workbench.action.closeAllEditors');
            fixture.dispose();
        }
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
