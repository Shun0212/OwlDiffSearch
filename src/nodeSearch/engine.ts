import { normalizeDiffSearchTarget, normalizeSearchMode } from '../diffUtils';
import { collectBranches, groupBranches, RankedResult } from './branches';
import { cosine, Embedder, EmbeddingCache, hashText, OnnxEmbedder } from './embedding';
import { buildCommitUnits, collectHunks } from './git';
import type { DiffUnit, EngineOptions, ReportProgress, SearchRequest } from './types';

export function bm25(texts: string[], query: string): Map<number, number> {
    const tokens = (text: string) => (text.match(/[A-Za-z_][A-Za-z0-9_]*|\d+/g) || []).map(token => token.toLowerCase());
    const docs = texts.map(tokens);
    const queryTokens = tokens(query);
    const dfs = new Map<string, number>();
    const frequencies = docs.map(doc => {
        const tf = new Map<string, number>();
        for (const token of doc) { tf.set(token, (tf.get(token) || 0) + 1); }
        for (const token of tf.keys()) { dfs.set(token, (dfs.get(token) || 0) + 1); }
        return tf;
    });
    const average = docs.reduce((sum, doc) => sum + doc.length, 0) / docs.length;
    const scores = new Map<number, number>();
    if (!average) { return scores; }
    frequencies.forEach((tf, i) => {
        let score = 0;
        for (const token of queryTokens) {
            const frequency = tf.get(token) || 0;
            if (!frequency) { continue; }
            const df = dfs.get(token)!;
            const idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
            score += idf * frequency * 2.5 / (frequency + 1.5 * (0.25 + 0.75 * docs[i].length / average));
        }
        if (score > 0) { scores.set(i, score); }
    });
    const values = [...scores.values()];
    const min = values.reduce((a, b) => Math.min(a, b), Infinity);
    const max = values.reduce((a, b) => Math.max(a, b), -Infinity);
    return new Map([...scores].map(([i, value]) => [i, max <= min ? 1 : (value - min) / (max - min)]));
}

export class SearchEngine {
    private readonly embedder: Embedder;
    private readonly cache: EmbeddingCache;
    private active?: AbortController;
    constructor(private readonly options: EngineOptions, private readonly report: ReportProgress = () => {}, embedder?: Embedder) {
        this.embedder = embedder ?? new OnnxEmbedder(options, report);
        this.cache = new EmbeddingCache(options.cacheDir, this.embedder.namespace, this.embedder.dimensions);
    }

    cancel() { this.active?.abort(new Error('Indexing / embedding cancelled.')); }

    async run(operation: 'prepare' | 'search' | 'load', req?: SearchRequest): Promise<Record<string, unknown>> {
        if (this.active) { throw new Error('A search is already running. Wait for it to finish or cancel it.'); }
        const controller = this.active = new AbortController();
        try {
            if (operation === 'load') { await this.embedder.load?.(controller.signal); controller.signal.throwIfAborted(); return { ready: true }; }
            if (!req?.directory) { throw new Error('A Git repository directory is required.'); }
            if (operation === 'search' && !req.query?.trim()) { throw new Error('Enter a search query.'); }
            return await this.search(req, operation === 'prepare', controller.signal);
        } catch (error) {
            if (controller.signal.aborted) { return { cancelled: true, message: 'Indexing / embedding cancelled.', results: [] }; }
            throw error;
        } finally {
            this.active = undefined;
            this.report({ active: false, phase: '', current: 0, total: 0 });
        }
    }

    private async search(req: SearchRequest, prepareOnly: boolean, signal: AbortSignal): Promise<Record<string, unknown>> {
        const target = normalizeDiffSearchTarget(req.search_target);
        const mode = normalizeSearchMode(req.search_mode);
        const started = Date.now();
        this.report({ active: true, phase: 'Loading Git changes', current: 0, total: 1 });
        let hunks: DiffUnit[];
        let units: DiffUnit[];
        let branchMetadata: Record<string, unknown> = {};
        if (target === 'diff_branches') {
            const branches = await collectBranches(req, this.report, signal);
            ({ hunks, units } = branches); branchMetadata = branches.metadata;
        } else {
            hunks = await collectHunks(req, signal);
            units = target === 'diff_commits' ? buildCommitUnits(hunks) : hunks;
        }
        signal.throwIfAborted();
        const buildMs = Date.now() - started;
        const vectors = new Map<string, Float32Array>();
        const unique = new Map(units.map(unit => [hashText(unit.search_text), unit.search_text]));
        let reused = 0;
        let created = 0;
        const needsEmbeddings = mode === 'semantic' || mode === 'hybrid';
        const embeddingStart = Date.now();
        if (needsEmbeddings && units.length) {
            const missing: [string, string][] = [];
            for (const [key, text] of unique) {
                signal.throwIfAborted();
                const vector = await this.cache.get(key);
                if (vector) { vectors.set(key, vector); reused++; }
                else { missing.push([key, text]); }
            }
            const batchSize = Math.max(1, Math.min(32, Math.floor(this.options.batchSize) || 2));
            for (let i = 0; i < missing.length; i += batchSize) {
                signal.throwIfAborted();
                this.report({ active: true, phase: 'Embedding', current: i, total: missing.length, elapsed: (Date.now() - embeddingStart) / 1000 });
                const batch = missing.slice(i, i + batchSize);
                const encoded = await this.embedder.encode(batch.map(([, text]) => text), signal);
                if (encoded.length !== batch.length) { throw new Error('The model returned an incomplete embedding batch.'); }
                signal.throwIfAborted();
                for (let j = 0; j < batch.length; j++) {
                    vectors.set(batch[j][0], encoded[j]);
                    await this.cache.put(batch[j][0], encoded[j]); created++;
                }
                const current = i + batch.length;
                const elapsed = (Date.now() - embeddingStart) / 1000;
                this.report({ active: true, phase: 'Embedding', current, total: missing.length, elapsed,
                    eta: elapsed / current * (missing.length - current) });
            }
        }
        const metadata = {
            search_target: target, search_mode: mode, num_diff_hunks: hunks.length, num_diff_units: units.length,
            num_diff_commits: new Set(hunks.map(hunk => hunk.commit_hash)).size, num_files: new Set(hunks.map(hunk => hunk.path)).size,
            num_new_embeddings: created, num_reused_embeddings: reused, diff_embedding_cache_hit: needsEmbeddings && reused > 0 && !created,
            diff_embedding_cache_source: !needsEmbeddings ? 'not_required' : !units.length ? 'empty' : !created ? 'units' : reused ? 'incremental' : 'fresh',
            diff_hunk_build_ms: buildMs, index_embedding_ms: Date.now() - embeddingStart,
            diff_base_ref: req.diff_base_ref || '', diff_head_ref: req.branch_ref || req.diff_head_ref || '',
            branch_ref: req.branch_ref || '', first_parent: !!req.first_parent,
            backend: 'node-onnx', model_dtype: this.options.dtype, model_name: this.options.modelName,
            model_revision: this.options.revision, embedding_dimensions: this.embedder.dimensions, ...branchMetadata,
        };
        if (prepareOnly) { return metadata; }
        if (!units.length) { return { ...metadata, results: [], message: 'No searchable changes found in the selected range.' }; }
        this.report({ active: true, phase: 'Loading query embedding / ranking', current: 0, total: 1 });
        const query = req.query!.trim();
        const queryVector = needsEmbeddings ? (await this.embedder.encode([query], signal))[0] : undefined;
        signal.throwIfAborted();
        const lexical = mode === 'bm25' || mode === 'hybrid' ? bm25(units.map(unit => unit.search_text), query) : new Map<number, number>();
        const keywords = query.toLowerCase().split(/\s+/).filter(Boolean);
        let ranked: RankedResult[] = [];
        units.forEach((unit, index) => {
            if (mode === 'keyword' && !keywords.every(word => unit.search_text.toLowerCase().includes(word))) { return; }
            // A lexical no-match must remain empty instead of displaying arbitrary zero-score results.
            if (mode === 'bm25' && !lexical.has(index)) { return; }
            const semantic = queryVector ? cosine(queryVector, vectors.get(hashText(unit.search_text))!) : 0;
            const bm25Score = lexical.get(index) || 0;
            const score = mode === 'keyword' ? null : mode === 'semantic' ? semantic : mode === 'bm25' ? bm25Score : 0.6 * semantic + 0.4 * bm25Score;
            ranked.push({ ...unit, score, search_mode: mode, search_target: target,
                similarity: mode === 'bm25' ? bm25Score : semantic, semantic_similarity: semantic,
                bm25_score: bm25Score, hybrid_score: score, distance: queryVector ? 1 - semantic : null,
                distance_metric: queryVector ? 'cosine' : null,
                ...(mode === 'keyword' ? { keyword_match: true, matched_keywords: keywords, commit_score_aggregation: 'first_matching_file' } : {}),
            });
        });
        ranked.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
        if (target === 'diff_commits') {
            const seen = new Set<string>();
            ranked = ranked.filter(item => { if (seen.has(item.commit_hash)) { return false; } seen.add(item.commit_hash); return true; });
        } else if (target === 'diff_branches') { ranked = groupBranches(ranked); }
        const topK = Math.max(0, Math.min(1000, Math.floor(req.top_k ?? 30)));
        return { ...metadata, results: ranked.slice(0, topK).map((result, i) => ({ ...result, rank: i + 1 })), semantic_weight: 0.6 };
    }
}
