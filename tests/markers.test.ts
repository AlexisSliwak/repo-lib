import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
	readRemoteMarker,
	validateRemoteUrl,
	writeRemoteMarker,
} from '../src/core/markers.js';
import {createSandbox, type Sandbox} from './helpers.js';

describe('remote-repo.txt metadata', () => {
	let sandbox: Sandbox;

	beforeEach(async () => {
		sandbox = await createSandbox();
		await mkdir(sandbox.library, {recursive: true});
	});

	afterEach(async () => sandbox.cleanup());

	it('round-trips one-line URLs and accepts CRLF', async () => {
		await writeRemoteMarker(sandbox.library, 'https://example.test/repo.git');
		expect(await readRemoteMarker(sandbox.library)).toBe(
			'https://example.test/repo.git',
		);
		await writeFile(
			path.join(sandbox.library, 'remote-repo.txt'),
			'ssh://example/repo.git\r\n',
		);
		expect(await readRemoteMarker(sandbox.library)).toBe('ssh://example/repo.git');
		await writeFile(
			path.join(sandbox.library, 'remote-repo.txt'),
			'https://example.test/no-final-newline',
		);
		expect(await readRemoteMarker(sandbox.library)).toBe(
			'https://example.test/no-final-newline',
		);
	});

	it('returns undefined for a missing marker and rejects malformed values', async () => {
		expect(await readRemoteMarker(sandbox.library)).toBeUndefined();
		expect(() => validateRemoteUrl('')).toThrow('non-empty');
		expect(() => validateRemoteUrl('one\ntwo')).toThrow('one non-empty line');
		expect(() => validateRemoteUrl('one\0two')).toThrow('one non-empty line');
		expect(() => validateRemoteUrl('--upload-pack=malicious')).toThrow(
			'one non-empty line',
		);
		await writeFile(path.join(sandbox.library, 'remote-repo.txt'), '\n');
		await expect(readRemoteMarker(sandbox.library)).rejects.toThrow('Invalid remote marker');
	});
});
