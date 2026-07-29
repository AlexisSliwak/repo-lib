import {mkdtemp, mkdir, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {
	CONFIG_SCHEMA_VERSION,
	ConfigError,
	assertConfiguredRootsExist,
	canonicalizePath,
	configExists,
	createConfig,
	getConfigPath,
	isPathInside,
	loadConfig,
	normalizeProjectRelativePath,
	rootsOverlap,
	saveConfig,
	validateConfig,
} from '../src/core/config.js';
import {
	ProjectError,
	assertPathInProject,
	getRegisteredProject,
	getNestedProjectBoundaries,
	getNestedProjects,
	isRegisteredProject,
	pathCrossesNestedProject,
	projectPaths,
	relativeProjectPath,
	resolveCurrentProject,
	resolvePathInProject,
} from '../src/core/projects.js';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(path.join(tmpdir(), 'repo-lib-config-'));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory =>
			rm(directory, {recursive: true, force: true}),
		),
	);
});

describe('configuration', () => {
	it('selects platform config directories and permits an explicit override', () => {
		expect(
			getConfigPath({
				platform: 'linux',
				homeDir: '/home/alex',
				env: {},
			}),
		).toBe(path.join('/home/alex', '.config', 'repo-lib', 'config.json'));
		expect(
			getConfigPath({
				platform: 'linux',
				homeDir: '/unused',
				env: {XDG_CONFIG_HOME: '/configuration'},
			}),
		).toBe(path.join(path.resolve('/configuration'), 'repo-lib', 'config.json'));
		expect(
			getConfigPath({
				platform: 'darwin',
				homeDir: '/Users/alex',
				env: {},
			}),
		).toBe(
			path.join(
				'/Users/alex',
				'Library',
				'Application Support',
				'repo-lib',
				'config.json',
			),
		);
		expect(
			getConfigPath({
				configPath: path.join('/tmp', 'custom.json'),
				env: {},
			}),
		).toBe(path.resolve('/tmp', 'custom.json'));
		expect(
			getConfigPath({
				platform: 'win32',
				homeDir: 'C:\\Users\\alex',
				env: {APPDATA: 'C:\\settings'},
			}),
		).toBe(path.join(path.resolve('C:\\settings'), 'repo-lib', 'config.json'));
		expect(
			getConfigPath({
				platform: 'win32',
				homeDir: 'home',
				env: {},
			}),
		).toBe(path.join('home', 'AppData', 'Roaming', 'repo-lib', 'config.json'));
		expect(
			getConfigPath({
				env: {REPO_LIB_CONFIG: path.join('/tmp', 'from-env.json')},
			}),
		).toBe(path.resolve('/tmp', 'from-env.json'));
		expect(() =>
			getConfigPath({env: {REPO_LIB_CONFIG: ' '}}),
		).toThrow(/cannot be empty/u);
	});

	it('canonicalizes a missing tail using its real existing ancestor', async () => {
		const root = await temporaryDirectory();
		const actual = path.join(root, 'actual');
		const alias = path.join(root, 'alias');
		await mkdir(actual);

		try {
			await symlink(actual, alias, process.platform === 'win32' ? 'junction' : 'dir');
		} catch {
			// Environments without symlink permission still exercise missing-tail handling.
			expect(await canonicalizePath(path.join(actual, 'new', 'directory'))).toBe(
				path.join(actual, 'new', 'directory'),
			);
			return;
		}

		expect(await canonicalizePath(path.join(alias, 'new', 'directory'))).toBe(
			path.join(actual, 'new', 'directory'),
		);
	});

	it('creates sorted, canonical schema-v1 config and rejects overlapping roots', async () => {
		const root = await temporaryDirectory();
		const libraryRoot = path.join(root, 'library');
		const worktreeRoot = path.join(root, 'worktree');
		await Promise.all([mkdir(libraryRoot), mkdir(worktreeRoot)]);

		const config = await createConfig({
			libraryRoot: path.join(libraryRoot, '.'),
			worktreeRoot,
			projects: ['zeta', '.', 'apps\\nested', 'zeta'],
		});

		expect(config).toEqual({
			schemaVersion: CONFIG_SCHEMA_VERSION,
			libraryRoot,
			worktreeRoot,
			projects: ['.', 'apps/nested', 'zeta'],
		});
		expect(rootsOverlap(libraryRoot, path.join(libraryRoot, 'nested'))).toBe(true);
		expect(rootsOverlap(libraryRoot, worktreeRoot)).toBe(false);
		expect(isPathInside(libraryRoot, libraryRoot, {allowEqual: false})).toBe(false);
		expect(isPathInside(libraryRoot, path.dirname(libraryRoot))).toBe(false);
		expect(normalizeProjectRelativePath('apps//./web')).toBe('apps/web');
		expect(normalizeProjectRelativePath('././')).toBe('.');
		expect(() => normalizeProjectRelativePath('C:\\absolute')).toThrow(/relative/u);
		expect(() => normalizeProjectRelativePath('bad\0path')).toThrow(/strings/u);
		await expect(canonicalizePath(' ')).rejects.toMatchObject({
			code: 'CONFIG_PATH_INVALID',
		});
		await expect(
			createConfig({
				libraryRoot,
				worktreeRoot: path.join(libraryRoot, 'nested'),
			}),
		).rejects.toMatchObject({code: 'ROOTS_OVERLAP'});
	});

	it('atomically saves and loads config through a test override', async () => {
		const root = await temporaryDirectory();
		const libraryRoot = path.join(root, 'library');
		const worktreeRoot = path.join(root, 'worktree');
		const configPath = path.join(root, 'settings', 'config.json');
		await Promise.all([mkdir(libraryRoot), mkdir(worktreeRoot)]);

		expect(await configExists({configPath})).toBe(false);
		const saved = await saveConfig(
			{
				libraryRoot,
				worktreeRoot,
				projects: ['project'],
			},
			{configPath},
		);
		expect(await configExists({configPath})).toBe(true);
		expect(await loadConfig({configPath})).toEqual(saved);
		const replaced = await saveConfig(
			{...saved, projects: ['.', 'project']},
			{configPath},
		);
		expect(await loadConfig({configPath})).toEqual(replaced);
		expect(await readFile(configPath, 'utf8')).toBe(
			`${JSON.stringify(replaced, null, 2)}\n`,
		);
		expect(
			(await readFile(path.dirname(configPath), {encoding: 'utf8'}).catch(
				() => undefined,
			)) as unknown,
		).toBeUndefined();
	});

	it('gives typed errors for missing, malformed, and unsafe configs', async () => {
		const root = await temporaryDirectory();
		const missing = path.join(root, 'missing.json');
		await expect(loadConfig({configPath: missing})).rejects.toMatchObject({
			code: 'CONFIG_NOT_FOUND',
		});

		const malformed = path.join(root, 'malformed.json');
		await writeFile(malformed, '{');
		await expect(loadConfig({configPath: malformed})).rejects.toBeInstanceOf(
			ConfigError,
		);

		expect(() =>
			validateConfig({
				schemaVersion: 1,
				libraryRoot: path.resolve(root, 'library'),
				worktreeRoot: path.resolve(root, 'worktree'),
				projects: ['../escape'],
			}),
		).toThrow(/cannot leave/u);
		expect(() => normalizeProjectRelativePath('/absolute')).toThrow(/relative/u);

		const libraryRoot = path.resolve(root, 'library');
		const worktreeRoot = path.resolve(root, 'worktree');
		const base = {
			schemaVersion: 1,
			libraryRoot,
			worktreeRoot,
			projects: [],
		};
		const invalidValues: unknown[] = [
			null,
			{...base, schemaVersion: 2},
			{...base, libraryRoot: 'relative'},
			{...base, libraryRoot: `${libraryRoot}${path.sep}.`},
			{...base, worktreeRoot: path.join(libraryRoot, 'inside')},
			{...base, projects: 'not-an-array'},
			{...base, projects: ['app/./nested']},
			{...base, projects: ['app', 'app']},
			{...base, projects: ['z', 'a']},
		];
		for (const invalid of invalidValues) {
			expect(() => validateConfig(invalid)).toThrow(ConfigError);
		}

		await mkdir(path.join(root, 'directory-config'));
		await expect(
			loadConfig({configPath: path.join(root, 'directory-config')}),
		).rejects.toMatchObject({code: 'CONFIG_INVALID'});
		const blockedParent = path.join(root, 'file-parent');
		await writeFile(blockedParent, 'not a directory');
		await expect(
			saveConfig(base, {configPath: path.join(blockedParent, 'config.json')}),
		).rejects.toBeInstanceOf(ConfigError);
	});

	it('checks that configured roots exist and are directories', async () => {
		const root = await temporaryDirectory();
		const libraryRoot = path.join(root, 'library');
		const worktreeRoot = path.join(root, 'worktree');
		await Promise.all([mkdir(libraryRoot), mkdir(worktreeRoot)]);
		const config = await createConfig({libraryRoot, worktreeRoot});
		await expect(assertConfiguredRootsExist(config)).resolves.toBeUndefined();

		await rm(libraryRoot, {recursive: true});
		await expect(assertConfiguredRootsExist(config)).rejects.toMatchObject({
			code: 'CONFIG_PATH_INVALID',
		});
		await mkdir(libraryRoot);
		await rm(worktreeRoot, {recursive: true});
		await writeFile(worktreeRoot, 'file');
		await expect(assertConfiguredRootsExist(config)).rejects.toThrow(
			/not a directory/u,
		);
	});
});

describe('project mapping', () => {
	async function fixture() {
		const root = await temporaryDirectory();
		const libraryRoot = path.join(root, 'library');
		const worktreeRoot = path.join(root, 'worktree');
		await Promise.all([
			mkdir(path.join(libraryRoot, 'packages', 'child'), {recursive: true}),
			mkdir(path.join(worktreeRoot, 'packages', 'child'), {recursive: true}),
			mkdir(path.join(worktreeRoot, 'other'), {recursive: true}),
		]);
		const config = await createConfig({
			libraryRoot,
			worktreeRoot,
			projects: ['.', 'packages/child'],
		});
		return {root, libraryRoot, worktreeRoot, config};
	}

	it('maps root and nested projects to matching relative library paths', async () => {
		const {config, libraryRoot, worktreeRoot} = await fixture();
		expect(projectPaths(config, '.')).toEqual({
			relativePath: '.',
			worktreePath: worktreeRoot,
			libraryPath: libraryRoot,
		});
		expect(projectPaths(config, 'packages/child')).toEqual({
			relativePath: 'packages/child',
			worktreePath: path.join(worktreeRoot, 'packages', 'child'),
			libraryPath: path.join(libraryRoot, 'packages', 'child'),
		});
		expect(relativeProjectPath(config, worktreeRoot)).toBe('.');
		expect(
			relativeProjectPath(config, path.join(worktreeRoot, 'packages', 'child')),
		).toBe('packages/child');
		expect(() => relativeProjectPath(config, path.dirname(worktreeRoot))).toThrow(
			ProjectError,
		);
		expect(isRegisteredProject(config, '.')).toBe(true);
		expect(isRegisteredProject(config, 'other')).toBe(false);
		expect(getRegisteredProject(config, 'packages/child').relativePath).toBe(
			'packages/child',
		);
		expect(() => getRegisteredProject(config, 'other')).toThrow(
			/not registered/u,
		);
	});

	it('provides nested boundaries so parent walks cannot enter child projects', async () => {
		const {config, libraryRoot, worktreeRoot} = await fixture();
		expect(getNestedProjects(config, '.')).toEqual([
			{
				relativePath: 'packages/child',
				worktreePath: path.join(worktreeRoot, 'packages', 'child'),
				libraryPath: path.join(libraryRoot, 'packages', 'child'),
			},
		]);
		expect(getNestedProjectBoundaries(config, '.')).toEqual({
			worktree: [path.join(worktreeRoot, 'packages', 'child')],
			library: [path.join(libraryRoot, 'packages', 'child')],
		});
		expect(
			getNestedProjects(config, projectPaths(config, 'packages/child')),
		).toEqual([]);
		expect(
			pathCrossesNestedProject(
				path.join(worktreeRoot, 'packages', 'child', '.env'),
				[path.join(worktreeRoot, 'packages', 'child')],
			),
		).toBe(true);
		expect(
			pathCrossesNestedProject(path.join(worktreeRoot, 'safe.env'), [
				path.join(worktreeRoot, 'packages', 'child'),
			]),
		).toBe(false);

		const parent = projectPaths(config, '.');
		expect(() =>
			assertPathInProject(path.join(worktreeRoot, 'packages', 'child', '.env'), parent, {
				nestedProjectRoots: [
					path.join(worktreeRoot, 'packages', 'child'),
				],
			}),
		).toThrow(/nested registered project/u);
		expect(
			assertPathInProject(path.join(worktreeRoot, 'safe.env'), parent),
		).toBe(path.join(worktreeRoot, 'safe.env'));
		expect(
			assertPathInProject(path.join(libraryRoot, 'safe.env'), parent, {
				space: 'library',
			}),
		).toBe(path.join(libraryRoot, 'safe.env'));
		expect(() =>
			assertPathInProject(path.join(path.dirname(worktreeRoot), 'outside'), parent),
		).toThrow(/outside project/u);
		await expect(
			resolvePathInProject(
				path.join(worktreeRoot, 'packages', 'child', '.env'),
				parent,
				{
					nestedProjectRoots: [
						path.join(worktreeRoot, 'packages', 'child'),
					],
				},
			),
		).rejects.toThrow(/nested registered project/u);
		await expect(
			resolvePathInProject(path.join(libraryRoot, 'safe.env'), parent, {
				space: 'library',
			}),
		).resolves.toBe(path.join(libraryRoot, 'safe.env'));
	});

	it('rejects a symlink that resolves outside the project', async () => {
		const {root, config, worktreeRoot} = await fixture();
		const outside = path.join(root, 'outside');
		const link = path.join(worktreeRoot, 'outside-link');
		await mkdir(outside);
		try {
			await symlink(
				outside,
				link,
				process.platform === 'win32' ? 'junction' : 'dir',
			);
		} catch {
			return;
		}

		await expect(
			resolvePathInProject(path.join(link, 'secret.env'), projectPaths(config, '.')),
		).rejects.toMatchObject({code: 'PROJECT_PATH_INVALID'});
	});

	it('resolves only an exact registered Git root', async () => {
		const {config, worktreeRoot} = await fixture();
		const child = path.join(worktreeRoot, 'packages', 'child');

		const context = await resolveCurrentProject(
			config,
			path.join(child, 'src'),
			async () => child,
		);
		expect(context.relativePath).toBe('packages/child');
		expect(context.nestedProjects).toEqual([]);

		await expect(
			resolveCurrentProject(
				config,
				path.join(worktreeRoot, 'other'),
				async () => path.join(worktreeRoot, 'other'),
			),
		).rejects.toMatchObject({code: 'PROJECT_NOT_REGISTERED'});
		await expect(
			resolveCurrentProject(config, worktreeRoot, async () =>
				path.dirname(worktreeRoot),
			),
		).rejects.toMatchObject({code: 'PROJECT_OUTSIDE_WORKTREE'});
	});
});
