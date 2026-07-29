import {execFile} from 'node:child_process';
import {
	mkdtemp,
	mkdir,
	readFile,
	realpath,
	rm,
	symlink,
	unlink,
	writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {afterEach, describe, expect, it} from 'vitest';
import {
	GitCommandError,
	GitRepositoryNotFoundError,
	PullPreflightError,
	discoverGitRepositories,
	findGitRoot,
	getCurrentBranch,
	getRemotes,
	getTrackedFileSet,
	getTrackedFiles,
	getUpstream,
	hasCleanTrackedWorktree,
	inspectPullPreflight,
	isGitWorkTree,
	pullFastForward,
	runGit,
} from '../src/core/git.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function tempDirectory(label: string): Promise<string> {
	const directory = await realpath(
		await mkdtemp(path.join(tmpdir(), `repo-lib-${label}-`)),
	);
	temporaryDirectories.push(directory);
	return directory;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
	const result = await execFileAsync(
		'git',
		['-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false', ...args],
		{
		cwd,
		encoding: 'utf8',
		env: {
			...process.env,
			GIT_AUTHOR_NAME: 'Repo Lib Tests',
			GIT_AUTHOR_EMAIL: 'test@example.com',
			GIT_COMMITTER_NAME: 'Repo Lib Tests',
			GIT_COMMITTER_EMAIL: 'test@example.com',
			GIT_TERMINAL_PROMPT: '0',
		},
		},
	);
	return result.stdout.trim();
}

async function initializeRepository(directory: string): Promise<void> {
	await mkdir(directory, {recursive: true});
	await git(directory, 'init', '--initial-branch=main');
}

async function commitFile(
	directory: string,
	filename: string,
	contents: string | Buffer,
	message = filename,
): Promise<void> {
	const destination = path.join(directory, filename);
	await mkdir(path.dirname(destination), {recursive: true});
	await writeFile(destination, contents);
	await git(directory, 'add', '--', filename);
	await git(directory, 'commit', '-m', message);
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.map(async directory => {
			await rm(directory, {
				force: true,
				maxRetries: 3,
				recursive: true,
				retryDelay: 50,
			});
		}),
	);
	temporaryDirectories.length = 0;
});

describe('repository inspection', () => {
	it('finds and canonicalizes the root from a nested directory', async () => {
		const root = await tempDirectory('root with spaces');
		await initializeRepository(root);
		const nested = path.join(root, 'nested', 'deeper');
		await mkdir(nested, {recursive: true});

		expect(await findGitRoot(nested)).toBe(await findGitRoot(root));
		expect(await isGitWorkTree(root)).toBe(true);
		expect(await isGitWorkTree(nested)).toBe(false);
	});

	it('throws a typed error outside a repository', async () => {
		const directory = await tempDirectory('not-repo');
		await expect(findGitRoot(directory)).rejects.toBeInstanceOf(
			GitRepositoryNotFoundError,
		);
	});

	it('captures command failures without using a shell', async () => {
		const directory = await tempDirectory('command');
		await initializeRepository(directory);
		const metacharacter = 'file; echo should-not-run';

		await expect(runGit(directory, ['add', '--', metacharacter])).rejects.toMatchObject({
			name: 'GitCommandError',
			args: ['add', '--', metacharacter],
		});
		await expect(
			runGit(directory, ['definitely-not-a-command']),
		).rejects.toBeInstanceOf(GitCommandError);
	});

	it('supports expected non-zero exits and enforces output limits', async () => {
		const directory = await tempDirectory('run-options');
		await initializeRepository(directory);

		const expectedFailure = await runGit(
			directory,
			['rev-parse', '--verify', 'missing-reference'],
			{allowExitCodes: [128]},
		);
		expect(expectedFailure.exitCode).toBe(128);
		await expect(
			runGit(directory, ['status'], {maxOutputBytes: 0}),
		).rejects.toBeInstanceOf(RangeError);
		await expect(
			runGit(directory, ['help', '-a'], {maxOutputBytes: 1}),
		).rejects.toThrow('output exceeded');
	});

	it('lists every remote fetch URL in deterministic order', async () => {
		const root = await tempDirectory('remotes');
		await initializeRepository(root);
		await git(root, 'remote', 'add', 'zeta', 'https://example.test/zeta.git');
		await git(root, 'remote', 'add', 'alpha', 'https://example.test/alpha.git');
		await git(root, 'remote', 'set-url', '--add', 'alpha', 'ssh://example.test/alpha.git');

		expect(await getRemotes(root)).toEqual([
			{name: 'alpha', url: 'https://example.test/alpha.git'},
			{name: 'alpha', url: 'ssh://example.test/alpha.git'},
			{name: 'zeta', url: 'https://example.test/zeta.git'},
		]);
	});

	it('returns an empty remote and tracked-file collection for a new repository', async () => {
		const root = await tempDirectory('empty');
		await initializeRepository(root);

		expect(await getRemotes(root)).toEqual([]);
		expect(await getTrackedFiles(root)).toEqual([]);
		expect(await getTrackedFileSet(root)).toEqual(new Set());
		expect(await isGitWorkTree(path.join(root, 'missing'))).toBe(false);
		expect(await isGitWorkTree(await tempDirectory('outside'))).toBe(false);
	});

	it('returns all index entries including staged-new and deleted files', async () => {
		const root = await tempDirectory('tracked-ü');
		await initializeRepository(root);
		await commitFile(root, 'z.txt', 'z');
		await commitFile(root, 'nested/é.txt', 'unicode');
		await writeFile(path.join(root, 'new.txt'), 'new');
		await git(root, 'add', 'new.txt');
		await writeFile(path.join(root, '.env'), 'secret');
		await unlink(path.join(root, 'z.txt'));

		expect(await getTrackedFiles(root)).toEqual(['nested/é.txt', 'new.txt', 'z.txt']);
	});

	it('discovers parent, nested, and .git-file worktrees but skips symlinks', async () => {
		const search = await tempDirectory('discover');
		await initializeRepository(search);
		await commitFile(search, 'root.txt', 'root');
		const nested = path.join(search, 'packages', 'nested');
		await initializeRepository(nested);
		const worktree = path.join(search, 'linked-worktree');
		await git(search, 'worktree', 'add', '--detach', worktree, 'HEAD');

		const external = await tempDirectory('external');
		await initializeRepository(external);
		const linked = path.join(search, 'linked');
		let symlinkCreated = true;
		try {
			await symlink(external, linked, process.platform === 'win32' ? 'junction' : 'dir');
		} catch {
			symlinkCreated = false;
		}

		const repositories = await discoverGitRepositories(search);
		expect(repositories).toContain(await findGitRoot(search));
		expect(repositories).toContain(await findGitRoot(nested));
		expect(repositories).toContain(await findGitRoot(worktree));
		if (symlinkCreated) {
			expect(repositories).not.toContain(await findGitRoot(external));
		}
	});
});

describe('pull preflight and execution', () => {
	async function createRemoteFixture(): Promise<{
		bare: string;
		primary: string;
		secondary: string;
	}> {
		const fixtureRoot = await tempDirectory('pull');
		const bare = path.join(fixtureRoot, 'remote.git');
		const primary = path.join(fixtureRoot, 'primary');
		const secondary = path.join(fixtureRoot, 'secondary');
		await mkdir(bare);
		await git(bare, 'init', '--bare', '--initial-branch=main');
		await initializeRepository(primary);
		await commitFile(primary, 'tracked.txt', 'one\n');
		await git(primary, 'remote', 'add', 'origin', bare);
		await git(primary, 'push', '-u', 'origin', 'main');
		await git(fixtureRoot, 'clone', '-c', 'core.autocrlf=false', bare, secondary);
		return {bare, primary, secondary};
	}

	it('ignores untracked payload while detecting tracked dirtiness', async () => {
		const {bare, secondary} = await createRemoteFixture();
		await writeFile(path.join(secondary, '.env'), 'secret');

		expect(await hasCleanTrackedWorktree(secondary)).toBe(true);
		expect(await getCurrentBranch(secondary)).toBe('main');
		expect(await getUpstream(secondary)).toBe('origin/main');
		expect(await inspectPullPreflight(secondary, bare)).toMatchObject({
			branch: 'main',
			upstream: 'origin/main',
			remoteName: 'origin',
			remoteUrl: bare,
		});

		await writeFile(path.join(secondary, 'tracked.txt'), 'dirty\n');
		expect(await hasCleanTrackedWorktree(secondary)).toBe(false);
		await expect(inspectPullPreflight(secondary, bare)).rejects.toMatchObject({
			reason: 'dirty-worktree',
		});
	});

	it('rejects detached HEAD, missing upstream, and URL mismatch', async () => {
		const {bare, secondary} = await createRemoteFixture();

		await expect(
			inspectPullPreflight(secondary, 'https://wrong.example/repository.git'),
		).rejects.toMatchObject({reason: 'remote-url-mismatch'});

		await git(secondary, 'checkout', '--detach');
		await expect(inspectPullPreflight(secondary, bare)).rejects.toMatchObject({
			reason: 'detached-head',
		});

		await git(secondary, 'checkout', '-b', 'no-upstream');
		await expect(inspectPullPreflight(secondary, bare)).rejects.toMatchObject({
			reason: 'missing-upstream',
		});
	});

	it('rejects an upstream that is another local branch', async () => {
		const root = await tempDirectory('local-upstream');
		await initializeRepository(root);
		await commitFile(root, 'tracked.txt', 'tracked');
		await git(root, 'checkout', '-b', 'topic');
		await git(root, 'branch', '--set-upstream-to=main');

		expect(await getUpstream(root)).toBe('main');
		await expect(inspectPullPreflight(root, 'anything')).rejects.toMatchObject({
			reason: 'local-upstream',
		});
	});

	it('pulls a remote update with --ff-only', async () => {
		const {bare, primary, secondary} = await createRemoteFixture();
		await commitFile(primary, 'tracked.txt', 'two\n', 'second');
		await git(primary, 'push');

		const result = await pullFastForward(secondary, bare);
		expect(result.branch).toBe('main');
		expect(await readFile(path.join(secondary, 'tracked.txt'), 'utf8')).toBe('two\n');
	});

	it('surfaces non-fast-forward pull failures as GitCommandError', async () => {
		const {bare, primary, secondary} = await createRemoteFixture();
		await commitFile(primary, 'upstream.txt', 'remote\n');
		await git(primary, 'push');
		await commitFile(secondary, 'local.txt', 'local\n');

		await expect(pullFastForward(secondary, bare)).rejects.toBeInstanceOf(GitCommandError);
	});

	it('exposes stable typed preflight errors', () => {
		const error = new PullPreflightError('missing-upstream', 'missing');
		expect(error).toMatchObject({
			name: 'PullPreflightError',
			reason: 'missing-upstream',
			message: 'missing',
		});
	});
});
