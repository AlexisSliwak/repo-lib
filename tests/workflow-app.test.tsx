import React from 'react';
import {cleanup, render} from 'ink-testing-library';
import {afterEach, describe, expect, it} from 'vitest';
import {WorkflowApp} from '../src/ui/workflow-app.js';

afterEach(() => cleanup());

async function waitForFrame(
	frames: readonly string[],
	pattern: RegExp,
): Promise<string> {
	const latestVisibleFrame = (): string =>
		frames.findLast(frame => frame.trim().length > 0) ?? '';
	await expect.poll(latestVisibleFrame, {timeout: 2000}).toMatch(pattern);
	return latestVisibleFrame();
}

async function waitForInputFrame(
	frames: readonly string[],
	pattern: RegExp,
): Promise<string> {
	const frame = await waitForFrame(frames, pattern);
	await new Promise<void>(resolve => {
		setImmediate(resolve);
	});
	return frame;
}

describe('WorkflowApp', () => {
	it('renders select, text, confirmation, busy, and success states', async () => {
		const instance = render(
			<WorkflowApp
				interactive
				workflow={async ui => {
					const choice = await ui.select('Choose a mode', [
						{label: 'First', value: 'first'},
						{label: 'Second', value: 'second'},
					]);
					const name = await ui.text('Enter a value');
					const confirmed = await ui.confirm('Continue?');
					await ui.busy('Working', async () => Promise.resolve());
					ui.info(`${choice}:${name}`);
					if (confirmed) {
						ui.success('Complete');
					}
				}}
			/>,
		);
		await waitForInputFrame(instance.frames, /Choose a mode/u);
		instance.stdin.write('\u001B[B');
		await waitForInputFrame(instance.frames, /[❯>] Second/u);
		instance.stdin.write('\r');
		await waitForInputFrame(instance.frames, /Enter a value/u);
		instance.stdin.write('value');
		await waitForFrame(instance.frames, /value/u);
		instance.stdin.write('\r');
		await waitForInputFrame(instance.frames, /Continue\?/u);
		instance.stdin.write('y');
		const frame = await waitForFrame(instance.frames, /Complete/u);
		expect(frame).toContain('second:value');
		expect(frame).toContain('✓');
	});

	it('reports prompt requirements without ANSI in a non-interactive run', async () => {
		const instance = render(
			<WorkflowApp
				interactive={false}
				workflow={async ui => {
					await ui.confirm('Cannot ask');
				}}
			/>,
		);
		const frame = await waitForFrame(instance.frames, /interactive terminal/u);
		expect(frame).not.toMatch(/\u001B\[/u);
		expect(frame).toContain('×');
	});

	it('renders workflow errors', async () => {
		const instance = render(
			<WorkflowApp
				interactive
				workflow={async () => {
					throw new Error('broken');
				}}
			/>,
		);
		expect(await waitForFrame(instance.frames, /broken/u)).toContain('×');
	});
});
