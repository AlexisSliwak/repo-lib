import {execFile} from 'node:child_process';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import type {SelectOption, WorkflowUi} from '../src/core/workflows.js';

const execFileAsync = promisify(execFile);

export interface Sandbox {
	root: string;
	worktree: string;
	library: string;
	configPath: string;
	cleanup(): Promise<void>;
}

export async function createSandbox(): Promise<Sandbox> {
	const root = await mkdtemp(path.join(tmpdir(), 'repo-lib-workflow-'));
	const worktree = path.join(root, 'worktree');
	const library = path.join(root, 'library');
	const configPath = path.join(root, 'config', 'config.json');
	await mkdir(worktree, {recursive: true});
	return {
		root,
		worktree,
		library,
		configPath,
		cleanup: async () =>
			rm(root, {
				force: true,
				maxRetries: 5,
				recursive: true,
				retryDelay: 50,
			}),
	};
}

export async function git(cwd: string, ...args: string[]): Promise<string> {
	const result = await execFileAsync(
		'git',
		['-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false', ...args],
		{
		cwd,
		encoding: 'utf8',
		env: {
			...process.env,
			GIT_AUTHOR_NAME: 'Repo Lib Tests',
			GIT_AUTHOR_EMAIL: 'repo-lib@example.invalid',
			GIT_COMMITTER_NAME: 'Repo Lib Tests',
			GIT_COMMITTER_EMAIL: 'repo-lib@example.invalid',
			GIT_TERMINAL_PROMPT: '0',
		},
		windowsHide: true,
		},
	);
	return result.stdout.trim();
}

export async function initRepository(
	directory: string,
	options: {commit?: boolean} = {},
): Promise<void> {
	await mkdir(directory, {recursive: true});
	await git(directory, 'init', '-b', 'main');
	await writeFile(path.join(directory, 'tracked.txt'), 'tracked\n');
	await git(directory, 'add', 'tracked.txt');
	if (options.commit ?? true) {
		await git(directory, 'commit', '-m', 'initial');
	}
}

export async function createBareRemote(root: string): Promise<string> {
	const remote = path.join(root, 'remote.git');
	await mkdir(remote, {recursive: true});
	await git(remote, 'init', '--bare');
	return remote;
}

export class FakeUi implements WorkflowUi {
	readonly messages: Array<{kind: string; message: string}> = [];
	readonly textAnswers: string[];
	readonly selectAnswers: string[];
	readonly confirmAnswers: boolean[];

	constructor(options: {
		text?: string[];
		select?: string[];
		confirm?: boolean[];
	} = {}) {
		this.textAnswers = [...(options.text ?? [])];
		this.selectAnswers = [...(options.select ?? [])];
		this.confirmAnswers = [...(options.confirm ?? [])];
	}

	async text(message: string, placeholder?: string): Promise<string> {
		this.messages.push({kind: 'prompt:text', message});
		return this.textAnswers.shift() ?? placeholder ?? '';
	}

	async select(message: string, options: readonly SelectOption[]): Promise<string> {
		this.messages.push({kind: 'prompt:select', message});
		return this.selectAnswers.shift() ?? options[0]?.value ?? '';
	}

	async confirm(message: string): Promise<boolean> {
		this.messages.push({kind: 'prompt:confirm', message});
		return this.confirmAnswers.shift() ?? false;
	}

	info(message: string): void {
		this.messages.push({kind: 'info', message});
	}

	warn(message: string): void {
		this.messages.push({kind: 'warning', message});
	}

	success(message: string): void {
		this.messages.push({kind: 'success', message});
	}

	async busy<T>(message: string, operation: () => Promise<T>): Promise<T> {
		this.messages.push({kind: 'busy', message});
		return operation();
	}
}
