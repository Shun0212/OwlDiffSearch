import { validateGitRef } from '../diffUtils';
import { buildCommitUnits, collectHunks, git } from './git';
import type { Branch, DiffUnit, ReportProgress, SearchRequest } from './types';

export async function collectBranches(req: SearchRequest, report: ReportProgress, signal?: AbortSignal) {
    const rows = await git(req.directory, ['for-each-ref', '--sort=refname',
        '--format=%(refname)%09%(objectname)%09%(symref)%09%(upstream)', 'refs/heads', 'refs/remotes'], signal);
    const refs = new Map<string, { hash: string; upstream: string }>();
    let remoteDefault = '';
    for (const row of rows.trimEnd().split('\n')) {
        const [ref, hash, symbolic, upstream = ''] = row.split('\t');
        if (ref === 'refs/remotes/origin/HEAD') { remoteDefault = symbolic; }
        if (ref && !symbolic) { refs.set(ref, { hash, upstream }); }
    }
    const base = validateGitRef(req.branch_base_ref) || ['refs/heads/main', remoteDefault, 'refs/heads/master',
        'refs/remotes/origin/main', 'refs/remotes/origin/master'].find(ref => refs.has(ref));
    if (!base) { throw new Error('Choose a comparison base for Branches search; no default main/master branch was found.'); }
    const baseHash = (await git(req.directory, ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`], signal)).trim();
    const aliases = new Map<string, string[]>();
    const hidden = new Set<string>();
    const short = (ref: string) => ref.replace(/^refs\/(heads|remotes)\//, '');
    for (const [ref, item] of refs) {
        if (ref.startsWith('refs/heads/') && refs.get(item.upstream)?.hash === item.hash) {
            aliases.set(ref, [short(item.upstream)]); hidden.add(item.upstream);
        }
    }
    const branches: Branch[] = [...refs].filter(([ref, item]) => !hidden.has(ref) && item.hash !== baseHash)
        .map(([ref, item]) => ({ ref, name: short(ref), head_hash: item.hash, aliases: aliases.get(ref) ?? [] }));
    const tips = new Map<string, DiffUnit[]>();
    const hunks = new Map<string, DiffUnit>();
    const units = new Map<string, DiffUnit>();
    let active = 0;
    for (let i = 0; i < branches.length; i++) {
        signal?.throwIfAborted();
        const branch = branches[i];
        report({ active: true, phase: `Reading branch changes: ${branch.name}`, current: i, total: branches.length });
        if (!tips.has(branch.head_hash)) {
            tips.set(branch.head_hash, await collectHunks({ ...req, diff_base_ref: baseHash, diff_head_ref: branch.head_hash,
                branch_ref: '', first_parent: false, recent_commit_limit: 0 }, signal));
        }
        const changes = tips.get(branch.head_hash)!;
        if (!changes.length) { continue; }
        active++;
        branch.commit_count = new Set(changes.map(h => h.commit_hash)).size;
        branch.file_count = new Set(changes.map(h => h.path)).size;
        for (const hunk of changes) { hunks.set(JSON.stringify([hunk.commit_hash, hunk.path, hunk.search_text]), hunk); }
        for (const unit of buildCommitUnits(changes)) {
            const key = JSON.stringify([unit.commit_hash, unit.scored_file_path]);
            if (!units.has(key)) { units.set(key, { ...unit, branch_memberships: [] }); }
            units.get(key)!.branch_memberships!.push(branch);
        }
    }
    return { hunks: [...hunks.values()], units: [...units].sort(([a], [b]) => a.localeCompare(b)).map(([, unit]) => unit),
        metadata: { branch_base_ref: short(base), branch_base_hash: baseHash, num_branches_scanned: branches.length, num_diff_branches: active } };
}

export type RankedResult = DiffUnit & { score: number | null; keyword_match?: boolean };
export function groupBranches(ranked: RankedResult[]): RankedResult[] {
    const branches = new Map<string, RankedResult>();
    for (const result of ranked) {
        for (const branch of result.branch_memberships ?? []) {
            if (!branches.has(branch.ref)) {
                const { branch_memberships: _memberships, ...item } = result;
                branches.set(branch.ref, { ...item, symbol_kind: 'diff_branch', result_type: 'diff_branch', search_unit: 'diff_branch',
                    name: branch.name, function_name: branch.name, branch_name: branch.name, branch_ref: branch.ref,
                    branch_head_hash: branch.head_hash, branch_aliases: branch.aliases, branch_commit_count: branch.commit_count,
                    branch_file_count: branch.file_count, branch_score_aggregation: result.keyword_match ? 'first_matching_file' : 'max_commit_file',
                    matching_commits: [],
                });
            }
            const evidence = branches.get(branch.ref)!.matching_commits as Record<string, unknown>[];
            if (evidence.length < 3 && !evidence.some(entry => entry.commit_hash === result.commit_hash)) {
                const fields = ['commit_hash', 'commit_subject', 'file_path', 'scored_file_path', 'lineno', 'diff_old_path', 'diff_new_path', 'score', 'keyword_match'];
                evidence.push(Object.fromEntries(fields.map(key => [key, result[key]])));
            }
        }
    }
    return [...branches.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.name.localeCompare(b.name));
}
