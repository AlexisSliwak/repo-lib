import {randomUUID} from 'node:crypto';
import {
	copyFile,
	lstat,
	mkdir,
	readFile,
	readdir,
	rename,
	rmdir,
	rm,
	stat,
} from 'node:fs/promises';
import path from 'node:path';
import {isPathInside} from './config.js';
import {RepoLibError} from './errors.js';
import {REMOTE_REPO_FILE, pathCrossesNestedProject} from './projects.js';

export interface SkippedPath {
	relativePath: string;
	reason: 'link' | 'special' | 'reserved' | 'nested-project';
}

export interface WalkResult {
	files: string[];
	skipped: SkippedPath[];
}

export interface CleanupResult {
	removed: string[];
	skipped: SkippedPath[];
}

export function toPortablePath(value: string): string {
	return value.split(path.sep).join('/');
}

export function fromPortablePath(value: string): string {
	return value.split('/').join(path.sep);
}

export function isReservedPayloadPath(relativePath: string): boolean {
	const parts = toPortablePath(relativePath).split('/');
	return parts.includes('.git') || parts.includes(REMOTE_REPO_FILE);
}

function comparePaths(first: string, second: string): number {
	return Buffer.from(first).compare(Buffer.from(second));
}

async function pathType(target: string): Promise<'missing' | 'file' | 'directory' | 'link' | 'special'> {
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

export async function crossesNestedGitWorktree(
	projectRoot: string,
	candidate: string,
): Promise<boolean> {
	const root = path.resolve(projectRoot);
	const absolute = path.resolve(candidate);
	if (!isPathInside(root, absolute, {allowEqual: true}) || absolute === root) {
		return false;
	}
	const candidateType = await pathType(absolute);
	let cursor = candidateType === 'directory' ? absolute : path.dirname(absolute);
	while (cursor !== root && isPathInside(root, cursor, {allowEqual: false})) {
		if ((await pathType(path.join(cursor, '.git'))) !== 'missing') {
			return true;
		}
		cursor = path.dirname(cursor);
	}
	return false;
}

export async function assertSafePath(
	root: string,
	target: string,
	options: {allowRoot?: boolean; allowMissing?: boolean} = {},
): Promise<void> {
	const resolvedRoot = path.resolve(root);
	const resolvedTarget = path.resolve(target);
	if (
		!isPathInside(resolvedRoot, resolvedTarget, {
			allowEqual: options.allowRoot ?? false,
		})
	) {
		throw new RepoLibError(`Path escapes its configured root: "${target}".`);
	}

	const relative = path.relative(resolvedRoot, resolvedTarget);
	if (relative === '') {
		const type = await pathType(resolvedRoot);
		if (type === 'link') {
			throw new RepoLibError(`Configured root cannot be a symbolic link or junction: "${root}".`);
		}
		return;
	}

	let cursor = resolvedRoot;
	for (const part of relative.split(path.sep)) {
		cursor = path.join(cursor, part);
		const type = await pathType(cursor);
		if (type === 'link') {
			throw new RepoLibError(`Symbolic links and junctions are not followed: "${cursor}".`);
		}
		if (type === 'missing') {
			if (options.allowMissing ?? true) {
				return;
			}
			throw new RepoLibError(`Path does not exist: "${cursor}".`);
		}
		if (cursor !== resolvedTarget && type !== 'directory') {
			throw new RepoLibError(`A non-directory blocks path "${target}".`);
		}
	}
}

export async function walkRegularFiles(
	root: string,
	options: {excludedRoots?: readonly string[]} = {},
): Promise<WalkResult> {
	const resolvedRoot = path.resolve(root);
	const excludedRoots = options.excludedRoots ?? [];
	const files: string[] = [];
	const skipped: SkippedPath[] = [];

	const visit = async (directory: string): Promise<void> => {
		let entries;
		try {
			entries = await readdir(directory, {withFileTypes: true});
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				return;
			}
			throw error;
		}

		entries.sort((first, second) => first.name.localeCompare(second.name));
		for (const entry of entries) {
			const absolute = path.join(directory, entry.name);
			const relativePath = toPortablePath(path.relative(resolvedRoot, absolute));

			if (isReservedPayloadPath(relativePath)) {
				skipped.push({relativePath, reason: 'reserved'});
				continue;
			}
			if (pathCrossesNestedProject(absolute, excludedRoots)) {
				skipped.push({relativePath, reason: 'nested-project'});
				continue;
			}

			const value = await lstat(absolute);
			if (value.isSymbolicLink()) {
				skipped.push({relativePath, reason: 'link'});
			} else if (value.isDirectory()) {
				if ((await pathType(path.join(absolute, '.git'))) !== 'missing') {
					skipped.push({relativePath, reason: 'nested-project'});
				} else {
					await visit(absolute);
				}
			} else if (value.isFile()) {
				files.push(relativePath);
			} else {
				skipped.push({relativePath, reason: 'special'});
			}
		}
	};

	if ((await pathType(resolvedRoot)) === 'missing') {
		return {files, skipped};
	}
	await assertSafePath(resolvedRoot, resolvedRoot, {allowRoot: true});
	await visit(resolvedRoot);
	files.sort(comparePaths);
	return {files, skipped};
}

export async function collectSelectedFiles(
	projectRoot: string,
	selectedPaths: readonly string[],
	excludedRoots: readonly string[],
): Promise<WalkResult> {
	const files = new Set<string>();
	const skipped: SkippedPath[] = [];

	for (const selected of selectedPaths) {
		const absolute = path.resolve(selected);
		await assertSafePath(projectRoot, absolute, {allowRoot: true, allowMissing: false});
		const relativePath = toPortablePath(path.relative(projectRoot, absolute)) || '.';
		if (pathCrossesNestedProject(absolute, excludedRoots)) {
			skipped.push({relativePath, reason: 'nested-project'});
			continue;
		}
		if (await crossesNestedGitWorktree(projectRoot, absolute)) {
			skipped.push({relativePath, reason: 'nested-project'});
			continue;
		}
		if (relativePath !== '.' && isReservedPayloadPath(relativePath)) {
			skipped.push({relativePath, reason: 'reserved'});
			continue;
		}

		const type = await pathType(absolute);
		if (type === 'link') {
			skipped.push({relativePath, reason: 'link'});
		} else if (type === 'file') {
			files.add(relativePath);
		} else if (type === 'directory') {
			const nested = await walkRegularFiles(absolute, {excludedRoots});
			for (const file of nested.files) {
				const fromProject = toPortablePath(
					path.relative(projectRoot, path.join(absolute, fromPortablePath(file))),
				);
				files.add(fromProject);
			}
			for (const item of nested.skipped) {
				skipped.push({
					...item,
					relativePath: toPortablePath(
						path.relative(
							projectRoot,
							path.join(absolute, fromPortablePath(item.relativePath)),
						),
					),
				});
			}
		} else {
			skipped.push({relativePath, reason: 'special'});
		}
	}

	return {files: [...files].sort(comparePaths), skipped};
}

export async function copyFileAtomic(
	source: string,
	destination: string,
	destinationRoot: string,
): Promise<void> {
	await assertSafePath(destinationRoot, destination, {allowMissing: true});
	const sourceValue = await lstat(source);
	if (!sourceValue.isFile() || sourceValue.isSymbolicLink()) {
		throw new RepoLibError(`Only regular files can be copied: "${source}".`);
	}

	await mkdir(path.dirname(destination), {recursive: true});
	await assertSafePath(destinationRoot, path.dirname(destination), {
		allowRoot: true,
		allowMissing: false,
	});
	const destinationType = await pathType(destination);
	if (destinationType === 'directory' || destinationType === 'link' || destinationType === 'special') {
		throw new RepoLibError(`Cannot replace non-file destination "${destination}".`);
	}

	const temporary = path.join(
		path.dirname(destination),
		`.${path.basename(destination)}.${process.pid}.${randomUUID()}.tmp`,
	);
	try {
		await copyFile(source, temporary);
		try {
			await rename(temporary, destination);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (!['EEXIST', 'EPERM'].includes(code ?? '') || destinationType !== 'file') {
				throw error;
			}
			await rm(destination, {force: true});
			await rename(temporary, destination);
		}
	} finally {
		await rm(temporary, {force: true}).catch(() => undefined);
	}
}

export async function filesEqual(first: string, second: string): Promise<boolean> {
	try {
		const [firstStat, secondStat] = await Promise.all([stat(first), stat(second)]);
		if (!firstStat.isFile() || !secondStat.isFile() || firstStat.size !== secondStat.size) {
			return false;
		}
		const [firstData, secondData] = await Promise.all([readFile(first), readFile(second)]);
		return firstData.equals(secondData);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return false;
		}
		throw error;
	}
}

export async function fileSize(target: string): Promise<number> {
	return (await stat(target)).size;
}

async function removeEmptyParents(directory: string, stopAt: string): Promise<void> {
	let cursor = path.resolve(directory);
	const stop = path.resolve(stopAt);
	while (cursor !== stop && isPathInside(stop, cursor, {allowEqual: false})) {
		try {
			await rmdir(cursor);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === 'ENOTEMPTY' || code === 'EEXIST' || code === 'ENOENT') {
				return;
			}
			throw error;
		}
		cursor = path.dirname(cursor);
	}
}

export async function removeTrackedLibraryPaths(
	libraryProjectRoot: string,
	trackedPaths: ReadonlySet<string>,
	excludedLibraryRoots: readonly string[],
): Promise<CleanupResult> {
	const removed: string[] = [];
	const skipped: SkippedPath[] = [];
	for (const relativePath of [...trackedPaths].sort(comparePaths)) {
		if (isReservedPayloadPath(relativePath)) {
			continue;
		}
		const target = path.resolve(libraryProjectRoot, fromPortablePath(relativePath));
		if (pathCrossesNestedProject(target, excludedLibraryRoots)) {
			skipped.push({relativePath, reason: 'nested-project'});
			continue;
		}
		await assertSafePath(libraryProjectRoot, target, {allowMissing: true});
		const type = await pathType(target);
		if (type === 'missing') {
			continue;
		}
		if (type === 'link') {
			skipped.push({relativePath, reason: 'link'});
			continue;
		}
		await rm(target, {force: true, recursive: type === 'directory'});
		removed.push(relativePath);
		await removeEmptyParents(path.dirname(target), libraryProjectRoot);
	}
	return {removed, skipped};
}
