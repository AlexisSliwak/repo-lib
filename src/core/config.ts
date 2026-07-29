import {constants as fsConstants} from 'node:fs';
import {
	access,
	chmod,
	mkdir,
	readFile,
	realpath,
	rename,
	rm,
	stat,
	writeFile,
} from 'node:fs/promises';
import {homedir, platform as currentPlatform} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

export const CONFIG_SCHEMA_VERSION = 1 as const;
export const CONFIG_PATH_ENV = 'REPO_LIB_CONFIG';

export interface RepoLibConfig {
	schemaVersion: typeof CONFIG_SCHEMA_VERSION;
	libraryRoot: string;
	worktreeRoot: string;
	projects: string[];
}

export interface ConfigPathOptions {
	/** An explicit config file, primarily useful for embedding and tests. */
	configPath?: string;
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	homeDir?: string;
}

export interface CreateConfigOptions {
	libraryRoot: string;
	worktreeRoot: string;
	projects?: readonly string[];
	cwd?: string;
}

export class ConfigError extends Error {
	readonly code:
		| 'CONFIG_INVALID'
		| 'CONFIG_NOT_FOUND'
		| 'CONFIG_PATH_INVALID'
		| 'ROOTS_OVERLAP';

	constructor(
		message: string,
		code: ConfigError['code'] = 'CONFIG_INVALID',
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = 'ConfigError';
		this.code = code;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function comparable(value: string): string {
	const normalized = path.normalize(value);
	return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function isPathInside(
	parent: string,
	candidate: string,
	options: {allowEqual?: boolean} = {},
): boolean {
	const parentValue = comparable(path.resolve(parent));
	const candidateValue = comparable(path.resolve(candidate));
	const relative = path.relative(parentValue, candidateValue);

	if (relative === '') {
		return options.allowEqual ?? true;
	}

	return (
		relative !== '..' &&
		!relative.startsWith(`..${path.sep}`) &&
		!path.isAbsolute(relative)
	);
}

export function rootsOverlap(first: string, second: string): boolean {
	return (
		isPathInside(first, second, {allowEqual: true}) ||
		isPathInside(second, first, {allowEqual: true})
	);
}

/**
 * Returns a real, absolute path even when the final path does not exist. The
 * closest existing ancestor is resolved through symlinks and the missing tail
 * is then appended.
 */
export async function canonicalizePath(
	input: string,
	cwd = process.cwd(),
): Promise<string> {
	if (typeof input !== 'string' || input.trim() === '') {
		throw new ConfigError('A path must be a non-empty string.', 'CONFIG_PATH_INVALID');
	}

	const absolute = path.resolve(cwd, input);
	const missingParts: string[] = [];
	let cursor = absolute;

	for (;;) {
		try {
			const resolvedAncestor = await realpath(cursor);
			return path.resolve(resolvedAncestor, ...missingParts.reverse());
		} catch (error) {
			const nodeError = error as NodeJS.ErrnoException;
			if (nodeError.code !== 'ENOENT' && nodeError.code !== 'ENOTDIR') {
				throw new ConfigError(
					`Cannot resolve path "${input}": ${nodeError.message}`,
					'CONFIG_PATH_INVALID',
					{cause: error},
				);
			}
		}

		const parent = path.dirname(cursor);
		if (parent === cursor) {
			throw new ConfigError(
				`Cannot find an existing ancestor for "${input}".`,
				'CONFIG_PATH_INVALID',
			);
		}

		missingParts.push(path.basename(cursor));
		cursor = parent;
	}
}

export function normalizeProjectRelativePath(project: string): string {
	if (typeof project !== 'string' || project.includes('\0')) {
		throw new ConfigError('Project paths must be non-empty strings.');
	}

	const slashPath = project.replaceAll('\\', '/');
	if (slashPath === '' || slashPath === '.') {
		return '.';
	}

	if (
		slashPath.startsWith('/') ||
		/^[a-zA-Z]:\//u.test(slashPath) ||
		slashPath.startsWith('//')
	) {
		throw new ConfigError(`Project path "${project}" must be relative.`);
	}

	const parts = slashPath.split('/').filter(part => part !== '' && part !== '.');
	if (parts.length === 0) {
		return '.';
	}

	if (parts.some(part => part === '..')) {
		throw new ConfigError(`Project path "${project}" cannot leave the configured root.`);
	}

	return parts.join('/');
}

export function validateConfig(value: unknown): asserts value is RepoLibConfig {
	if (!isRecord(value)) {
		throw new ConfigError('Configuration must be a JSON object.');
	}

	if (value.schemaVersion !== CONFIG_SCHEMA_VERSION) {
		throw new ConfigError(
			`Unsupported configuration schema version "${String(value.schemaVersion)}".`,
		);
	}

	for (const key of ['libraryRoot', 'worktreeRoot'] as const) {
		const root = value[key];
		if (typeof root !== 'string' || root.trim() === '' || !path.isAbsolute(root)) {
			throw new ConfigError(`Configuration field "${key}" must be an absolute path.`);
		}
		if (path.normalize(root) !== root) {
			throw new ConfigError(`Configuration field "${key}" must be normalized.`);
		}
	}

	if (rootsOverlap(value.libraryRoot as string, value.worktreeRoot as string)) {
		throw new ConfigError(
			'The library and worktree directories cannot be the same or contain one another.',
			'ROOTS_OVERLAP',
		);
	}

	if (!Array.isArray(value.projects)) {
		throw new ConfigError('Configuration field "projects" must be an array.');
	}

	const seen = new Set<string>();
	let previous: string | undefined;
	for (const project of value.projects) {
		const normalized = normalizeProjectRelativePath(project);
		if (project !== normalized) {
			throw new ConfigError(`Project path "${String(project)}" must be normalized.`);
		}
		if (seen.has(normalized)) {
			throw new ConfigError(`Duplicate project path "${normalized}".`);
		}
		if (previous !== undefined && previous.localeCompare(normalized) > 0) {
			throw new ConfigError('Project paths must be stored in lexical order.');
		}
		seen.add(normalized);
		previous = normalized;
	}
}

export async function createConfig(
	options: CreateConfigOptions,
): Promise<RepoLibConfig> {
	const [libraryRoot, worktreeRoot] = await Promise.all([
		canonicalizePath(options.libraryRoot, options.cwd),
		canonicalizePath(options.worktreeRoot, options.cwd),
	]);

	if (rootsOverlap(libraryRoot, worktreeRoot)) {
		throw new ConfigError(
			'The library and worktree directories cannot be the same or contain one another.',
			'ROOTS_OVERLAP',
		);
	}

	const projects = [
		...new Set((options.projects ?? []).map(normalizeProjectRelativePath)),
	].sort((first, second) => first.localeCompare(second));

	const config: RepoLibConfig = {
		schemaVersion: CONFIG_SCHEMA_VERSION,
		libraryRoot,
		worktreeRoot,
		projects,
	};
	validateConfig(config);
	return config;
}

export function getConfigPath(options: ConfigPathOptions = {}): string {
	const env = options.env ?? process.env;
	const explicit = options.configPath ?? env[CONFIG_PATH_ENV];
	if (explicit !== undefined) {
		if (explicit.trim() === '') {
			throw new ConfigError(
				`${CONFIG_PATH_ENV} cannot be empty.`,
				'CONFIG_PATH_INVALID',
			);
		}
		return path.resolve(explicit);
	}

	const targetPlatform = options.platform ?? currentPlatform();
	const home = options.homeDir ?? homedir();
	let configDirectory: string;

	if (targetPlatform === 'win32') {
		configDirectory = env.APPDATA
			? path.resolve(env.APPDATA)
			: path.join(home, 'AppData', 'Roaming');
	} else if (targetPlatform === 'darwin') {
		configDirectory = path.join(home, 'Library', 'Application Support');
	} else {
		configDirectory = env.XDG_CONFIG_HOME
			? path.resolve(env.XDG_CONFIG_HOME)
			: path.join(home, '.config');
	}

	return path.join(configDirectory, 'repo-lib', 'config.json');
}

export async function configExists(options: ConfigPathOptions = {}): Promise<boolean> {
	try {
		await access(getConfigPath(options), fsConstants.F_OK);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return false;
		}
		throw error;
	}
}

export async function loadConfig(
	options: ConfigPathOptions = {},
): Promise<RepoLibConfig> {
	const configPath = getConfigPath(options);
	let raw: string;
	try {
		raw = await readFile(configPath, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			throw new ConfigError(
				`No repo-lib configuration exists at "${configPath}". Run "repo-lib init" first.`,
				'CONFIG_NOT_FOUND',
				{cause: error},
			);
		}
		throw new ConfigError(
			`Cannot read configuration at "${configPath}".`,
			'CONFIG_INVALID',
			{cause: error},
		);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw) as unknown;
	} catch (error) {
		throw new ConfigError(
			`Configuration at "${configPath}" is not valid JSON.`,
			'CONFIG_INVALID',
			{cause: error},
		);
	}

	validateConfig(parsed);
	const canonical = await createConfig(parsed);

	if (
		canonical.libraryRoot !== parsed.libraryRoot ||
		canonical.worktreeRoot !== parsed.worktreeRoot
	) {
		throw new ConfigError(
			`Configuration at "${configPath}" contains non-canonical root paths.`,
		);
	}

	return parsed;
}

export async function saveConfig(
	config: RepoLibConfig | CreateConfigOptions,
	options: ConfigPathOptions = {},
): Promise<RepoLibConfig> {
	const normalized = await createConfig(config);
	const configPath = getConfigPath(options);
	const directory = path.dirname(configPath);
	const temporaryPath = path.join(
		directory,
		`.${path.basename(configPath)}.${process.pid}.${randomUUID()}.tmp`,
	);

	try {
		await mkdir(directory, {recursive: true, mode: 0o700});
		await writeFile(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`, {
			encoding: 'utf8',
			mode: 0o600,
			flag: 'wx',
		});
		await rename(temporaryPath, configPath);
		try {
			await chmod(configPath, 0o600);
		} catch {
			// Windows and some mounted filesystems do not support POSIX permissions.
		}
	} catch (error) {
		await rm(temporaryPath, {force: true}).catch(() => undefined);
		throw new ConfigError(
			`Cannot save configuration at "${configPath}".`,
			'CONFIG_INVALID',
			{cause: error},
		);
	}

	return normalized;
}

/** Read-only validation useful to callers that need clear missing-root errors. */
export async function assertConfiguredRootsExist(config: RepoLibConfig): Promise<void> {
	for (const [label, root] of [
		['library', config.libraryRoot],
		['worktree', config.worktreeRoot],
	] as const) {
		try {
			const rootStat = await stat(root);
			if (!rootStat.isDirectory()) {
				throw new ConfigError(`The configured ${label} root is not a directory: "${root}".`);
			}
		} catch (error) {
			if (error instanceof ConfigError) {
				throw error;
			}
			throw new ConfigError(
				`The configured ${label} root is unavailable: "${root}".`,
				'CONFIG_PATH_INVALID',
				{cause: error},
			);
		}
	}
}
