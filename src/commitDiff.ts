import { execFile } from 'child_process';
import { realpath } from 'fs/promises';
import * as path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export type CommitFileChange = {
	status: string;
	oldPath?: string;
	newPath?: string;
};

async function git(repo: string, args: string[]): Promise<string> {
	const { stdout } = await execFileAsync('git', args, {
		cwd: repo,
		encoding: 'utf8',
		maxBuffer: 16 * 1024 * 1024,
	});
	return stdout;
}

// -z preserves spaces, tabs, newlines, and non-ASCII names without Git quoting.
function parseNameStatus(output: string): CommitFileChange[] {
	const fields = output.split('\0');
	const changes: CommitFileChange[] = [];
	for (let i = 0; i < fields.length - 1;) {
		const status = fields[i++];
		const firstPath = fields[i++];
		const renamed = status.startsWith('R') || status.startsWith('C');
		const secondPath = renamed ? fields[i++] : firstPath;
		if (!status || !firstPath || !secondPath) {
			throw new Error('Git returned an incomplete changed-file list.');
		}
		changes.push({
			status,
			oldPath: status === 'A' ? undefined : firstPath,
			newPath: status === 'D' ? undefined : secondPath,
		});
	}
	return changes;
}

export async function readCommitChanges(directory: string, commitHash: string, preferredFile = '') {
	if (!/^[0-9a-f]{7,64}$/i.test(commitHash)) {
		throw new Error('A commit hash is required to open the commit diff.');
	}
	const repo = (await git(directory, ['rev-parse', '--show-toplevel'])).trim();
	const resolvedHash = (await git(repo, ['rev-parse', '--verify', `${commitHash}^{commit}`])).trim();
	const info = await git(repo, ['show', '-s', '--no-show-signature', '--format=%H%x00%P%x00%s', resolvedHash, '--']);
	const [hash, parents, subject] = info.trimEnd().split('\0');
	const parent = parents.split(' ')[0] || undefined;
	// Match Git's commit view: compare merges with their first parent; a root
	// commit has no original side. Read all files independently of search filters.
	const output = await git(repo, [
		'diff-tree', '--no-commit-id', '--name-status', '-r', '-z', '-M',
		'--no-ext-diff', '--no-textconv',
		...(parent ? [parent, hash] : ['--root', hash]), '--',
	]);
	const files = parseNameStatus(output);
	// Canonicalize the directory, including macOS /var -> /private/var aliases.
	// The file itself may have been deleted by this commit.
	const preferredDirectory = path.isAbsolute(preferredFile)
		? await realpath(path.dirname(preferredFile)).catch(() => path.dirname(preferredFile))
		: '';
	const preferred = path.isAbsolute(preferredFile)
		? path.relative(repo, path.join(preferredDirectory, path.basename(preferredFile))).split(path.sep).join('/')
		: preferredFile;
	const index = files.findIndex((file) => file.newPath === preferred || file.oldPath === preferred);
	if (index > 0) {
		files.unshift(...files.splice(index, 1));
	}
	return { repo, hash, parent, subject, files };
}
