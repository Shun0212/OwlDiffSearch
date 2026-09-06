export type DiffSearchMode = 'semantic' | 'hybrid' | 'bm25' | 'keyword';
export type DiffSearchTarget = 'diff_hunks' | 'diff_commits' | 'diff_branches';

export const DOCUMENTATION_EXCLUDE_GLOBS = [
	'**/*.md',
	'**/*.mdx',
	'**/*.markdown',
	'**/*.rst',
	'**/*.rest',
	'**/*.adoc',
	'**/*.asciidoc',
	'**/*.org',
	'**/README',
	'**/CHANGELOG',
	'**/CHANGES',
	'**/HISTORY',
	'**/LICENSE',
	'**/NOTICE',
	'**/AUTHORS',
	'**/CONTRIBUTING',
	'**/CODE_OF_CONDUCT',
	'**/SECURITY',
] as const;

export type CommitPage = {
	limit: number;
	offset: number;
};

export function normalizeCommitPage(limitValue: unknown, offsetValue: unknown): CommitPage {
	const requestedLimit = typeof limitValue === 'number' && Number.isFinite(limitValue)
		? Math.floor(limitValue)
		: 200;
	const requestedOffset = typeof offsetValue === 'number' && Number.isFinite(offsetValue)
		? Math.floor(offsetValue)
		: 0;
	return {
		limit: Math.min(1000, Math.max(1, requestedLimit)),
		offset: Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, requestedOffset)),
	};
}

export function normalizeCommitBranchLimit(value: unknown): number {
	const requested = typeof value === 'number' && Number.isFinite(value)
		? Math.floor(value)
		: 5;
	return [0, 1, 3, 5, 10, 20].includes(requested) ? requested : 5;
}

export function normalizeSearchMode(value: unknown): DiffSearchMode {
	return value === 'semantic' || value === 'hybrid' || value === 'bm25' || value === 'keyword'
		? value
		: 'semantic';
}

export function normalizeDiffSearchTarget(value: unknown): DiffSearchTarget {
	return value === 'diff_commits' || value === 'diff_branches' ? value : 'diff_hunks';
}

export function parseGlobPatterns(value: unknown): string[] {
	const rawValues = Array.isArray(value) ? value : [value];
	const patterns: string[] = [];
	for (const rawValue of rawValues) {
		if (typeof rawValue !== 'string') {
			continue;
		}
		for (const part of rawValue.split(/[,\n]/)) {
			let pattern = part.trim().replace(/\\/g, '/');
			if (pattern.startsWith('./')) {
				pattern = pattern.slice(2);
			}
			// A bare extension is a convenient shorthand for every file with it.
			if (/^\.[A-Za-z0-9_+-]+$/.test(pattern)) {
				pattern = `*${pattern}`;
			}
			if (pattern && !patterns.includes(pattern)) {
				patterns.push(pattern);
			}
			if (patterns.length >= 50) {
				return patterns;
			}
		}
	}
	return patterns;
}

export function withDocumentationExcludes(patterns: string[], enabled: boolean): string[] {
	if (!enabled) {
		return [...patterns];
	}
	return [...new Set([...patterns, ...DOCUMENTATION_EXCLUDE_GLOBS])];
}

export function validateGitRef(value: unknown): string {
	const ref = typeof value === 'string' ? value.trim() : '';
	if (!ref) {
		return '';
	}
	if (ref.startsWith('-') || /[\s\0]/.test(ref)) {
		throw new Error(`Unsupported Git ref: ${JSON.stringify(ref)}`);
	}
	return ref;
}

export function shortGitRef(value: string): string {
	return /^[0-9a-f]{12,40}$/i.test(value) ? value.slice(0, 7) : value;
}

export function formatDiffRange(baseRef: string, headRef: string): string {
	const base = shortGitRef(baseRef.trim());
	const head = shortGitRef(headRef.trim());
	if (base && head) {
		return `${base} → ${head}`;
	}
	if (base) {
		return `${base} → HEAD`;
	}
	return 'HEAD → working tree';
}

export function refsForResult(
	commitHash: unknown,
	selectedBaseRef: string,
	selectedHeadRef: string
): { baseRef: string; headRef: string } {
	const hash = typeof commitHash === 'string' ? commitHash.trim() : '';
	if (hash) {
		return { baseRef: `${hash}^`, headRef: hash };
	}
	return { baseRef: selectedBaseRef.trim(), headRef: selectedHeadRef.trim() };
}

export function buildCommitUrl(remoteUrl: string, hash: string): string | undefined {
	let remote = remoteUrl.trim().replace(/\.git$/, '');
	const commitHash = hash.trim();
	if (!remote || !commitHash) {
		return undefined;
	}

	let host = '';
	let repoPath = '';
	const scp = remote.match(/^[^@]+@([^:]+):(.+)$/);
	if (scp) {
		host = scp[1];
		repoPath = scp[2];
	} else {
		const url = remote.match(/^(?:ssh|https?|git):\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/);
		if (url) {
			host = url[1];
			repoPath = url[2];
		}
	}
	if (!host || !repoPath) {
		return undefined;
	}

	host = host.replace(/:\d+$/, '');
	repoPath = repoPath.replace(/^\/+/, '');
	const commitPath = host.toLowerCase().includes('gitlab') ? '-/commit' : 'commit';
	return `https://${host}/${repoPath}/${commitPath}/${commitHash}`;
}
