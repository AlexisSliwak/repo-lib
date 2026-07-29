import {randomUUID} from 'node:crypto';
import {
	lstat,
	mkdir,
	readdir,
	rename,
	rmdir,
	rm,
} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import {
	type ConfigPathOptions,
	type RepoLibConfig,
	assertConfiguredRootsExist,
	canonicalizePath,
	createConfig,
	isPathInside,
	loadConfig,
	saveConfig,
} from './config.js';
import {CancelledError, RepoLibError} from './errors.js';
import {
	collectSelectedFiles,
	copyFileAtomic,
	crossesNestedGitWorktree,
	fileSize,
	filesEqual,
	fromPortablePath,
	isReservedPayloadPath,
	removeTrackedLibraryPaths,
	walkRegularFiles,
} from './filesystem.js';
import {
	discoverGitRepositories,
	findGitRoot,
	getRemotes,
	getTrackedFileSet,
	pullFastForward,
	runGit,
	type GitRemote,
} from './git.js';
import {readRemoteMarker, writeRemoteMarker} from './markers.js';
import {
	getNestedProjects,
	isRegisteredProject,
	projectPaths,
	relativeProjectPath,
	resolveCurrentProject,
	type ProjectContext,
} from './projects.js';

export interface SelectOption {
	label: string;
	value: string;
}

export interface WorkflowUi {
	text(message: string, placeholder?: string): Promise<string>;
	select(message: string, options: readonly SelectOption[]): Promise<string>;
	confirm(message: string): Promise<boolean>;
	info(message: string): void;
	warn(message: string): void;
	success(message: string): void;
	busy<T>(message: string, operation: () => Promise<T>): Promise<T>;
}

export interface WorkflowOptions extends ConfigPathOptions {
	cwd?: string;
}

export interface SyncSummary {
	copied: string[];
	removed: string[];
	skipped: string[];
}

interface ActiveProject {
	config: RepoLibConfig;
	context: ProjectContext;
	remoteUrl?: string;
	remotes: GitRemote[];
	trackedFiles?: ReadonlySet<string>;
}

function expandHome(input: string): string {
	const trimmed = input.trim();
	if (trimmed === '~') {
		return homedir();
	}
	if (trimmed.startsWith(`~${path.sep}`) || trimmed.startsWith('~/')) {
		return path.join(homedir(), trimmed.slice(2));
	}
	return trimmed;
}

function withCwd(options: WorkflowOptions): string {
	return path.resolve(options.cwd ?? process.cwd());
}

function configOptions(options: WorkflowOptions): ConfigPathOptions {
	const result: ConfigPathOptions = {};
	if (options.configPath !== undefined) {
		result.configPath = options.configPath;
	}
	if (options.env !== undefined) {
		result.env = options.env;
	}
	if (options.platform !== undefined) {
		result.platform = options.platform;
	}
	if (options.homeDir !== undefined) {
		result.homeDir = options.homeDir;
	}
	return result;
}

async function assertDirectory(target: string, label: string): Promise<void> {
	let value;
	try {
		value = await lstat(target);
	} catch (error) {
		throw new RepoLibError(`${label} does not exist: "${target}".`, 1, {cause: error});
	}
	if (!value.isDirectory() || value.isSymbolicLink()) {
		throw new RepoLibError(`${label} must be a real directory, not a link: "${target}".`);
	}
}

async function ensureDirectory(target: string, label: string): Promise<void> {
	try {
		await mkdir(target, {recursive: true});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
			throw new RepoLibError(`Cannot create ${label.toLowerCase()}: "${target}".`, 1, {
				cause: error,
			});
		}
	}
	await assertDirectory(target, label);
}

async function assertLibraryDestination(target: string): Promise<boolean> {
	try {
		const value = await lstat(target);
		if (!value.isDirectory() || value.isSymbolicLink()) {
			throw new RepoLibError(`Library destination must be a real directory: "${target}".`);
		}
		const entries = await readdir(target);
		if (entries.length > 0) {
			throw new RepoLibError(`Library destination must be empty: "${target}".`);
		}
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return false;
		}
		throw error;
	}
}

function uniqueRemotes(remotes: readonly GitRemote[]): GitRemote[] {
	const seen = new Set<string>();
	return remotes.filter(remote => {
		const key = `${remote.name}\0${remote.url}`;
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	});
}

async function selectRemote(ui: WorkflowUi, remotes: readonly GitRemote[]): Promise<GitRemote> {
	const candidates = uniqueRemotes(remotes);
	if (candidates.length === 0) {
		throw new RepoLibError('No Git remotes are available.');
	}
	if (candidates.length === 1) {
		return candidates[0]!;
	}
	const value = await ui.select(
		'Select the remote repository to associate with this project',
		candidates.map((remote, index) => ({
			label: `${remote.name} — ${remote.url}`,
			value: String(index),
		})),
	);
	const chosen = candidates[Number(value)];
	if (chosen === undefined) {
		throw new RepoLibError('The selected Git remote is no longer available.');
	}
	return chosen;
}

function sortedProjects(config: RepoLibConfig, project: string): string[] {
	return [...new Set([...config.projects, project])].sort((a, b) => a.localeCompare(b));
}

async function activeProject(
	ui: WorkflowUi,
	options: WorkflowOptions,
	includeTrackedFiles = false,
): Promise<ActiveProject> {
	let config = await loadConfig(configOptions(options));
	await assertConfiguredRootsExist(config);
	const cwd = withCwd(options);
	const gitRoot = await findGitRoot(cwd);
	const relativePath = relativeProjectPath(config, gitRoot);
	const paths = projectPaths(config, relativePath);

	await mkdir(paths.libraryPath, {recursive: true});
	const [discoveredRemotes, markerUrl, trackedFiles] = await Promise.all([
		getRemotes(gitRoot),
		readRemoteMarker(paths.libraryPath),
		includeTrackedFiles
			? getTrackedFileSet(gitRoot)
			: Promise.resolve(undefined),
	]);
	const remotes = uniqueRemotes(discoveredRemotes);
	let remoteUrl = markerUrl;

	if (remoteUrl !== undefined && !remotes.some(remote => remote.url === remoteUrl)) {
		throw new RepoLibError(
			`The URL in "${path.join(paths.libraryPath, 'remote-repo.txt')}" does not match any configured Git remote.`,
		);
	}

	if (remoteUrl === undefined && remotes.length > 0) {
		const chosen = await selectRemote(ui, remotes);
		remoteUrl = chosen.url;
		await writeRemoteMarker(paths.libraryPath, remoteUrl);
		ui.info(`Associated ${relativePath} with ${chosen.name}.`);
	}

	if (!isRegisteredProject(config, relativePath)) {
		config = await saveConfig(
			{...config, projects: sortedProjects(config, relativePath)},
			configOptions(options),
		);
	}

	const nestedProjects = getNestedProjects(config, relativePath);
	return {
		config,
		context: {
			...paths,
			gitRoot,
			nestedProjects,
		},
		...(remoteUrl === undefined ? {} : {remoteUrl}),
		remotes,
		...(trackedFiles === undefined ? {} : {trackedFiles}),
	};
}

function nestedRoots(context: ProjectContext, kind: 'worktree' | 'library'): string[] {
	return context.nestedProjects.map(project =>
		kind === 'worktree' ? project.worktreePath : project.libraryPath,
	);
}

function isWithinNestedPortablePath(
	relativePath: string,
	context: ProjectContext,
): boolean {
	const candidate = path.resolve(
		context.worktreePath,
		fromPortablePath(relativePath),
	);
	return context.nestedProjects.some(project =>
		isPathInside(project.worktreePath, candidate, {allowEqual: true}),
	);
}

async function untrackedNonIgnored(gitRoot: string): Promise<string[]> {
	const result = await runGit(gitRoot, [
		'ls-files',
		'--others',
		'--exclude-standard',
		'-z',
	]);
	const raw = result.stdout.toString('utf8').split('\0');
	if (raw.at(-1) === '') {
		raw.pop();
	}
	return raw.filter(Boolean).sort((first, second) => Buffer.from(first).compare(Buffer.from(second)));
}

async function sourceIsRegularFile(target: string): Promise<boolean> {
	try {
		const value = await lstat(target);
		return value.isFile() && !value.isSymbolicLink();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return false;
		}
		throw error;
	}
}

export async function initWorkflow(
	ui: WorkflowUi,
	options: WorkflowOptions = {},
): Promise<RepoLibConfig> {
	ui.warn('The repo-lib library is plaintext storage. Keep it private and never commit or publish it.');
	const mode = await ui.select('How should the library be created?', [
		{label: 'Create an empty library', value: 'empty'},
		{label: 'Build from an existing worktree', value: 'existing'},
	]);
	const cwd = withCwd(options);
	const libraryInput = await ui.text('Library directory', path.join(homedir(), 'repo-library'));
	const worktreeInput = await ui.text('Worktree directory', cwd);
	const libraryRoot = await canonicalizePath(expandHome(libraryInput), cwd);
	const worktreeRoot = await canonicalizePath(expandHome(worktreeInput), cwd);

	const baseConfig = await createConfig({libraryRoot, worktreeRoot, projects: []});
	await ensureDirectory(baseConfig.worktreeRoot, 'Worktree directory');
	const destinationExisted = await assertLibraryDestination(baseConfig.libraryRoot);
	await mkdir(path.dirname(baseConfig.libraryRoot), {recursive: true});
	const stagingRoot = path.join(
		path.dirname(baseConfig.libraryRoot),
		`.repo-lib-init-${process.pid}-${randomUUID()}`,
	);
	await mkdir(stagingRoot, {recursive: false});

	const projects: string[] = [];
	try {
		if (mode === 'existing') {
			const repositories = await ui.busy('Discovering Git projects', () =>
				discoverGitRepositories(baseConfig.worktreeRoot),
			);
			const repositoriesWithRemotes = await ui.busy(
				'Reading Git remotes',
				() =>
					Promise.all(
						repositories.map(async repository => ({
							repository,
							remotes: uniqueRemotes(await getRemotes(repository)),
						})),
					),
			);
			for (const {repository, remotes} of repositoriesWithRemotes) {
				const relativePath = relativeProjectPath(baseConfig, repository);
				const projectStage =
					relativePath === '.'
						? stagingRoot
						: path.join(stagingRoot, fromPortablePath(relativePath));
				if (remotes.length === 0) {
					ui.warn(
						`${relativePath} has no remote. Its tracked source will not be stored by repo-lib.`,
					);
					const register = await ui.confirm(
						`Register ${relativePath} as a local-only project? You can add a remote and run repo-lib push later.`,
					);
					if (!register) {
						continue;
					}
					await mkdir(projectStage, {recursive: true});
				} else {
					const chosen = await selectRemote(ui, remotes);
					await writeRemoteMarker(projectStage, chosen.url);
				}
				projects.push(relativePath);
			}
		}

		if (destinationExisted) {
			await rmdir(baseConfig.libraryRoot);
		}
		await rename(stagingRoot, baseConfig.libraryRoot);
		let config: RepoLibConfig;
		try {
			config = await saveConfig(
				{...baseConfig, projects: [...new Set(projects)].sort((a, b) => a.localeCompare(b))},
				configOptions(options),
			);
		} catch (error) {
			await rm(baseConfig.libraryRoot, {force: true, recursive: true});
			if (destinationExisted) {
				await mkdir(baseConfig.libraryRoot, {recursive: true});
			}
			throw error;
		}
		ui.success(
			mode === 'empty'
				? `Created an empty library at ${config.libraryRoot}.`
				: `Created ${projects.length} project ${projects.length === 1 ? 'entry' : 'entries'} at ${config.libraryRoot}.`,
		);
		return config;
	} catch (error) {
		await rm(stagingRoot, {force: true, recursive: true}).catch(() => undefined);
		throw error;
	}
}

export async function addWorkflow(
	ui: WorkflowUi,
	pathsToAdd: readonly string[],
	options: WorkflowOptions = {},
): Promise<SyncSummary> {
	if (pathsToAdd.length === 0) {
		throw new RepoLibError('repo-lib add requires at least one file or directory.', 2);
	}
	const active = await activeProject(ui, options, true);
	const cwd = await canonicalizePath(withCwd(options));
	const selected = pathsToAdd.map(value => path.resolve(cwd, value));
	const collected = await collectSelectedFiles(
		active.context.worktreePath,
		selected,
		nestedRoots(active.context, 'worktree'),
	);
	const tracked = active.trackedFiles!;
	const eligible = collected.files.filter(file => !tracked.has(file));
	const skippedTracked = collected.files.filter(file => tracked.has(file));
	const copied: string[] = [];

	for (const relativePath of eligible) {
		await copyFileAtomic(
			path.join(active.context.worktreePath, fromPortablePath(relativePath)),
			path.join(active.context.libraryPath, fromPortablePath(relativePath)),
			active.context.libraryPath,
		);
		copied.push(relativePath);
	}

	const skipped = [
		...skippedTracked.map(file => `${file} (tracked)`),
		...collected.skipped.map(item => `${item.relativePath} (${item.reason})`),
	];
	if (copied.length === 0) {
		ui.warn('No eligible untracked files were added.');
	} else {
		ui.success(`Added ${copied.length} ${copied.length === 1 ? 'file' : 'files'} to the library.`);
	}
	return {copied, removed: [], skipped};
}

export async function pushWorkflow(
	ui: WorkflowUi,
	includeAll: boolean,
	options: WorkflowOptions = {},
): Promise<SyncSummary> {
	const active = await activeProject(ui, options, true);
	if (active.remoteUrl === undefined) {
		ui.warn('This project has no remote. Tracked source code is not backed up by repo-lib.');
		if (!(await ui.confirm('Continue and sync untracked library payload only?'))) {
			throw new CancelledError();
		}
	}

	const tracked = active.trackedFiles!;
	const cleanup = await removeTrackedLibraryPaths(
		active.context.libraryPath,
		tracked,
		nestedRoots(active.context, 'library'),
	);
	const existing = await walkRegularFiles(active.context.libraryPath, {
		excludedRoots: nestedRoots(active.context, 'library'),
	});
	const candidates = new Set(existing.files);
	const newlyDiscovered: string[] = [];

	if (includeAll) {
		for (const relativePath of await untrackedNonIgnored(active.context.gitRoot)) {
			if (
				isReservedPayloadPath(relativePath) ||
				isWithinNestedPortablePath(relativePath, active.context) ||
				(await crossesNestedGitWorktree(
					active.context.worktreePath,
					path.join(active.context.worktreePath, fromPortablePath(relativePath)),
				)) ||
				tracked.has(relativePath)
			) {
				continue;
			}
			if (!candidates.has(relativePath)) {
				candidates.add(relativePath);
				newlyDiscovered.push(relativePath);
			}
		}

		if (newlyDiscovered.length > 0) {
			let bytes = 0;
			for (const relativePath of newlyDiscovered) {
				const source = path.join(active.context.worktreePath, fromPortablePath(relativePath));
				if (await sourceIsRegularFile(source)) {
					bytes += await fileSize(source);
				}
			}
			if (
				!(await ui.confirm(
					`Add ${newlyDiscovered.length} new ${newlyDiscovered.length === 1 ? 'file' : 'files'} (${formatBytes(bytes)}) to the library?`,
				))
			) {
				throw new CancelledError();
			}
		}
	}

	const copied: string[] = [];
	const skipped = [
		...cleanup.skipped.map(item => `${item.relativePath} (${item.reason})`),
		...existing.skipped.map(item => `${item.relativePath} (${item.reason})`),
	];
	for (const relativePath of [...candidates].sort((a, b) => Buffer.from(a).compare(Buffer.from(b)))) {
		if (tracked.has(relativePath)) {
			continue;
		}
		const source = path.join(active.context.worktreePath, fromPortablePath(relativePath));
		if (
			await crossesNestedGitWorktree(active.context.worktreePath, source)
		) {
			skipped.push(`${relativePath} (nested-project)`);
			continue;
		}
		if (!(await sourceIsRegularFile(source))) {
			if (await pathExists(source)) {
				skipped.push(`${relativePath} (link or special)`);
			}
			continue;
		}
		await copyFileAtomic(
			source,
			path.join(active.context.libraryPath, fromPortablePath(relativePath)),
			active.context.libraryPath,
		);
		copied.push(relativePath);
	}

	ui.success(
		`Push complete: ${copied.length} copied, ${cleanup.removed.length} tracked ${cleanup.removed.length === 1 ? 'entry' : 'entries'} removed.`,
	);
	return {copied, removed: cleanup.removed, skipped};
}

export async function pullWorkflow(
	ui: WorkflowUi,
	options: WorkflowOptions = {},
): Promise<SyncSummary> {
	const active = await activeProject(ui, options);
	if (active.remoteUrl === undefined) {
		ui.warn('This project has no remote. Git source will not be updated; only library payload can be restored.');
	} else {
		await ui.busy('Pulling tracked source with Git (fast-forward only)', () =>
			pullFastForward(active.context.gitRoot, active.remoteUrl!),
		);
	}

	const tracked = await getTrackedFileSet(active.context.gitRoot);
	const cleanup = await removeTrackedLibraryPaths(
		active.context.libraryPath,
		tracked,
		nestedRoots(active.context, 'library'),
	);
	const payload = await walkRegularFiles(active.context.libraryPath, {
		excludedRoots: nestedRoots(active.context, 'library'),
	});
	const differing: string[] = [];
	const toCopy: string[] = [];

	for (const relativePath of payload.files) {
		const source = path.join(active.context.libraryPath, fromPortablePath(relativePath));
		const destination = path.join(active.context.worktreePath, fromPortablePath(relativePath));
		const destinationType = await getPathType(destination);
		if (destinationType === 'directory' || destinationType === 'link' || destinationType === 'special') {
			throw new RepoLibError(
				`Cannot restore "${relativePath}" because its worktree destination is a ${destinationType}.`,
			);
		}
		if (destinationType === 'file' && !(await filesEqual(source, destination))) {
			differing.push(relativePath);
		}
		if (destinationType === 'missing' || destinationType === 'file') {
			toCopy.push(relativePath);
		}
	}

	if (differing.length > 0) {
		ui.warn(`Pull will overwrite ${differing.length} differing untracked ${differing.length === 1 ? 'file' : 'files'}:\n${differing.join('\n')}`);
		if (!(await ui.confirm('Overwrite these worktree files with the library copies?'))) {
			throw new CancelledError(
				active.remoteUrl === undefined
					? 'Cancelled; no payload files were restored.'
					: 'Cancelled; Git was updated, but no payload files were restored.',
			);
		}
	}

	const copied: string[] = [];
	for (const relativePath of toCopy) {
		const source = path.join(active.context.libraryPath, fromPortablePath(relativePath));
		const destination = path.join(active.context.worktreePath, fromPortablePath(relativePath));
		if (await filesEqual(source, destination)) {
			continue;
		}
		await copyFileAtomic(source, destination, active.context.worktreePath);
		copied.push(relativePath);
	}

	const skipped = payload.skipped.map(item => `${item.relativePath} (${item.reason})`);
	ui.success(
		`Pull complete: ${copied.length} restored, ${cleanup.removed.length} tracked ${cleanup.removed.length === 1 ? 'entry' : 'entries'} removed from the library.`,
	);
	return {copied, removed: cleanup.removed, skipped};
}

export async function listWorkflow(
	ui: WorkflowUi,
	options: WorkflowOptions = {},
): Promise<string[]> {
	const config = await loadConfig(configOptions(options));
	await assertConfiguredRootsExist(config);
	const context = await resolveCurrentProject(config, withCwd(options));
	const payload = await walkRegularFiles(context.libraryPath, {
		excludedRoots: nestedRoots(context, 'library'),
	});
	if (payload.files.length === 0) {
		ui.info('No payload files are stored for this project.');
	} else {
		for (const file of payload.files) {
			ui.info(file);
		}
	}
	return payload.files;
}

async function pathExists(target: string): Promise<boolean> {
	try {
		await lstat(target);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return false;
		}
		throw error;
	}
}

async function getPathType(
	target: string,
): Promise<'missing' | 'file' | 'directory' | 'link' | 'special'> {
	try {
		const value = await lstat(target);
		if (value.isSymbolicLink()) {
			return 'link';
		}
		if (value.isFile()) {
			return 'file';
		}
		if (value.isDirectory()) {
			return 'directory';
		}
		return 'special';
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return 'missing';
		}
		throw error;
	}
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes} B`;
	}
	if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)} KiB`;
	}
	if (bytes < 1024 * 1024 * 1024) {
		return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
	}
	return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GiB`;
}
