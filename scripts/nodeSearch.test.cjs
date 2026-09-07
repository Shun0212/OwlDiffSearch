const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { SearchEngine, bm25 } = require('../out/nodeSearch/engine');
const { collectHunks, parsePatch, buildCommitUnits, matchesPath } = require('../out/nodeSearch/git');
const { EmbeddingCache, hashText, normalize, cosine, tokenizeBatch } = require('../out/nodeSearch/embedding');
const { NodeSearchClient } = require('../out/nodeSearch/client');
const { ensureModelFiles } = require('../out/nodeSearch/modelFiles');
const { DEFAULT_MODEL, DEFAULT_REVISION } = require('../out/nodeSearch/types');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owl-node-search-'));
    const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const git = (...args) => cp.execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init', '-b', 'main'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Search test');
    const write = (file, text) => { fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true }); fs.writeFileSync(path.join(repo, file), text); };
    const commit = subject => { git('add', '.'); git('commit', '-m', subject); return git('rev-parse', 'HEAD'); };
    const options = { cacheDir: path.join(root, 'cache'), modelName: DEFAULT_MODEL, revision: DEFAULT_REVISION, dtype: 'q8', batchSize: 2, localFilesOnly: true };
    return { root, repo, git, write, commit, options };
}

function fakeEmbedder() {
    const calls = [];
    return { namespace: 'test-v1', dimensions: 3, calls,
        async encode(texts) { calls.push([...texts]); return texts.map(text => normalize(Float32Array.from(text.includes('auth') ? [1, 0.1, 0] : text.includes('cache') ? [0.1, 1, 0] : [0, 0.1, 1]))); },
    };
}

test('preserves SEP at the long-input boundary and masks padding', () => {
    const tokenizer = { encode: (text, opts) => opts?.add_special_tokens === false ? Array.from({ length: text.length }, () => 99) : [2, 3], pad_token_id: 1 };
    const batch = tokenizeBatch(tokenizer, ['x'.repeat(2000), 'a']);
    assert.deepEqual(batch.dims, [2, 1024]);
    assert.equal(batch.ids[0], 2n); assert.equal(batch.ids[1023], 3n);
    assert.deepEqual([...batch.ids.slice(1024, 1028)], [2n, 99n, 3n, 1n]);
    assert.deepEqual([...batch.mask.slice(1024, 1028)], [1n, 1n, 1n, 0n]);
    assert.equal(cosine(normalize(new Float32Array([3, 4])), new Float32Array([0, 1])), 0.800000011920929);
    assert.throws(() => normalize(new Float32Array([NaN, 1])));
});

test('parses source lines beginning with ---/+++ without mistaking them for paths', () => {
    const patch = 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1,2 +1,2 @@\n---old\n+++new\n context\n';
    const [hunk] = parsePatch(patch, '/repo', { directory: '/repo' });
    assert.equal(hunk.path, 'a.js'); assert.equal(hunk.additions, 1); assert.equal(hunk.deletions, 1);
    assert.deepEqual(hunk.added_ranges, [[1, 1]]); assert.deepEqual(hunk.removed_ranges, [[1, 1]]);
    assert.match(hunk.search_text, /---old\n\+\+\+new/);
});

test('reads roots, recent commits, explicit ranges and branch precedence using real Git', async t => {
    const f = fixture(t);
    f.write('auth.js', 'auth\n'); const root = f.commit('root');
    f.write('cache.js', 'cache\n'); const second = f.commit('cache');
    f.git('branch', 'feature');
    f.write('last.js', 'last\n'); const last = f.commit('last');
    const recent = await collectHunks({ directory: f.repo, recent_commit_limit: 2 });
    assert.deepEqual(new Set(recent.map(h => h.commit_hash)), new Set([last, second]));
    const all = await collectHunks({ directory: f.repo, recent_commit_limit: 100 });
    assert.equal(all.length, 3); assert.equal(all.find(h => h.commit_hash === root).diff_old_path, null);
    const range = await collectHunks({ directory: f.repo, diff_base_ref: root, diff_head_ref: last, branch_ref: 'feature', recent_commit_limit: 1 });
    assert.deepEqual(range.map(h => h.commit_hash), [second]);
    await assert.rejects(collectHunks({ directory: f.repo, diff_base_ref: '--output=bad' }), /Unsupported Git ref/);
    await assert.rejects(collectHunks({ directory: f.repo, diff_head_ref: 'does-not-exist', recent_commit_limit: 100 }));
});

test('collects edited, staged, untracked and deleted text; handles quoted filenames and excludes binaries/ignored symlinks', async t => {
    const f = fixture(t);
    f.write('delete.js', 'remove\n'); f.write('edit.js', 'old\n'); f.commit('base');
    f.write('edit.js', 'new\n'); fs.unlinkSync(path.join(f.repo, 'delete.js'));
    f.write('staged.js', 'staged\n'); f.git('add', 'staged.js');
    f.write('日本語\tfile.js', 'untracked\n');
    f.write('binary.dat', Buffer.from([1, 0, 2])); f.write('.gitignore', 'ignored.js\n'); f.write('ignored.js', 'secret\n');
    fs.writeFileSync(path.join(f.root, 'external'), 'external secret\n'); fs.symlinkSync(path.join(f.root, 'external'), path.join(f.repo, 'link.js'));
    const hunks = await collectHunks({ directory: f.repo });
    assert.deepEqual(new Set(hunks.map(h => h.path)), new Set(['delete.js', 'edit.js', 'staged.js', '日本語\tfile.js', '.gitignore']));
    assert.equal(hunks.find(h => h.path === 'delete.js').diff_new_path, null);
    f.git('add', '日本語\tfile.js'); f.git('commit', '-m', 'quoted');
    assert.ok((await collectHunks({ directory: f.repo, recent_commit_limit: 1 })).some(h => h.path === '日本語\tfile.js'));
});

test('handles staged additions before the first commit and text renames after a commit', async t => {
    const f = fixture(t); f.write('before.js', 'auth\nunchanged\ncontent\n'); f.git('add', '.');
    const unborn = await collectHunks({ directory: f.repo });
    assert.equal(unborn.length, 1); assert.equal(unborn[0].diff_old_path, null);
    f.commit('root'); f.git('mv', 'before.js', 'after.js'); f.write('after.js', 'auth updated\nunchanged\ncontent\n');
    const hunks = await collectHunks({ directory: f.repo });
    assert.equal(hunks[0].diff_old_path, 'before.js'); assert.equal(hunks[0].diff_new_path, 'after.js');
});

test('glob filters match root/nested files and preserve file scoring boundaries', async t => {
    const f = fixture(t);
    f.write('auth.js', 'auth\n'); f.write('src/cache.js', 'cache\n'); f.write('README.md', 'docs\n'); f.commit('one');
    assert.ok(matchesPath('README.md', ['**/*.md'])); assert.ok(matchesPath('src/cache.js', ['*.js']));
    const hunks = await collectHunks({ directory: f.repo, recent_commit_limit: 100, include_globs: ['**/*.js'], exclude_globs: ['src/**'] });
    assert.deepEqual(hunks.map(h => h.path), ['auth.js']);
    const units = buildCommitUnits(await collectHunks({ directory: f.repo, recent_commit_limit: 100 }));
    assert.equal(units.length, 3);
    assert.ok(units.every(unit => unit.commit_file_count === 3 && unit.scored_file_hunk_count === 1));
    assert.ok(!units.find(unit => unit.path === 'auth.js').search_text.includes('cache'));
});

test('first-parent search represents the merge patch while full history includes side commits', async t => {
    const f = fixture(t); f.write('base', 'base'); const base = f.commit('base');
    f.git('checkout', '-b', 'feature'); f.write('a.js', 'auth'); const a = f.commit('a');
    f.write('b.js', 'cache'); const b = f.commit('b'); f.git('checkout', 'main');
    f.git('merge', '--no-ff', 'feature', '-m', 'merge'); const merge = f.git('rev-parse', 'HEAD');
    const req = { directory: f.repo, diff_base_ref: base, diff_head_ref: 'main' };
    assert.deepEqual(new Set((await collectHunks(req)).map(h => h.commit_hash)), new Set([a, b]));
    assert.deepEqual(new Set((await collectHunks({ ...req, first_parent: true })).map(h => h.commit_hash)), new Set([merge]));
});

test('semantic/hybrid rank by the best commit file and reuse exact vectors across restart and edits', async t => {
    const f = fixture(t); f.write('auth.js', 'auth\n'); f.write('unrelated.js', 'unrelated\n'); f.commit('auth change');
    f.write('cache.js', 'cache\n'); f.commit('cache change');
    const embedder = fakeEmbedder(); let engine = new SearchEngine(f.options, undefined, embedder);
    const req = { directory: f.repo, recent_commit_limit: 100, search_target: 'diff_commits', query: 'auth' };
    const first = await engine.run('search', req);
    assert.equal(first.num_new_embeddings, 3); assert.equal(first.results.length, 2);
    assert.equal(first.results[0].scored_file_path, 'auth.js'); assert.equal(first.results[0].commit_file_count, 2);
    assert.equal(first.results[0].commit_score_aggregation, 'max_file');
    const warm = await engine.run('search', { ...req, search_mode: 'hybrid' });
    assert.equal(warm.num_new_embeddings, 0); assert.equal(warm.num_reused_embeddings, 3);
    assert.ok(Math.abs(warm.results[0].score - (0.6 * warm.results[0].semantic_similarity + 0.4 * warm.results[0].bm25_score)) < 1e-7);
    engine = new SearchEngine(f.options, undefined, fakeEmbedder());
    assert.equal((await engine.run('search', req)).num_reused_embeddings, 3);
    f.write('new.js', 'auth extra'); f.commit('new');
    const edited = await engine.run('search', req);
    assert.equal(edited.num_new_embeddings, 1); assert.equal(edited.num_reused_embeddings, 3);
    const otherModel = { ...fakeEmbedder(), namespace: 'test-v2-fp32' };
    assert.equal((await new SearchEngine(f.options, undefined, otherModel).run('search', req)).num_new_embeddings, 4);
});

test('working tree edits invalidate exact text while unchanged hunks reuse the cache', async t => {
    const f = fixture(t); f.write('auth.js', 'auth\n'); f.commit('base');
    f.write('auth.js', 'auth one\n'); f.write('cache.js', 'cache one\n');
    const engine = new SearchEngine(f.options, undefined, fakeEmbedder());
    const req = { directory: f.repo, query: 'auth' };
    assert.equal((await engine.run('search', req)).num_new_embeddings, 2);
    f.write('auth.js', 'auth two\n');
    const updated = await engine.run('search', req);
    assert.equal(updated.num_new_embeddings, 1); assert.equal(updated.num_reused_embeddings, 1);
    assert.ok(updated.results.some(r => r.search_text.includes('auth two')));
    assert.ok(!updated.results.some(r => r.search_text.includes('auth one')));
});

test('keyword and BM25 have empty no-match results and never load an embedding model', async t => {
    const f = fixture(t); f.write('auth.js', 'auth token\n'); f.commit('auth');
    const embedder = { namespace: 'no-model', dimensions: 3, encode: () => { throw new Error('must not encode'); } };
    const engine = new SearchEngine(f.options, undefined, embedder);
    for (const mode of ['keyword', 'bm25']) {
        const req = { directory: f.repo, query: 'auth', recent_commit_limit: 100, search_mode: mode };
        assert.equal((await engine.run('search', req)).results.length, 1);
        assert.deepEqual((await engine.run('search', { ...req, query: 'unicorn_xyz' })).results, []);
        assert.equal((await engine.run('prepare', req)).num_new_embeddings, 0);
    }
    assert.equal(bm25(['auth auth', 'cache'], 'auth').get(0), 1);
});

test('branch search ranks changes outside main, combines tracking aliases, and shares evidence', async t => {
    const f = fixture(t); f.write('base.js', 'base\n'); f.commit('base');
    f.git('checkout', '-b', 'feature/auth'); f.write('auth.js', 'auth token\n'); const hash = f.commit('authenticate');
    f.git('branch', 'feature/shared');
    f.git('update-ref', 'refs/remotes/origin/feature/auth', hash);
    f.git('config', 'branch.feature/auth.remote', 'origin');
    f.git('config', 'branch.feature/auth.merge', 'refs/heads/feature/auth');
    f.git('config', 'remote.origin.url', 'https://example.invalid/repo');
    f.git('config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
    f.git('checkout', 'main');
    const engine = new SearchEngine(f.options, undefined, fakeEmbedder());
    const result = await engine.run('search', { directory: f.repo, search_target: 'diff_branches', query: 'auth' });
    assert.equal(result.num_new_embeddings, 1); assert.equal(result.num_diff_branches, 2);
    assert.deepEqual(new Set(result.results.map(r => r.branch_name)), new Set(['feature/auth', 'feature/shared']));
    const auth = result.results.find(r => r.branch_name === 'feature/auth');
    assert.deepEqual(auth.branch_aliases, ['origin/feature/auth']); assert.equal(auth.matching_commits[0].commit_hash, hash);
    assert.equal(f.git('branch', '--show-current'), 'main');
});

test('cache treats truncated, non-finite, and non-unit vectors as misses', async t => {
    const f = fixture(t); const key = hashText('auth');
    const cache = new EmbeddingCache(f.options.cacheDir, 'unit-test', 3);
    await cache.put(key, new Float32Array([1, 0, 0]));
    const file = path.join(cache.directory, key + '.f32');
    for (const content of [Buffer.from([0]), Buffer.alloc(12), Buffer.from(new Float32Array([NaN, 0, 0]).buffer)]) {
        fs.writeFileSync(file, content);
        assert.equal(await new EmbeddingCache(f.options.cacheDir, 'unit-test', 3).get(key), undefined);
    }
});

test('cancel interrupts embedding, rejects concurrent work, and allows the next search', async t => {
    const f = fixture(t); f.write('auth.js', 'auth'); f.commit('auth');
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    const embedder = { namespace: 'cancel', dimensions: 3, encode: (_, signal) => new Promise((resolve, reject) => {
        started(); signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }) };
    const progress = [];
    const engine = new SearchEngine(f.options, p => progress.push(p), embedder);
    const req = { directory: f.repo, query: 'auth', recent_commit_limit: 100 };
    const search = engine.run('search', req); await ready;
    await assert.rejects(engine.run('search', req), /already running/);
    engine.cancel(); assert.equal((await search).cancelled, true);
    assert.equal(progress.at(-1).active, false);
    assert.equal((await engine.run('search', { ...req, search_mode: 'keyword' })).results.length, 1);
});

test('worker searches with only Git on PATH, restarts after stop, and surfaces errors', async t => {
    const f = fixture(t); f.write('auth.js', 'auth token'); f.commit('auth');
    const bin = path.join(f.root, 'bin'); fs.mkdirSync(bin);
    const gitPath = cp.execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    fs.symlinkSync(gitPath, path.join(bin, 'git'));
    const originalPath = process.env.PATH;
    process.env.PATH = bin;
    const client = new NodeSearchClient(() => f.options);
    try {
        const req = { directory: f.repo, query: 'auth', recent_commit_limit: 100, search_mode: 'keyword' };
        const pending = client.request('search', req);
        await assert.rejects(client.request('search', req), /already running/);
        assert.equal((await pending).results[0].path, 'auth.js');
        await client.stop();
        assert.equal((await client.request('search', req)).results.length, 1);
        await assert.rejects(client.request('search', { ...req, diff_base_ref: 'missing' }));
    } finally { process.env.PATH = originalPath; await client.stop(); client.dispose(); }
});

test('offline model setup fails clearly without network and requires an immutable revision', async t => {
    const f = fixture(t);
    const originalFetch = global.fetch; let calls = 0;
    global.fetch = async () => { calls++; throw new Error('No network allowed'); };
    try {
        await assert.rejects(ensureModelFiles(f.options, () => {}), /missing or corrupt/);
        await assert.rejects(ensureModelFiles({ ...f.options, revision: 'main' }, () => {}), /40-character/);
        assert.equal(calls, 0);
    } finally { global.fetch = originalFetch; }
});

test('cancelled downloads remove temporary files even when cancelling the response stream fails', async t => {
    const f = fixture(t);
    const originalFetch = global.fetch;
    const controller = new AbortController();
    global.fetch = async () => new Response(new ReadableStream({
        pull(stream) { stream.enqueue(new Uint8Array([123, 32])); },
        cancel() { throw new Error('response was already aborted'); },
    }), { headers: { 'content-length': '100' } });
    try {
        await assert.rejects(ensureModelFiles({ ...f.options, modelName: 'test/model', localFilesOnly: false },
            () => controller.abort(new Error('cancelled by test')), controller.signal), /cancelled by test/);
        assert.deepEqual(fs.readdirSync(path.join(f.options.cacheDir, 'models', 'test', 'model', DEFAULT_REVISION)), []);
    } finally { global.fetch = originalFetch; }
});
