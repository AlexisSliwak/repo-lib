import {describe, expect, it} from 'vitest';
import {HELP_TEXT, parseCliArguments} from '../src/core/cli-args.js';
import {CancelledError, errorMessage} from '../src/core/errors.js';

describe('CLI argument parsing', () => {
	it('shows help with no command or --help', () => {
		expect(parseCliArguments([])).toEqual({name: 'help'});
		expect(parseCliArguments(['--help'])).toEqual({name: 'help'});
		expect(HELP_TEXT).toContain('repo-lib push [--all]');
	});

	it('parses version before the empty-command help fallback', () => {
		expect(parseCliArguments(['--version'])).toEqual({name: 'version'});
		expect(parseCliArguments(['-v'])).toEqual({name: 'version'});
	});

	it('parses every supported command', () => {
		expect(parseCliArguments(['init'])).toEqual({name: 'init'});
		expect(parseCliArguments(['pull'])).toEqual({name: 'pull'});
		expect(parseCliArguments(['list'])).toEqual({name: 'list'});
		expect(parseCliArguments(['push'])).toEqual({name: 'push', all: false});
		expect(parseCliArguments(['push', '--all'])).toEqual({name: 'push', all: true});
		expect(parseCliArguments(['add', '.env', 'secrets'])).toEqual({
			name: 'add',
			paths: ['.env', 'secrets'],
		});
	});

	it('rejects unknown, misplaced, and missing arguments', () => {
		expect(() => parseCliArguments(['wat'])).toThrow('Unknown command');
		expect(() => parseCliArguments(['pull', 'extra'])).toThrow('does not accept');
		expect(() => parseCliArguments(['add'])).toThrow('requires at least');
		expect(() => parseCliArguments(['list', '--all'])).toThrow('supported only');
		expect(() => parseCliArguments(['--wat'])).toThrow();
	});

	it('normalizes error and cancellation messages', () => {
		expect(errorMessage(new Error('broken'))).toBe('broken');
		expect(errorMessage('plain failure')).toBe('plain failure');
		expect(new CancelledError().exitCode).toBe(130);
	});
});
