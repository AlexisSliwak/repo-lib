import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {RepoLibError} from './errors.js';
import {REMOTE_REPO_FILE} from './projects.js';

export function validateRemoteUrl(url: string): string {
	const value = url.trim();
	if (
		value === '' ||
		value.startsWith('-') ||
		value.includes('\0') ||
		/[\r\n]/u.test(value)
	) {
		throw new RepoLibError('A remote URL must be one non-empty line.');
	}
	return value;
}

export async function readRemoteMarker(
	libraryProjectRoot: string,
): Promise<string | undefined> {
	const marker = path.join(libraryProjectRoot, REMOTE_REPO_FILE);
	try {
		const raw = await readFile(marker, 'utf8');
		const withoutFinalNewline = raw.endsWith('\r\n')
			? raw.slice(0, -2)
			: raw.endsWith('\n')
				? raw.slice(0, -1)
				: raw;
		return validateRemoteUrl(withoutFinalNewline);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return undefined;
		}
		if (error instanceof RepoLibError) {
			throw new RepoLibError(`Invalid remote marker at "${marker}": ${error.message}`, 1, {
				cause: error,
			});
		}
		throw error;
	}
}

export async function writeRemoteMarker(
	libraryProjectRoot: string,
	url: string,
): Promise<void> {
	await import('node:fs/promises').then(({mkdir}) =>
		mkdir(libraryProjectRoot, {recursive: true}),
	);
	await writeFile(
		path.join(libraryProjectRoot, REMOTE_REPO_FILE),
		`${validateRemoteUrl(url)}\n`,
		'utf8',
	);
}
