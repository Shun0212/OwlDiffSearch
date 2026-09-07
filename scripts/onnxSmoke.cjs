// Real ONNX inference, intentionally separate from the offline unit test suite.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { NodeSearchClient } = require('../out/nodeSearch/client');
const { OnnxEmbedder, cosine, tokenizeBatch } = require('../out/nodeSearch/embedding');
const { DEFAULT_MODEL } = require('../out/nodeSearch/types');
const { modelProfile } = require('../out/nodeSearch/models');

async function main() {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'owl-onnx-smoke-repo-'));
    const cacheDir = process.argv[2] || process.env.OWL_ONNX_CACHE_DIR || path.join(os.tmpdir(), 'owl-onnx-smoke-cache');
    const profile = modelProfile(process.argv[3] || DEFAULT_MODEL);
    assert.ok(profile, 'Choose a supported model');
    const options = { cacheDir, modelName: profile.id, revision: profile.revision, dtype: process.argv[4] || 'q8', batchSize: 2,
        localFilesOnly: process.env.OWL_ONNX_OFFLINE === '1' };
    const git = (...args) => cp.execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    let lastPhase = '';
    const progress = p => {
        if (p.active && p.phase !== lastPhase) { lastPhase = p.phase; console.log(p.phase); }
    };
    const client = new NodeSearchClient(() => options);
    client.onProgress = progress;
    try {
        git('init', '-b', 'main'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'ONNX test');
        const changes = [
            ['auth.js', 'Require authentication token', 'export function authenticate(request) {\n  const token = request.headers.authorization;\n  if (!token) throw new Error("Missing authentication token");\n  return verifyToken(token);\n}\n'],
            ['sort.js', 'Sort product prices', 'export function sortPrices(products) {\n  return products.sort((a, b) => a.price - b.price);\n}\n'],
            ['retry.js', 'Retry network requests', 'export async function fetchWithRetry(url, maxRetries = 3) {\n  for (let attempt = 0; attempt < maxRetries; attempt++) {\n    try { return await fetch(url); } catch (error) {\n      if (attempt === maxRetries - 1) throw error;\n    }\n  }\n}\n'],
        ];
        for (const [file, subject, text] of changes) { fs.writeFileSync(path.join(repo, file), text); git('add', file); git('commit', '-m', subject); }
        const request = { directory: repo, recent_commit_limit: 100, search_target: 'diff_commits', search_mode: 'semantic', top_k: 3 };
        const queries = [
            ['reject requests with missing authentication tokens', 'auth.js'],
            ['sort products by price in ascending order', 'sort.js'],
            ['retry failed network requests', 'retry.js'],
        ];
        for (const [query, expected] of queries) {
            const start = Date.now();
            const result = await client.request('search', { ...request, query });
            console.log(JSON.stringify({ query, elapsed_ms: Date.now() - start, reused: result.num_reused_embeddings,
                created: result.num_new_embeddings, ranking: result.results.map(r => ({ file: r.scored_file_path, score: r.score })) }));
            assert.equal(result.results[0].scored_file_path, expected);
            assert.ok(result.results.every(r => Number.isFinite(r.score) && r.score >= -1 && r.score <= 1));
        }
        await client.stop();
        const restarted = await client.request('search', { ...request, query: queries[0][0] });
        assert.equal(restarted.num_new_embeddings, 0);
        assert.equal(restarted.num_reused_embeddings, 3);
        for (const mode of ['keyword', 'bm25']) {
            const negative = await client.request('search', { ...request, search_mode: mode, query: 'unicorn_blockchain_payment_xyz' });
            assert.deepEqual(negative.results, []);
        }
        await client.stop();
        // Validate actual tokenizer boundary and padding behavior against the model.
        const { PreTrainedTokenizer } = await import('@huggingface/transformers');
        const modelDir = path.join(cacheDir, 'models', profile.id, profile.revision);
        const tokenizer = new PreTrainedTokenizer(JSON.parse(fs.readFileSync(path.join(modelDir, 'tokenizer.json'))),
            JSON.parse(fs.readFileSync(path.join(modelDir, 'tokenizer_config.json'))));
        const batch = tokenizeBatch(tokenizer, ['token '.repeat(3000), 'parse JSON']);
        assert.deepEqual(batch.dims, [2, 1024]);
        assert.equal(batch.ids[0], 2n); assert.equal(batch.ids[1023], 3n);
        assert.equal(batch.mask[2047], 0n);
        const embedder = new OnnxEmbedder(options, progress);
        const short = 'parse a JSON string';
        const single = (await embedder.encode([short]))[0];
        const mixed = await embedder.encode([short, 'token '.repeat(3000)]);
        assert.equal(single.length, profile.dimensions);
        assert.ok(cosine(single, mixed[0]) > 0.999);
        assert.ok(Math.abs(cosine(mixed[1], mixed[1]) - 1) < 1e-5);
        console.log(JSON.stringify({ model: profile.id, dtype: options.dtype, dimensions: single.length, padding_cosine: cosine(single, mixed[0]),
            long_input_tokens: batch.dims[1], sep_preserved: true, restart_cache: '3 reused / 0 new', status: 'passed' }));
    } finally {
        await client.stop(); client.dispose();
        fs.rmSync(repo, { recursive: true, force: true });
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
