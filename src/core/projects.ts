import path from 'node:path';
import {realpath} from 'node:fs/promises';
import {
	canonicalizePath,
	isPathInside,
	normalizeProjectRelativePath,
	type RepoLibConfig,
} from './config.js';
import {findGitRoot} from './git.js';

export const REMOTE_REPO_FILE = 'remote-repo.txt';

export interface ProjectPaths {
	relativePath: string;
	worktreePath: string;
	libraryPath: string;
}

export interface ProjectContext extends ProjectPaths {
	gitRoot: string;
	nestedProjects: ProjectPaths[];
}

export type GitRootResolver = (startPath: string) => Promise<string>;

export class ProjectError extends Error {
	readonly code:
		| 'PROJECT_NOT_REGISTERED'
		| 'PROJECT_OUTSIDE_WORKTREE'
		| 'PROJECT_PATH_INVALID';

	constructor(
		message: string,
		code: ProjectError['code'],
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = 'ProjectError';
		this.code = code;
	}
}

export function toNativeProjectPath(relativePath: string): string {
	const normalized = normalizeProjectRelativePath(relativePath);
	return normalized === '.' ? '' : normalized.split('/').join(path.sep);
}

export function projectPaths(
	config: RepoLibConfig,
	relativePath: string,
): ProjectPaths {
	const normalized = normalizeProjectRelativePath(relativePath);
	const nativeRelative = toNativeProjectPath(normalized);
	const worktreePath = path.resolve(config.worktreeRoot, nativeRelative);
	const libraryPath = path.resolve(config.libraryRoot, nativeRelative);

	if (
		!isPathInside(config.worktreeRoot, worktreePath) ||
		!isPathInside(config.libraryRoot, libraryPath)
	) {
		throw new ProjectError(
			`Project path "${relativePath}" leaves the configured roots.`,
			'PROJECT_PATH_INVALID',
		);
	}

	return {relativePath: normalized, worktreePath, libraryPath};
}

export function relativeProjectPath(
	config: RepoLibConfig,
	absoluteGitRoot: string,
): string {
	const resolvedRoot = path.resolve(absoluteGitRoot);
	if (!isPathInside(config.worktreeRoot, resolvedRoot)) {
		throw new ProjectError(
			`Git root "${absoluteGitRoot}" is outside the configured worktree "${config.worktreeRoot}".`,
			'PROJECT_OUTSIDE_WORKTREE',
		);
	}

	const relative = path.relative(config.worktreeRoot, resolvedRoot);
	return normalizeProjectRelativePath(
		relative === '' ? '.' : relative.split(path.sep).join('/'),
	);
}

export function isRegisteredProject(
	config: RepoLibConfig,
	relativePath: string,
): boolean {
	const normalized = normalizeProjectRelativePath(relativePath);
	return config.projects.includes(normalized);
}

export function getRegisteredProject(
	config: RepoLibConfig,
	relativePath: string,
): ProjectPaths {
	const normalized = normalizeProjectRelativePath(relativePath);
	if (!isRegisteredProject(config, normalized)) {
		throw new ProjectError(
			`Project "${normalized}" is not registered. Run "repo-lib init" again to register it.`,
			'PROJECT_NOT_REGISTERED',
		);
	}
	return projectPaths(config, normalized);
}

export function getNestedProjects(
	config: RepoLibConfig,
	project: string | ProjectPaths,
): ProjectPaths[] {
	const relativePath =
		typeof project === 'string'
			? normalizeProjectRelativePath(project)
			: project.relativePath;
	const prefix = relativePath === '.' ? '' : `${relativePath}/`;

	return config.projects
		.filter(candidate => candidate !== relativePath)
		.filter(candidate => prefix === '' || candidate.startsWith(prefix))
		.map(candidate => projectPaths(config, candidate))
		.sort((first, second) =>
			first.relativePath.localeCompare(second.relativePath),
		);
}

export function getNestedProjectBoundaries(
	config: RepoLibConfig,
	project: string | ProjectPaths,
): {worktree: string[]; library: string[]} {
	const nested = getNestedProjects(config, project);
	return {
		worktree: nested.map(candidate => candidate.worktreePath),
		library: nested.map(candidate => candidate.libraryPath),
	};
}

export function pathCrossesNestedProject(
	candidate: string,
	nestedProjectRoots: readonly string[],
): boolean {
	const resolved = path.resolve(candidate);
	return nestedProjectRoots.some(root => isPathInside(root, resolved));
}

export function assertPathInProject(
	candidate: string,
	project: ProjectPaths,
	options: {
		space?: 'worktree' | 'library';
		nestedProjectRoots?: readonly string[];
	} = {},
): string {
	const base =
		(options.space ?? 'worktree') === 'worktree'
			? project.worktreePath
			: project.libraryPath;
	const resolved = path.resolve(candidate);

	if (!isPathInside(base, resolved)) {
		throw new ProjectError(
			`Path "${candidate}" is outside project "${project.relativePath}".`,
			'PROJECT_PATH_INVALID',
		);
	}

	if (
		options.nestedProjectRoots &&
		pathCrossesNestedProject(resolved, options.nestedProjectRoots)
	) {
		throw new ProjectError(
			`Path "${candidate}" belongs to a nested registered project.`,
			'PROJECT_PATH_INVALID',
		);
	}

	return resolved;
}

/**
 * Canonical, symlink-aware counterpart to assertPathInProject. Use this before
 * filesystem mutations; it prevents a lexically in-project symlink from
 * redirecting an operation outside the project or into a nested project.
 */
export async function resolvePathInProject(
	candidate: string,
	project: ProjectPaths,
	options: {
		space?: 'worktree' | 'library';
		nestedProjectRoots?: readonly string[];
	} = {},
): Promise<string> {
	const base =
		(options.space ?? 'worktree') === 'worktree'
			? project.worktreePath
			: project.libraryPath;
	const [canonicalBase, canonicalCandidate] = await Promise.all([
		canonicalizePath(base),
		canonicalizePath(candidate),
	]);

	if (!isPathInside(canonicalBase, canonicalCandidate)) {
		throw new ProjectError(
			`Path "${candidate}" resolves outside project "${project.relativePath}".`,
			'PROJECT_PATH_INVALID',
		);
	}

	if (options.nestedProjectRoots) {
		const canonicalNestedRoots = await Promise.all(
			options.nestedProjectRoots.map(root => canonicalizePath(root)),
		);
		if (pathCrossesNestedProject(canonicalCandidate, canonicalNestedRoots)) {
			throw new ProjectError(
				`Path "${candidate}" belongs to a nested registered project.`,
				'PROJECT_PATH_INVALID',
			);
		}
	}

	return canonicalCandidate;
}

export async function resolveCurrentProject(
	config: RepoLibConfig,
	cwd = process.cwd(),
	resolveGitRoot: GitRootResolver = findGitRoot,
): Promise<ProjectContext> {
	const gitRoot = await realpath(await resolveGitRoot(cwd));
	const relativePath = relativeProjectPath(config, gitRoot);
	const current = getRegisteredProject(config, relativePath);

	return {
		...current,
		gitRoot,
		nestedProjects: getNestedProjects(config, current),
	};
}
