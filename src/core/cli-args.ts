import {parseArgs} from 'node:util';
import {UsageError} from './errors.js';

export type CliCommand =
	| {name: 'help'}
	| {name: 'version'}
	| {name: 'init'}
	| {name: 'push'; all: boolean}
	| {name: 'pull'}
	| {name: 'add'; paths: string[]}
	| {name: 'list'};

export function parseCliArguments(args: readonly string[]): CliCommand {
	let parsed;
	try {
		parsed = parseArgs({
			args: [...args],
			allowPositionals: true,
			strict: true,
			options: {
				all: {type: 'boolean'},
				help: {type: 'boolean', short: 'h'},
				version: {type: 'boolean', short: 'v'},
			},
		});
	} catch (error) {
		throw new UsageError(error instanceof Error ? error.message : String(error), {
			cause: error,
		});
	}

	if (parsed.values.version === true) {
		return {name: 'version'};
	}
	if (parsed.values.help === true || parsed.positionals.length === 0) {
		return {name: 'help'};
	}

	const [name, ...positionals] = parsed.positionals;
	if (name !== 'push' && parsed.values.all === true) {
		throw new UsageError('--all is supported only by "repo-lib push".');
	}

	switch (name) {
		case 'init':
		case 'pull':
		case 'list': {
			if (positionals.length > 0) {
				throw new UsageError(`"repo-lib ${name}" does not accept positional arguments.`);
			}
			return {name};
		}
		case 'push': {
			if (positionals.length > 0) {
				throw new UsageError('"repo-lib push" does not accept positional arguments.');
			}
			return {name, all: parsed.values.all === true};
		}
		case 'add': {
			if (positionals.length === 0) {
				throw new UsageError('"repo-lib add" requires at least one path.');
			}
			return {name, paths: positionals};
		}
		default: {
			throw new UsageError(`Unknown command "${name}".`);
		}
	}
}

export const HELP_TEXT = `repo-lib — keep untracked project files in a local library

Usage:
  repo-lib init
  repo-lib add <path...>
  repo-lib push [--all]
  repo-lib pull
  repo-lib list
  repo-lib --help
  repo-lib --version

Commands:
  init          Configure the library/worktree pair
  add           Add explicit untracked files or directories
  push          Update payload paths already present in the library
  push --all    Also add new, non-ignored untracked files
  pull          Fast-forward Git, then restore library payload
  list          List current-project payload files
`;
