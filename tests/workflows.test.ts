import {
	mkdir,
	readFile,
	readdir,
	rm,
	stat,
	writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {loadConfig, saveConfig} from '../src/core/config.js';
import {CancelledError} from '../src/core/errors.js';
import {writeRemoteMarker} from '../src/core/markers.js';
import {
	addWorkflow,
	formatBytes,
	initWorkflow,
	listWorkflow,
	pullWorkflow,
	pushWorkflow,
} from '../src/core/workflows.js';
import {
	FakeUi,
	createBareRemote,
	createSandbox,
	git,
	initRepository,
	type Sandbox,
} from './helpers.js';

describe('command workflows', () => {
	let sandbox: Sandbox;

	beforeEach(async () => {
		sandbox = await createSandbox();
	});

	afterEach(async () => {
		await sandbox.cleanup();
	});

	async function configuredProject(): Promise<string> {
		const project = path.join(sandbox.worktree, 'project');
		await initRepository(project, {commit: false});
		await mkdir(path.join(sandbox.library, 'project'), {recursive: true});
		await saveConfig(
			{
				libraryRoot: sandbox.library,
				worktreeRoot: sandbox.worktree,
				projects: ['project'],
			},
			{configPath: sandbox.configPath},
		);
		return project;
	}

	it('initializes an empty library and stores canonical roots', async () => {
		const ui = new FakeUi({
			select: ['empty'],
			text: [sandbox.library, sandbox.worktree],
		});
		const config = await initWorkflow(ui, {
			cwd: sandbox.root,
			configPath: sandbox.configPath,
		});
		expect(config.projects).toEqual([]);
		expect(await readdir(sandbox.library)).toEqual([]);
		expect(ui.messages.some(message => message.kind === 'warning')).toBe(true);
	});

	it.each(['empty', 'existing'])(
		'creates a missing worktree directory in %s mode',
		async mode => {
			const missingWorktree = path.join(sandbox.root, 'new', 'worktree');
			const ui = new FakeUi({
				select: [mode],
				text: [sandbox.library, missingWorktree],
			});

			const config = await initWorkflow(ui, {
				cwd: sandbox.root,
				configPath: sandbox.configPath,
			});

			expect((await stat(missingWorktree)).isDirectory()).toBe(true);
			expect(config.worktreeRoot).toBe(missingWorktree);
			expect(config.projects).toEqual([]);
		},
	);

	it('rejects a worktree path occupied by a file', async () => {
		const worktreeFile = path.join(sandbox.root, 'worktree-file');
		await writeFile(worktreeFile, 'not a directory');
		const ui = new FakeUi({
			select: ['empty'],
			text: [sandbox.library, worktreeFile],
		});

		await expect(
			initWorkflow(ui, {cwd: sandbox.root, configPath: sandbox.configPath}),
		).rejects.toThrow('must be a real directory');
		expect(await readFile(worktreeFile, 'utf8')).toBe('not a directory');
	});

	it('replaces an existing empty library and registers a confirmed local-only repository', async () => {
		const project = path.join(sandbox.worktree, 'local');
		await initRepository(project);
		await mkdir(sandbox.library);
		const ui = new FakeUi({
			select: ['existing'],
			text: [sandbox.library, sandbox.worktree],
			confirm: [true],
		});
		const config = await initWorkflow(ui, {
			cwd: sandbox.root,
			configPath: sandbox.configPath,
		});
		expect(config.projects).toEqual(['local']);
		expect(await readdir(path.join(sandbox.library, 'local'))).toEqual([]);
	});

	it('rejects a non-empty library destination without changing it', async () => {
		await mkdir(sandbox.library);
		await writeFile(path.join(sandbox.library, 'sentinel'), 'keep');
		const ui = new FakeUi({
			select: ['empty'],
			text: [sandbox.library, sandbox.worktree],
		});
		await expect(
			initWorkflow(ui, {cwd: sandbox.root, configPath: sandbox.configPath}),
		).rejects.toThrow('must be empty');
		expect(await readFile(path.join(sandbox.library, 'sentinel'), 'utf8')).toBe('keep');
	});

	it('builds only remote markers from an existing worktree', async () => {
		const project = path.join(sandbox.worktree, 'clients', 'acme');
		await initRepository(project);
		const remote = await createBareRemote(path.join(sandbox.root, 'remote-owner'));
		await git(project, 'remote', 'add', 'origin', remote);
		await git(project, 'push', '-u', 'origin', 'main');
		await writeFile(path.join(project, '.env'), 'SECRET=not-imported');

		const ui = new FakeUi({
			select: ['existing'],
			text: [sandbox.library, sandbox.worktree],
		});
		const config = await initWorkflow(ui, {
			cwd: sandbox.root,
			configPath: sandbox.configPath,
		});
		expect(config.projects).toEqual(['clients/acme']);
		const libraryProject = path.join(sandbox.library, 'clients', 'acme');
		expect(await readdir(libraryProject)).toEqual(['remote-repo.txt']);
		expect(await readFile(path.join(libraryProject, 'remote-repo.txt'), 'utf8')).toBe(
			`${remote}\n`,
		);
	});

	it('selects among multiple remotes and can skip a local-only repository', async () => {
		const remoteProject = path.join(sandbox.worktree, 'a-remote');
		const localProject = path.join(sandbox.worktree, 'z-local');
		await initRepository(remoteProject);
		await initRepository(localProject);
		const first = await createBareRemote(path.join(sandbox.root, 'first-owner'));
		const second = await createBareRemote(path.join(sandbox.root, 'second-owner'));
		await git(remoteProject, 'remote', 'add', 'alpha', first);
		await git(remoteProject, 'remote', 'add', 'beta', second);
		const ui = new FakeUi({
			select: ['existing', '1'],
			text: [sandbox.library, sandbox.worktree],
			confirm: [false],
		});

		const config = await initWorkflow(ui, {
			cwd: sandbox.root,
			configPath: sandbox.configPath,
		});
		expect(config.projects).toEqual(['a-remote']);
		expect(
			await readFile(
				path.join(sandbox.library, 'a-remote', 'remote-repo.txt'),
				'utf8',
			),
		).toBe(`${second}\n`);
		await expect(stat(path.join(sandbox.library, 'z-local'))).rejects.toMatchObject({
			code: 'ENOENT',
		});
	});

	it('adds explicitly selected ignored and untracked files but never tracked files', async () => {
		const project = await configuredProject();
		await writeFile(path.join(project, '.gitignore'), '.env\n');
		await mkdir(path.join(project, 'config'), {recursive: true});
		await writeFile(path.join(project, '.env'), 'TOKEN=secret');
		await writeFile(path.join(project, 'config', 'local.json'), '{"local":true}');
		await git(project, 'add', '.gitignore');
		await git(project, 'commit', '-m', 'ignore environment');

		const summary = await addWorkflow(new FakeUi(), ['.'], {
			cwd: project,
			configPath: sandbox.configPath,
		});
		expect(summary.copied).toEqual(['.env', 'config/local.json']);
		expect(await readFile(path.join(sandbox.library, 'project', '.env'), 'utf8')).toBe(
			'TOKEN=secret',
		);
		expect(summary.skipped.some(value => value.includes('tracked.txt (tracked)'))).toBe(
			true,
		);
		await expect(
			addWorkflow(new FakeUi(), [path.join(project, '..', 'outside')], {
				cwd: project,
				configPath: sandbox.configPath,
			}),
		).rejects.toThrow('escapes');
	});

	it('returns a clear no-op for tracked-only add and rejects an empty path list', async () => {
		const project = await configuredProject();
		const ui = new FakeUi();
		const result = await addWorkflow(ui, ['tracked.txt'], {
			cwd: project,
			configPath: sandbox.configPath,
		});
		expect(result.copied).toEqual([]);
		expect(ui.messages.some(message => message.message.includes('No eligible'))).toBe(true);
		await expect(
			addWorkflow(ui, [], {cwd: project, configPath: sandbox.configPath}),
		).rejects.toMatchObject({exitCode: 2});
	});

	it('does not cross an unregistered nested Git repository during add', async () => {
		const project = await configuredProject();
		const nested = path.join(project, 'nested');
		await initRepository(nested);
		await writeFile(path.join(nested, '.env'), 'nested secret');
		const result = await addWorkflow(new FakeUi(), ['nested'], {
			cwd: project,
			configPath: sandbox.configPath,
		});
		expect(result.copied).toEqual([]);
		expect(result.skipped).toContain('nested (nested-project)');
		await expect(
			stat(path.join(sandbox.library, 'project', 'nested', '.env')),
		).rejects.toMatchObject({code: 'ENOENT'});
		const direct = await addWorkflow(new FakeUi(), ['nested/.env'], {
			cwd: project,
			configPath: sandbox.configPath,
		});
		expect(direct.copied).toEqual([]);
	});

	it('lazily registers a new remote-backed project and writes its marker', async () => {
		const project = path.join(sandbox.worktree, 'project');
		await initRepository(project);
		const remote = await createBareRemote(path.join(sandbox.root, 'lazy-remote'));
		await git(project, 'remote', 'add', 'origin', remote);
		await writeFile(path.join(project, '.env'), 'secret');
		await mkdir(sandbox.library);
		await saveConfig(
			{
				libraryRoot: sandbox.library,
				worktreeRoot: sandbox.worktree,
				projects: [],
			},
			{configPath: sandbox.configPath},
		);
		const ui = new FakeUi();
		await addWorkflow(ui, ['.env'], {
			cwd: project,
			configPath: sandbox.configPath,
		});
		expect((await loadConfig({configPath: sandbox.configPath})).projects).toEqual([
			'project',
		]);
		expect(
			await readFile(path.join(sandbox.library, 'project', 'remote-repo.txt'), 'utf8'),
		).toBe(`${remote}\n`);
		expect(ui.messages.some(message => message.message.includes('Associated'))).toBe(true);
	});

	it('rejects an existing marker that no longer matches a configured remote', async () => {
		const project = await configuredProject();
		await writeRemoteMarker(
			path.join(sandbox.library, 'project'),
			'https://wrong.example/repo.git',
		);
		await expect(
			addWorkflow(new FakeUi(), ['tracked.txt'], {
				cwd: project,
				configPath: sandbox.configPath,
			}),
		).rejects.toThrow('does not match any configured Git remote');
	});

	it('push updates known payload, retains missing payload, prunes tracked data, and --all adds only non-ignored files', async () => {
		const project = await configuredProject();
		const libraryProject = path.join(sandbox.library, 'project');
		await writeFile(path.join(project, '.gitignore'), 'ignored.log\n');
		await git(project, 'add', '.gitignore');
		await git(project, 'commit', '-m', 'ignore logs');
		await writeFile(path.join(project, '.env'), 'new value');
		await writeFile(path.join(project, 'new.txt'), 'new file');
		await writeFile(path.join(project, 'ignored.log'), 'bulk');
		await writeFile(path.join(libraryProject, '.env'), 'old value');
		await writeFile(path.join(libraryProject, 'missing.env'), 'preserve');
		await writeFile(path.join(libraryProject, 'tracked.txt'), 'must delete');

		const first = await pushWorkflow(new FakeUi({confirm: [true]}), false, {
			cwd: project,
			configPath: sandbox.configPath,
		});
		expect(first.copied).toEqual(['.env']);
		expect(first.removed).toEqual(['tracked.txt']);
		expect(await readFile(path.join(libraryProject, 'missing.env'), 'utf8')).toBe(
			'preserve',
		);
		await expect(stat(path.join(libraryProject, 'new.txt'))).rejects.toMatchObject({
			code: 'ENOENT',
		});

		const second = await pushWorkflow(
			new FakeUi({confirm: [true, true]}),
			true,
			{cwd: project, configPath: sandbox.configPath},
		);
		expect(second.copied).toContain('new.txt');
		expect(await readFile(path.join(libraryProject, 'new.txt'), 'utf8')).toBe(
			'new file',
		);
		await expect(stat(path.join(libraryProject, 'ignored.log'))).rejects.toMatchObject({
			code: 'ENOENT',
		});
	});

	it('cancels local-only push before copying payload', async () => {
		const project = await configuredProject();
		await writeFile(path.join(project, '.env'), 'new');
		await writeFile(path.join(sandbox.library, 'project', '.env'), 'old');
		await expect(
			pushWorkflow(new FakeUi({confirm: [false]}), false, {
				cwd: project,
				configPath: sandbox.configPath,
			}),
		).rejects.toBeInstanceOf(CancelledError);
		expect(await readFile(path.join(sandbox.library, 'project', '.env'), 'utf8')).toBe(
			'old',
		);
	});

	it('cancels --all when new files are declined', async () => {
		const project = await configuredProject();
		await writeFile(path.join(project, 'new.txt'), 'new');
		await expect(
			pushWorkflow(new FakeUi({confirm: [true, false]}), true, {
				cwd: project,
				configPath: sandbox.configPath,
			}),
		).rejects.toBeInstanceOf(CancelledError);
		await expect(
			stat(path.join(sandbox.library, 'project', 'new.txt')),
		).rejects.toMatchObject({code: 'ENOENT'});
	});

	it('skips a known payload whose worktree source became a directory', async () => {
		const project = await configuredProject();
		await writeFile(path.join(sandbox.library, 'project', 'shape'), 'old file');
		await mkdir(path.join(project, 'shape'));
		const result = await pushWorkflow(new FakeUi({confirm: [true]}), false, {
			cwd: project,
			configPath: sandbox.configPath,
		});
		expect(result.copied).toEqual([]);
		expect(result.skipped).toContain('shape (link or special)');
	});

	it('restores local-only payload after confirmation and deletes tracked library files', async () => {
		const project = await configuredProject();
		const libraryProject = path.join(sandbox.library, 'project');
		await writeFile(path.join(project, '.env'), 'worktree');
		await writeFile(path.join(libraryProject, '.env'), 'library');
		await writeFile(path.join(libraryProject, 'tracked.txt'), 'bad');
		const ui = new FakeUi({confirm: [true]});
		const result = await pullWorkflow(ui, {
			cwd: project,
			configPath: sandbox.configPath,
		});
		expect(result.copied).toEqual(['.env']);
		expect(result.removed).toEqual(['tracked.txt']);
		expect(await readFile(path.join(project, '.env'), 'utf8')).toBe('library');
		expect(ui.messages.some(message => message.message.includes('no remote'))).toBe(true);
	});

	it('keeps a differing worktree payload when local pull is cancelled', async () => {
		const project = await configuredProject();
		await writeFile(path.join(project, '.env'), 'worktree');
		await writeFile(path.join(sandbox.library, 'project', '.env'), 'library');
		await expect(
			pullWorkflow(new FakeUi({confirm: [false]}), {
				cwd: project,
				configPath: sandbox.configPath,
			}),
		).rejects.toBeInstanceOf(CancelledError);
		expect(await readFile(path.join(project, '.env'), 'utf8')).toBe('worktree');
	});

	it('rejects a file/directory overlay conflict before copying anything', async () => {
		const project = await configuredProject();
		await mkdir(path.join(project, '.env'));
		await writeFile(path.join(sandbox.library, 'project', '.env'), 'library');
		await expect(
			pullWorkflow(new FakeUi(), {
				cwd: project,
				configPath: sandbox.configPath,
			}),
		).rejects.toThrow('destination is a directory');
	});

	it('does not rewrite identical local-only payload', async () => {
		const project = await configuredProject();
		await writeFile(path.join(project, '.env'), 'same');
		await writeFile(path.join(sandbox.library, 'project', '.env'), 'same');
		const result = await pullWorkflow(new FakeUi(), {
			cwd: project,
			configPath: sandbox.configPath,
		});
		expect(result.copied).toEqual([]);
	});

	it('fast-forwards from the associated remote before restoring payload', async () => {
		const source = path.join(sandbox.root, 'source');
		await initRepository(source);
		const remote = await createBareRemote(path.join(sandbox.root, 'network'));
		await git(source, 'remote', 'add', 'origin', remote);
		await git(source, 'push', '-u', 'origin', 'main');
		const project = path.join(sandbox.worktree, 'project');
		await git(sandbox.worktree, 'clone', '--branch', 'main', remote, project);
		await mkdir(path.join(sandbox.library, 'project'), {recursive: true});
		await writeRemoteMarker(path.join(sandbox.library, 'project'), remote);
		await writeFile(path.join(sandbox.library, 'project', '.env'), 'restored');
		await saveConfig(
			{
				libraryRoot: sandbox.library,
				worktreeRoot: sandbox.worktree,
				projects: ['project'],
			},
			{configPath: sandbox.configPath},
		);

		await writeFile(path.join(source, 'tracked.txt'), 'remote update\n');
		await git(source, 'add', 'tracked.txt');
		await git(source, 'commit', '-m', 'remote update');
		await git(source, 'push');

		const result = await pullWorkflow(new FakeUi(), {
			cwd: project,
			configPath: sandbox.configPath,
		});
		expect(await readFile(path.join(project, 'tracked.txt'), 'utf8')).toBe(
			'remote update\n',
		);
		expect(await readFile(path.join(project, '.env'), 'utf8')).toBe('restored');
		expect(result.copied).toEqual(['.env']);

		await writeFile(path.join(sandbox.library, 'project', '.env'), 'library second');
		await writeFile(path.join(project, '.env'), 'worktree second');
		await writeFile(path.join(source, 'tracked.txt'), 'second remote update\n');
		await git(source, 'add', 'tracked.txt');
		await git(source, 'commit', '-m', 'second remote update');
		await git(source, 'push');
		await expect(
			pullWorkflow(new FakeUi({confirm: [false]}), {
				cwd: project,
				configPath: sandbox.configPath,
			}),
		).rejects.toThrow('Git was updated');
		expect(await readFile(path.join(project, 'tracked.txt'), 'utf8')).toBe(
			'second remote update\n',
		);
		expect(await readFile(path.join(project, '.env'), 'utf8')).toBe(
			'worktree second',
		);

		await rm(path.join(project, '.env'));
		await writeFile(path.join(source, '.env'), 'now remote tracked');
		await git(source, 'add', '.env');
		await git(source, 'commit', '-m', 'track environment');
		await git(source, 'push');
		const trackingResult = await pullWorkflow(new FakeUi(), {
			cwd: project,
			configPath: sandbox.configPath,
		});
		expect(await readFile(path.join(project, '.env'), 'utf8')).toBe(
			'now remote tracked',
		);
		expect(trackingResult.removed).toContain('.env');
		await expect(
			stat(path.join(sandbox.library, 'project', '.env')),
		).rejects.toMatchObject({code: 'ENOENT'});
	});

	it('lists only current-project payload and hides nested projects and metadata', async () => {
		const project = await configuredProject();
		const nested = path.join(project, 'nested');
		await initRepository(nested);
		await mkdir(path.join(sandbox.library, 'project', 'nested'), {recursive: true});
		await writeFile(path.join(sandbox.library, 'project', '.env'), 'parent');
		await writeFile(path.join(sandbox.library, 'project', 'remote-repo.txt'), 'url\n');
		await writeFile(
			path.join(sandbox.library, 'project', 'nested', 'nested.env'),
			'child',
		);
		await saveConfig(
			{
				libraryRoot: sandbox.library,
				worktreeRoot: sandbox.worktree,
				projects: ['project', 'project/nested'],
			},
			{configPath: sandbox.configPath},
		);
		const ui = new FakeUi();
		expect(
			await listWorkflow(ui, {cwd: project, configPath: sandbox.configPath}),
		).toEqual(['.env']);
		expect(ui.messages.map(message => message.message)).toContain('.env');
	});

	it('reports an empty payload list', async () => {
		const project = await configuredProject();
		const ui = new FakeUi();
		expect(
			await listWorkflow(ui, {cwd: project, configPath: sandbox.configPath}),
		).toEqual([]);
		expect(ui.messages.some(message => message.message.includes('No payload'))).toBe(true);
	});

	it('formats byte previews compactly', () => {
		expect(formatBytes(42)).toBe('42 B');
		expect(formatBytes(2048)).toBe('2.0 KiB');
		expect(formatBytes(2 * 1024 * 1024)).toBe('2.0 MiB');
		expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe('2.0 GiB');
	});
});
