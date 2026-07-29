import {
	mkdir,
	readFile,
	symlink,
	stat,
	writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
	assertSafePath,
	collectSelectedFiles,
	copyFileAtomic,
	filesEqual,
	isReservedPayloadPath,
	removeTrackedLibraryPaths,
	walkRegularFiles,
} from '../src/core/filesystem.js';
import {createSandbox, type Sandbox} from './helpers.js';

describe('filesystem safety and payload operations', () => {
	let sandbox: Sandbox;

	beforeEach(async () => {
		sandbox = await createSandbox();
		await mkdir(sandbox.library, {recursive: true});
	});

	afterEach(async () => {
		await sandbox.cleanup();
	});

	it('recognizes all reserved metadata path segments', () => {
		expect(isReservedPayloadPath('.git/config')).toBe(true);
		expect(isReservedPayloadPath('nested/remote-repo.txt')).toBe(true);
		expect(isReservedPayloadPath('remote-repo.txt')).toBe(true);
		expect(isReservedPayloadPath('.env')).toBe(false);
	});

	it('walks regular files in stable order and skips metadata and nested projects', async () => {
		await mkdir(path.join(sandbox.library, 'z'), {recursive: true});
		await mkdir(path.join(sandbox.library, 'nested'), {recursive: true});
		await mkdir(path.join(sandbox.library, '.git'), {recursive: true});
		await writeFile(path.join(sandbox.library, 'z', 'b.txt'), 'b');
		await writeFile(path.join(sandbox.library, 'a.txt'), 'a');
		await writeFile(path.join(sandbox.library, 'remote-repo.txt'), 'url\n');
		await writeFile(path.join(sandbox.library, '.git', 'config'), 'bad');
		await writeFile(path.join(sandbox.library, 'nested', 'secret'), 'nested');

		const result = await walkRegularFiles(sandbox.library, {
			excludedRoots: [path.join(sandbox.library, 'nested')],
		});
		expect(result.files).toEqual(['a.txt', 'z/b.txt']);
		expect(result.skipped.map(item => item.reason)).toContain('reserved');
		expect(result.skipped.map(item => item.reason)).toContain('nested-project');
	});

	it('returns an empty walk for a missing root', async () => {
		expect(await walkRegularFiles(path.join(sandbox.library, 'missing'))).toEqual({
			files: [],
			skipped: [],
		});
	});

	it('collects explicit directories while rejecting traversal and reserved paths', async () => {
		const project = path.join(sandbox.worktree, 'project');
		await mkdir(path.join(project, 'secrets'), {recursive: true});
		await writeFile(path.join(project, 'secrets', '.env'), 'TOKEN=x');
		await writeFile(path.join(project, 'remote-repo.txt'), 'payload?');
		const result = await collectSelectedFiles(project, [project], []);
		expect(result.files).toEqual(['secrets/.env']);
		expect(result.skipped).toContainEqual({
			relativePath: 'remote-repo.txt',
			reason: 'reserved',
		});
		await expect(
			collectSelectedFiles(project, [path.join(project, '..', 'outside')], []),
		).rejects.toThrow('escapes');
	});

	it('collects an explicit file and excludes a selected nested project', async () => {
		const project = path.join(sandbox.worktree, 'project');
		const nested = path.join(project, 'nested');
		await mkdir(nested, {recursive: true});
		await writeFile(path.join(project, 'one.txt'), 'one');
		await writeFile(path.join(nested, 'two.txt'), 'two');
		expect(
			await collectSelectedFiles(
				project,
				[path.join(project, 'one.txt'), nested],
				[nested],
			),
		).toEqual({
			files: ['one.txt'],
			skipped: [{relativePath: 'nested', reason: 'nested-project'}],
		});
	});

	it('copies files byte-for-byte and refuses a directory destination', async () => {
		const source = path.join(sandbox.worktree, 'binary');
		const destination = path.join(sandbox.library, 'nested', 'binary');
		await writeFile(source, Buffer.from([0, 1, 2, 255]));
		await copyFileAtomic(source, destination, sandbox.library);
		expect(await readFile(destination)).toEqual(Buffer.from([0, 1, 2, 255]));
		expect(await filesEqual(source, destination)).toBe(true);

		const blocked = path.join(sandbox.library, 'blocked');
		await mkdir(blocked);
		await expect(copyFileAtomic(source, blocked, sandbox.library)).rejects.toThrow(
			'non-file destination',
		);
		await expect(
			copyFileAtomic(sandbox.worktree, path.join(sandbox.library, 'bad'), sandbox.library),
		).rejects.toThrow('Only regular files');
		expect(await filesEqual(source, path.join(sandbox.library, 'missing'))).toBe(false);
		await writeFile(path.join(sandbox.library, 'different'), 'different size');
		expect(await filesEqual(source, path.join(sandbox.library, 'different'))).toBe(false);
	});

	it('removes tracked library payload and retains metadata', async () => {
		await mkdir(path.join(sandbox.library, 'src'), {recursive: true});
		await writeFile(path.join(sandbox.library, 'src', 'tracked.txt'), 'bad');
		await writeFile(path.join(sandbox.library, '.env'), 'good');
		await writeFile(path.join(sandbox.library, 'remote-repo.txt'), 'url\n');
		const result = await removeTrackedLibraryPaths(
			sandbox.library,
			new Set(['src/tracked.txt', 'remote-repo.txt']),
			[],
		);
		expect(result.removed).toEqual(['src/tracked.txt']);
		await expect(stat(path.join(sandbox.library, 'src'))).rejects.toMatchObject({
			code: 'ENOENT',
		});
		expect(await readFile(path.join(sandbox.library, '.env'), 'utf8')).toBe('good');
		expect(await readFile(path.join(sandbox.library, 'remote-repo.txt'), 'utf8')).toBe(
			'url\n',
		);
	});

	it('skips nested tracked paths and removes an exact directory conflict', async () => {
		const nested = path.join(sandbox.library, 'nested');
		await mkdir(path.join(nested, 'inside'), {recursive: true});
		await writeFile(path.join(nested, 'inside', 'keep'), 'keep');
		await mkdir(path.join(sandbox.library, 'conflict'), {recursive: true});
		await writeFile(path.join(sandbox.library, 'conflict', 'old'), 'old');
		const result = await removeTrackedLibraryPaths(
			sandbox.library,
			new Set(['nested/inside/keep', 'conflict', 'missing.txt']),
			[nested],
		);
		expect(result.removed).toEqual(['conflict']);
		expect(result.skipped).toEqual([
			{relativePath: 'nested/inside/keep', reason: 'nested-project'},
		]);
		expect(await readFile(path.join(nested, 'inside', 'keep'), 'utf8')).toBe('keep');
	});

	it('checks that every destination remains inside its root', async () => {
		await expect(
			assertSafePath(sandbox.library, path.join(sandbox.library, '..', 'outside')),
		).rejects.toThrow('escapes');
		await expect(
			assertSafePath(sandbox.library, sandbox.library, {allowRoot: true}),
		).resolves.toBeUndefined();
		await expect(
			assertSafePath(sandbox.library, path.join(sandbox.library, 'missing'), {
				allowMissing: false,
			}),
		).rejects.toThrow('does not exist');
		await writeFile(path.join(sandbox.library, 'file'), 'blocker');
		await expect(
			assertSafePath(sandbox.library, path.join(sandbox.library, 'file', 'child')),
		).rejects.toThrow('non-directory blocks');
	});

	it('does not follow directory links or junctions', async () => {
		const target = path.join(sandbox.root, 'link-target');
		const link = path.join(sandbox.library, 'linked');
		await mkdir(target);
		await writeFile(path.join(target, 'secret'), 'outside');
		await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
		const result = await walkRegularFiles(sandbox.library);
		expect(result.files).toEqual([]);
		expect(result.skipped).toContainEqual({
			relativePath: 'linked',
			reason: 'link',
		});
		await expect(assertSafePath(sandbox.library, path.join(link, 'secret'))).rejects.toThrow(
			'not followed',
		);
	});
});
