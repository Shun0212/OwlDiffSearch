import * as assert from 'assert';
import * as vscode from 'vscode';
import { buildGitShowUri, openCommitDiff } from '../commitDiffEditor';
import { createCommitDiffFixture } from './commitDiffFixture';
import { MODEL_PROFILES } from '../nodeSearch/models';
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
            'owlDiffSearch.prepareModel',
            'owlDiffSearch.stopEngine',
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

    test('searches through the extension API without a Python environment or HTTP server', async function () {
        this.timeout(20000);
        const extension = vscode.extensions.getExtension('owl-diff-search-local.owl-diff-search')!;
        const api = await extension.activate();
        const fixture = createCommitDiffFixture();
        try {
            const result = await api.search({ directory: fixture.repo, query: 'timeout', search_mode: 'keyword',
                search_target: 'diff_commits', recent_commit_limit: 100 });
            assert.strictEqual(result.backend, 'node-onnx');
            assert.strictEqual(result.num_new_embeddings, 0);
            assert.ok(result.results.some((item: { commit_hash: string }) => item.commit_hash === fixture.hash));
            await vscode.commands.executeCommand('owlDiffSearch.stopEngine');
            const restarted = await api.search({ directory: fixture.repo, query: 'timeout', search_mode: 'bm25', recent_commit_limit: 100 });
            assert.ok(restarted.results.length > 0);
        } finally {
            await vscode.commands.executeCommand('owlDiffSearch.stopEngine');
            fixture.dispose();
        }
    });

    test('runs real ONNX inference inside the VS Code extension worker', async function () {
        if (process.env.OWL_ONNX_TEST !== '1') { this.skip(); }
        this.timeout(60000);
        const api = await vscode.extensions.getExtension('owl-diff-search-local.owl-diff-search')!.activate();
        const fixture = createCommitDiffFixture();
        const config = vscode.workspace.getConfiguration('owlDiffSearch');
        const previousModel = config.inspect<string>('modelName')?.globalValue;
        try {
            for (const model of MODEL_PROFILES) {
                await config.update('modelName', model.id, vscode.ConfigurationTarget.Global);
                const result = await api.search({ directory: fixture.repo, query: 'increase the request timeout',
                    search_mode: 'semantic', search_target: 'diff_commits', diff_base_ref: fixture.parent, diff_head_ref: fixture.hash });
                assert.strictEqual(result.backend, 'node-onnx');
                assert.strictEqual(result.embedding_dimensions, model.dimensions);
                assert.strictEqual(result.model_revision, model.revision);
                assert.strictEqual(result.results.length, 1);
                assert.strictEqual(result.results[0].scored_file_path, fixture.preferredFile);
                assert.ok(Number.isFinite(result.results[0].score));
                assert.strictEqual(result.results[0].distance_metric, 'cosine');
            }
        } finally {
            await config.update('modelName', previousModel, vscode.ConfigurationTarget.Global);
            await vscode.commands.executeCommand('owlDiffSearch.stopEngine');
            fixture.dispose();
        }
    });

    test('applies saved ONNX precision settings to the next worker', async function () {
        this.timeout(20000);
        const api = await vscode.extensions.getExtension('owl-diff-search-local.owl-diff-search')!.activate();
        const fixture = createCommitDiffFixture();
        const config = vscode.workspace.getConfiguration('owlDiffSearch');
        const previous = config.inspect<string>('onnxDtype')?.globalValue;
        try {
            for (const dtype of ['fp32', 'q8']) {
                await config.update('onnxDtype', dtype, vscode.ConfigurationTarget.Global);
                const result = await api.search({ directory: fixture.repo, query: 'timeout', search_mode: 'keyword', recent_commit_limit: 100 });
                assert.strictEqual(result.model_dtype, dtype);
                assert.strictEqual(vscode.workspace.getConfiguration('owlDiffSearch').get('onnxDtype'), dtype);
            }
        } finally {
            await config.update('onnxDtype', previous, vscode.ConfigurationTarget.Global);
            await vscode.commands.executeCommand('owlDiffSearch.stopEngine');
            fixture.dispose();
        }
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
