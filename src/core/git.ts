import {spawn} from 'node:child_process';
import {readdir, realpath} from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const confirmedWorktreeRoots = new Set<string>();

function rootCacheKey(directory: string): string {
	const normalized = path.normalize(directory);
	return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export interface GitCommandResult {
	readonly stdout: Buffer;
	readonly stderr: Buffer;
	readonly exitCode: number;
}

export interface RunGitOptions {
	readonly allowExitCodes?: readonly number[];
	readonly maxOutputBytes?: number;
	readonly signal?: AbortSignal;
}

export interface GitRemote {
	readonly name: string;
	readonly url: string;
}

export interface PullPreflight {
	readonly root: string;
	readonly branch: string;
	readonly upstream: string;
	readonly remoteName: string;
	readonly remoteUrl: string;
}

export interface PullResult extends PullPreflight {
	readonly stdout: string;
	readonly stderr: string;
}

export type PullReadinessReason =
	| 'dirty-worktree'
	| 'detached-head'
	| 'missing-upstream'
	| 'local-upstream'
	| 'missing-upstream-remote'
	| 'remote-url-mismatch';

export class GitCommandError extends Error {
	readonly cwd: string;
	readonly args: readonly string[];
	readonly exitCode: number;
	readonly stdout: Buffer;
	readonly stderr: Buffer;

	constructor(
		cwd: string,
		args: readonly string[],
		result: GitCommandResult,
		message = `Git command failed with exit code ${result.exitCode}`,
	) {
		const detail = result.stderr.toString('utf8').trim();
		super(detail.length > 0 ? `${message}: ${detail}` : message);
		this.name = 'GitCommandError';
		this.cwd = cwd;
		this.args = [...args];
		this.exitCode = result.exitCode;
		this.stdout = result.stdout;
		this.stderr = result.stderr;
	}
}

export class GitRepositoryNotFoundError extends Error {
	readonly startPath: string;

	constructor(startPath: string) {
		super(`No Git worktree was found from ${startPath}`);
		this.name = 'GitRepositoryNotFoundError';
		this.startPath = startPath;
	}
}

export class PullPreflightError extends Error {
	readonly reason: PullReadinessReason;

	constructor(reason: PullReadinessReason, message: string) {
		super(message);
		this.name = 'PullPreflightError';
		this.reason = reason;
	}
}

/**
 * Run Git without invoking a shell. stdout and stderr are returned as buffers so
 * callers can safely consume NUL-delimited plumbing output.
 */
export async function runGit(
	cwd: string,
	args: readonly string[],
	options: RunGitOptions = {},
): Promise<GitCommandResult> {
	const allowedExitCodes = new Set(options.allowExitCodes ?? [0]);
	const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

	if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
		throw new RangeError('maxOutputBytes must be a positive safe integer');
	}

	return new Promise<GitCommandResult>((resolve, reject) => {
		const child = spawn('git', [...args], {
			cwd,
			env: {
				...process.env,
				GIT_TERMINAL_PROMPT: '0',
				LC_ALL: 'C',
			},
			shell: false,
			signal: options.signal,
			stdio: ['ignore', 'pipe', 'pipe'],
			windowsHide: true,
		});

		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		let outputBytes = 0;
		let outputLimitError: Error | undefined;

		const collect = (target: Buffer[]) => (chunk: Buffer) => {
			outputBytes += chunk.length;
			if (outputBytes > maxOutputBytes && outputLimitError === undefined) {
				outputLimitError = new Error(
					`Git output exceeded the ${maxOutputBytes} byte safety limit`,
				);
				child.kill();
				return;
			}

			if (outputLimitError === undefined) {
				target.push(chunk);
			}
		};

		child.stdout.on('data', collect(stdoutChunks));
		child.stderr.on('data', collect(stderrChunks));
		child.once('error', reject);
		child.once('close', (code, signal) => {
			if (outputLimitError !== undefined) {
				reject(outputLimitError);
				return;
			}

			const result: GitCommandResult = {
				stdout: Buffer.concat(stdoutChunks),
				stderr: Buffer.concat(stderrChunks),
				exitCode: code ?? (signal === null ? 1 : 128),
			};

			if (!allowedExitCodes.has(result.exitCode)) {
				reject(new GitCommandError(cwd, args, result));
				return;
			}

			resolve(result);
		});
	});
}

async function canonicalDirectory(directory: string): Promise<string> {
	return realpath(path.resolve(directory));
}

function text(result: GitCommandResult): string {
	return result.stdout.toString('utf8').trim();
}

function nulDelimited(buffer: Buffer): string[] {
	const value = buffer.toString('utf8');
	if (value.length === 0) {
		return [];
	}

	const items = value.split('\0');
	if (items.at(-1) === '') {
		items.pop();
	}

	return items;
}

function compareGitPaths(left: string, right: string): number {
	return Buffer.from(left).compare(Buffer.from(right));
}

/**
 * Resolve a path inside a worktree to the canonical top-level worktree path.
 */
export async function findGitRoot(startPath: string): Promise<string> {
	const canonicalStart = await canonicalDirectory(startPath);
	if (confirmedWorktreeRoots.has(rootCacheKey(canonicalStart))) {
		return canonicalStart;
	}
	const result = await runGit(
		canonicalStart,
		['rev-parse', '--path-format=absolute', '--show-toplevel'],
		{allowExitCodes: [0, 128]},
	);

	if (result.exitCode !== 0 || text(result).length === 0) {
		throw new GitRepositoryNotFoundError(canonicalStart);
	}

	const root = await canonicalDirectory(text(result));
	confirmedWorktreeRoots.add(rootCacheKey(root));
	return root;
}

/**
 * Return true only when `directory` is the root of a non-bare Git worktree.
 */
export async function isGitWorkTree(directory: string): Promise<boolean> {
	let canonical: string;
	try {
		canonical = await canonicalDirectory(directory);
	} catch {
		return false;
	}

	const result = await runGit(
		canonical,
		['rev-parse', '--is-inside-work-tree', '--show-toplevel'],
		{allowExitCodes: [0, 128]},
	);
	if (result.exitCode !== 0) {
		return false;
	}

	const lines = text(result).split(/\r?\n/u);
	if (lines[0] !== 'true' || lines[1] === undefined) {
		return false;
	}

	const isRoot =
		path.normalize(await canonicalDirectory(lines[1])) === path.normalize(canonical);
	if (isRoot) {
		confirmedWorktreeRoots.add(rootCacheKey(canonical));
	}
	return isRoot;
}

/**
 * Discover worktree roots beneath `searchRoot`. Symlinked/junction directories
 * and Git administrative directories are deliberately not traversed.
 */
export async function discoverGitRepositories(searchRoot: string): Promise<string[]> {
	const canonicalSearchRoot = await canonicalDirectory(searchRoot);
	const repositories: string[] = [];

	const visit = async (directory: string): Promise<void> => {
		const entries = await readdir(directory, {withFileTypes: true});
		const hasGitMarker = entries.some(entry => entry.name === '.git');
		if (hasGitMarker && (await isGitWorkTree(directory))) {
			repositories.push(await canonicalDirectory(directory));
		}

		const childDirectories = entries
			.filter(entry => entry.name !== '.git' && entry.isDirectory() && !entry.isSymbolicLink())
			.sort((left, right) => left.name.localeCompare(right.name));

		for (const entry of childDirectories) {
			await visit(path.join(directory, entry.name));
		}
	};

	await visit(canonicalSearchRoot);
	return [...new Set(repositories)].sort((left, right) => left.localeCompare(right));
}

/**
 * List configured remote fetch URLs. A remote with multiple URLs yields one
 * entry per URL so callers can present every concrete repository choice.
 */
export async function getRemotes(repoRoot: string): Promise<GitRemote[]> {
	const root = await findGitRoot(repoRoot);
	const namesResult = await runGit(root, ['remote']);
	const names = text(namesResult)
		.split(/\r?\n/u)
		.map(name => name.trim())
		.filter(Boolean)
		.sort((left, right) => left.localeCompare(right));
	const remoteGroups = await Promise.all(names.map(async name => {
		const result = await runGit(root, ['remote', 'get-url', '--all', name], {
			allowExitCodes: [0, 2, 128],
		});
		if (result.exitCode !== 0) {
			return [];
		}
		return result.stdout
			.toString('utf8')
			.split(/\r?\n/u)
			.filter(Boolean)
			.map(url => ({name, url}));
	}));

	return remoteGroups.flat();
}

/**
 * Return every path currently in the Git index. Paths are repository-relative,
 * use Git's `/` separator, and are sorted bytewise for deterministic consumers.
 */
export async function getTrackedFiles(repoRoot: string): Promise<string[]> {
	const root = await findGitRoot(repoRoot);
	const result = await runGit(root, ['ls-files', '--cached', '-z']);
	return nulDelimited(result.stdout).sort(compareGitPaths);
}

export async function getTrackedFileSet(repoRoot: string): Promise<ReadonlySet<string>> {
	return new Set(await getTrackedFiles(repoRoot));
}

/**
 * Tracked cleanliness intentionally ignores untracked/ignored payload files.
 */
export async function hasCleanTrackedWorktree(repoRoot: string): Promise<boolean> {
	const root = await findGitRoot(repoRoot);
	const result = await runGit(root, [
		'status',
		'--porcelain=v1',
		'--untracked-files=no',
		'-z',
	]);
	return result.stdout.length === 0;
}

export async function getCurrentBranch(repoRoot: string): Promise<string | undefined> {
	const root = await findGitRoot(repoRoot);
	const result = await runGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
		allowExitCodes: [0, 1, 128],
	});
	const branch = text(result);
	return result.exitCode === 0 && branch.length > 0 ? branch : undefined;
}

export async function getUpstream(repoRoot: string): Promise<string | undefined> {
	const root = await findGitRoot(repoRoot);
	const result = await runGit(
		root,
		['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
		{allowExitCodes: [0, 128]},
	);
	const upstream = text(result);
	return result.exitCode === 0 && upstream.length > 0 ? upstream : undefined;
}

/**
 * Validate every condition that must hold before a remote-backed pull.
 */
export async function inspectPullPreflight(
	repoRoot: string,
	expectedRemoteUrl: string,
): Promise<PullPreflight> {
	const root = await findGitRoot(repoRoot);

	const [isClean, branch, upstream] = await Promise.all([
		hasCleanTrackedWorktree(root),
		getCurrentBranch(root),
		getUpstream(root),
	]);

	if (!isClean) {
		throw new PullPreflightError(
			'dirty-worktree',
			'Tracked worktree changes must be committed or stashed before pulling',
		);
	}

	if (branch === undefined) {
		throw new PullPreflightError(
			'detached-head',
			'The current worktree has a detached HEAD; check out a branch before pulling',
		);
	}

	if (upstream === undefined) {
		throw new PullPreflightError(
			'missing-upstream',
			`Branch ${branch} has no configured upstream`,
		);
	}

	const [remoteResult, remotes] = await Promise.all([
		runGit(root, ['config', '--get', `branch.${branch}.remote`], {
			allowExitCodes: [0, 1],
		}),
		getRemotes(root),
	]);
	const remoteName = text(remoteResult);
	if (remoteResult.exitCode !== 0 || remoteName.length === 0) {
		throw new PullPreflightError(
			'missing-upstream-remote',
			`Branch ${branch} has no configured upstream remote`,
		);
	}
	if (remoteName === '.') {
		throw new PullPreflightError(
			'local-upstream',
			`Branch ${branch} tracks a local branch, not a remote repository`,
		);
	}

	const matchingRemoteUrls = remotes
		.filter(remote => remote.name === remoteName)
		.map(remote => remote.url);
	if (matchingRemoteUrls.length === 0) {
		throw new PullPreflightError(
			'missing-upstream-remote',
			`Upstream remote ${remoteName} has no fetch URL`,
		);
	}

	if (!matchingRemoteUrls.includes(expectedRemoteUrl)) {
		throw new PullPreflightError(
			'remote-url-mismatch',
			`Upstream remote ${remoteName} does not match remote-repo.txt`,
		);
	}

	return {
		root,
		branch,
		upstream,
		remoteName,
		remoteUrl: expectedRemoteUrl,
	};
}

export const assertPullReady = inspectPullPreflight;

/**
 * Re-run the preflight immediately before invoking a non-interactive
 * fast-forward-only pull.
 */
export async function pullFastForward(
	repoRoot: string,
	expectedRemoteUrl: string,
): Promise<PullResult> {
	const preflight = await inspectPullPreflight(repoRoot, expectedRemoteUrl);
	const upstreamPrefix = `${preflight.remoteName}/`;
	const upstreamBranch = preflight.upstream.startsWith(upstreamPrefix)
		? preflight.upstream.slice(upstreamPrefix.length)
		: preflight.branch;
	const result = await runGit(preflight.root, [
		'pull',
		'--ff-only',
		expectedRemoteUrl,
		upstreamBranch,
	]);
	return {
		...preflight,
		stdout: result.stdout.toString('utf8'),
		stderr: result.stderr.toString('utf8'),
	};
}
