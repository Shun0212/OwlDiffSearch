import * as path from 'path';
import * as vscode from 'vscode';
import { readCommitChanges } from './commitDiff';

export const OWL_DIFF_SCHEME = 'owl-diff-search';

export function buildGitShowUri(repo: string, ref: string, relPath: string): vscode.Uri {
	const query = new URLSearchParams({ ref, repo, path: relPath }).toString();
	return vscode.Uri.from({ scheme: OWL_DIFF_SCHEME, path: `/${relPath}`, query });
}

export async function openCommitDiff(repo: string, commitHash: string, preferredFile = ''): Promise<void> {
	const commit = await readCommitChanges(repo, commitHash, preferredFile);
	if (!commit.files.length) {
		await vscode.window.showInformationMessage('This commit has no file changes.');
		return;
	}
	const resources = commit.files.map((file): [vscode.Uri, vscode.Uri | undefined, vscode.Uri | undefined] => [
		vscode.Uri.file(path.join(commit.repo, (file.newPath || file.oldPath)!)),
		file.oldPath && commit.parent ? buildGitShowUri(commit.repo, commit.parent, file.oldPath) : undefined,
		file.newPath ? buildGitShowUri(commit.repo, commit.hash, file.newPath) : undefined,
	]);
	const title = `${commit.hash.slice(0, 7)} · ${commit.subject}`;
	// Public command: one native multi-file diff editor, with the matched file first.
	// https://code.visualstudio.com/api/references/commands
	await vscode.commands.executeCommand('vscode.changes', title, resources);
}
