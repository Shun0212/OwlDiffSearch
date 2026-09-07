import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export function createCommitDiffFixture() {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'owl-commit-diff-'));
	const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
	const write = (file: string, content: string) => fs.writeFileSync(path.join(repo, file), content);
	git('init', '-q', '-b', 'main');
	git('config', 'user.name', 'Diff Test');
	git('config', 'user.email', 'diff-test@example.invalid');
	git('config', 'commit.gpgsign', 'false');
	git('config', 'core.hooksPath', '/dev/null');
	const preferredFile = process.platform === 'win32' ? 'matched #%.py' : 'matched #?.py';
	const unicodeFile = process.platform === 'win32' ? 'space 日本語.txt' : 'tab\t日本語.txt';
	write(preferredFile, 'timeout = 1\n');
	write('remove.txt', 'removed content\n');
	write('old name.txt', 'renamed content\n');
	write('README.md', 'old documentation\n');
	git('add', '.');
	git('commit', '-qm', 'Initial files');
	const parent = git('rev-parse', 'HEAD');
	write(preferredFile, 'timeout = 10\n');
	write('README.md', 'new documentation\n');
	fs.unlinkSync(path.join(repo, 'remove.txt'));
	fs.renameSync(path.join(repo, 'old name.txt'), path.join(repo, 'new name.txt'));
	write('added.txt', 'added content\n');
	write(unicodeFile, 'non-ASCII filename\n');
	git('add', '-A');
	git('commit', '-qm', 'Update requests and related files');
	const hash = git('rev-parse', 'HEAD');
	return { repo, git, write, parent, hash, preferredFile, unicodeFile, dispose: () => fs.rmSync(repo, { recursive: true, force: true }) };
}
