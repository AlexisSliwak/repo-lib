import {mkdtemp, mkdir, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const temporaryRoot = await realpath(
	await mkdtemp(path.join(tmpdir(), 'repo-lib-pack-'))
);
const packed = run(
	pnpmCommand(),
	['pack', '--json', '--pack-destination', temporaryRoot],
	root
);
const report = parseJsonReport(packed.stdout);

if (!report?.filename || !Array.isArray(report.files)) {
	throw new Error('pnpm pack returned an unexpected report.');
}

const allowed = /^(?:package\.json|README\.md|LICENSE|dist\/)/u;
const unexpected = report.files
	.map(file => file.path)
	.filter(file => !allowed.test(file));

if (unexpected.length > 0) {
	throw new Error(`Unexpected packed files: ${unexpected.join(', ')}`);
}

const installRoot = path.join(temporaryRoot, 'install');
const tarballPath = path.isAbsolute(report.filename)
	? report.filename
	: path.join(temporaryRoot, report.filename);

try {
	await mkdir(installRoot, {recursive: true});
	await writeFile(path.join(installRoot, 'package.json'), '{"private":true}\n', 'utf8');
	run(
		pnpmCommand(),
		['add', '--ignore-scripts', tarballPath],
		installRoot
	);
	const smoke = run(pnpmCommand(), ['exec', 'repo-lib', '--help'], installRoot);
	if (!smoke.stdout.includes('repo-lib')) {
		throw new Error('Packaged CLI help did not run successfully.');
	}

	const worktreeRoot = path.join(installRoot, 'worktree');
	const projectRoot = path.join(worktreeRoot, 'project');
	const libraryRoot = path.join(installRoot, 'library');
	const libraryProject = path.join(libraryRoot, 'project');
	const configPath = path.join(installRoot, 'config', 'config.json');
	await mkdir(projectRoot, {recursive: true});
	await mkdir(libraryProject, {recursive: true});
	await mkdir(path.dirname(configPath), {recursive: true});
	run({executable: 'git', prefix: [], label: 'git'}, ['init', '-b', 'main'], projectRoot);
	await writeFile(path.join(projectRoot, 'package.json'), '{"private":true}\n', 'utf8');
	run(pnpmCommand(), ['add', '--ignore-scripts', tarballPath], projectRoot);
	await writeFile(path.join(libraryProject, '.env'), 'PACKAGED_SMOKE=1\n', 'utf8');
	await writeFile(
		configPath,
		`${JSON.stringify(
			{
				schemaVersion: 1,
				libraryRoot,
				worktreeRoot,
				projects: ['project']
			},
			null,
			2
		)}\n`,
		'utf8'
	);
	const list = run(
		pnpmCommand(),
		['exec', 'repo-lib', 'list'],
		projectRoot,
		{...process.env, REPO_LIB_CONFIG: configPath}
	);
	if (!list.stdout.includes('.env')) {
		throw new Error('Packaged CLI could not execute a real list command.');
	}
	if (list.stdout.includes('\u001B[')) {
		throw new Error('Packaged non-interactive list output contains ANSI control codes.');
	}
	process.stdout.write(`Verified ${report.filename} (${report.files.length} files).\n`);
} finally {
	await rm(temporaryRoot, {force: true, recursive: true});
}

function run(command, args, cwd, env = process.env) {
	const result = spawnSync(command.executable, [...command.prefix, ...args], {
		cwd,
		encoding: 'utf8',
		env,
		shell: false
	});
	if (result.error) {
		throw result.error;
	}
	if (result.status !== 0) {
		throw new Error(
			`${command.label} ${args.join(' ')} failed.\n${result.stdout ?? ''}${result.stderr ?? ''}`
		);
	}
	return result;
}

function parseJsonReport(output) {
	const start = output.indexOf('{');
	const end = output.lastIndexOf('}');
	if (start === -1 || end < start) {
		throw new Error('pnpm pack did not produce a JSON report.');
	}
	return JSON.parse(output.slice(start, end + 1));
}

function pnpmCommand() {
	if (process.platform === 'win32') {
		const corepackPnpm = path.join(
			path.dirname(process.execPath),
			'node_modules',
			'corepack',
			'dist',
			'pnpm.js'
		);
		if (existsSync(corepackPnpm)) {
			return {
				executable: process.execPath,
				prefix: [corepackPnpm],
				label: 'pnpm'
			};
		}
		return {
			executable: process.env.ComSpec ?? 'cmd.exe',
			prefix: ['/d', '/s', '/c', 'pnpm'],
			label: 'pnpm'
		};
	}
	return {executable: 'pnpm', prefix: [], label: 'pnpm'};
}
