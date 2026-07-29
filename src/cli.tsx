#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {render} from 'ink';
import React from 'react';
import {HELP_TEXT, parseCliArguments} from './core/cli-args.js';
import {errorMessage} from './core/errors.js';
import {
	addWorkflow,
	initWorkflow,
	listWorkflow,
	pullWorkflow,
	pushWorkflow,
	type WorkflowUi,
} from './core/workflows.js';
import {WorkflowApp} from './ui/workflow-app.js';

async function version(): Promise<string> {
	const packageJson = JSON.parse(
		await readFile(new URL('../package.json', import.meta.url), 'utf8'),
	) as {version?: unknown};
	return typeof packageJson.version === 'string' ? packageJson.version : 'unknown';
}

async function main(args: readonly string[]): Promise<number> {
	let command;
	try {
		command = parseCliArguments(args);
	} catch (error) {
		process.stderr.write(`repo-lib: ${errorMessage(error)}\n\n${HELP_TEXT}`);
		return 2;
	}

	if (command.name === 'help') {
		process.stdout.write(HELP_TEXT);
		return 0;
	}
	if (command.name === 'version') {
		process.stdout.write(`${await version()}\n`);
		return 0;
	}

	const workflow = async (ui: WorkflowUi): Promise<void> => {
		switch (command.name) {
			case 'init': {
				await initWorkflow(ui);
				break;
			}
			case 'add': {
				await addWorkflow(ui, command.paths);
				break;
			}
			case 'push': {
				await pushWorkflow(ui, command.all);
				break;
			}
			case 'pull': {
				await pullWorkflow(ui);
				break;
			}
			case 'list': {
				await listWorkflow(ui);
				break;
			}
		}
	};

	const instance = render(
		<WorkflowApp workflow={workflow} interactive={Boolean(process.stdin.isTTY)} />,
		{exitOnCtrlC: false},
	);
	const result = await instance.waitUntilExit();
	return typeof result === 'number' ? result : 0;
}

process.exitCode = await main(process.argv.slice(2)).catch((error: unknown) => {
	process.stderr.write(`repo-lib: ${errorMessage(error)}\n`);
	return 1;
});
