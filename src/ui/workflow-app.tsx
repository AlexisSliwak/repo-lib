import {ConfirmInput, Select, Spinner, TextInput} from '@inkjs/ui';
import {Box, Text, useApp, useInput} from 'ink';
import React, {useEffect, useMemo, useRef, useState} from 'react';
import {CancelledError, errorMessage} from '../core/errors.js';
import type {SelectOption, WorkflowUi} from '../core/workflows.js';

type MessageKind = 'info' | 'warning' | 'success' | 'error';

interface Message {
	id: number;
	kind: MessageKind;
	text: string;
}

type Prompt =
	| {
			id: number;
			type: 'text';
			message: string;
			defaultValue?: string;
			resolve(value: string): void;
			reject(error: Error): void;
	  }
	| {
			id: number;
			type: 'select';
			message: string;
			options: readonly SelectOption[];
			resolve(value: string): void;
			reject(error: Error): void;
	  }
	| {
			id: number;
			type: 'confirm';
			message: string;
			resolve(value: boolean): void;
			reject(error: Error): void;
	  };

export interface WorkflowAppProps {
	workflow(ui: WorkflowUi): Promise<unknown>;
	interactive?: boolean;
}

function marker(kind: MessageKind): {icon: string; color: string} {
	switch (kind) {
		case 'success': {
			return {icon: '✓', color: 'green'};
		}
		case 'warning': {
			return {icon: '!', color: 'yellow'};
		}
		case 'error': {
			return {icon: '×', color: 'red'};
		}
		default: {
			return {icon: '•', color: 'cyan'};
		}
	}
}

export function WorkflowApp({
	workflow,
	interactive = Boolean(process.stdin.isTTY),
}: WorkflowAppProps): React.JSX.Element {
	const {exit} = useApp();
	const [messages, setMessages] = useState<Message[]>([]);
	const [prompt, setPrompt] = useState<Prompt>();
	const [busyLabel, setBusyLabel] = useState<string>();
	const [finishedCode, setFinishedCode] = useState<number>();
	const sequence = useRef(0);
	const started = useRef(false);

	const append = (kind: MessageKind, text: string): void => {
		setMessages(previous => [
			...previous,
			{id: sequence.current++, kind, text},
		]);
	};

	const ask = <T,>(
		create: (
			resolve: (value: T) => void,
			reject: (error: Error) => void,
		) => Prompt,
	): Promise<T> => {
		if (!interactive) {
			return Promise.reject(
				new Error('This command requires an interactive terminal for input.'),
			);
		}
		return new Promise<T>((resolve, reject) => {
			setPrompt(create(resolve, reject));
		});
	};

	const ui = useMemo<WorkflowUi>(
		() => ({
			text: async (message, defaultValue) =>
				ask<string>((resolve, reject) => ({
					id: sequence.current++,
					type: 'text',
					message,
					...(defaultValue === undefined ? {} : {defaultValue}),
					resolve,
					reject,
				})),
			select: async (message, options) =>
				ask<string>((resolve, reject) => ({
					id: sequence.current++,
					type: 'select',
					message,
					options,
					resolve,
					reject,
				})),
			confirm: async message =>
				ask<boolean>((resolve, reject) => ({
					id: sequence.current++,
					type: 'confirm',
					message,
					resolve,
					reject,
				})),
			info: message => append('info', message),
			warn: message => append('warning', message),
			success: message => append('success', message),
			busy: async <T,>(message: string, operation: () => Promise<T>) => {
				setBusyLabel(message);
				try {
					return await operation();
				} finally {
					setBusyLabel(undefined);
				}
			},
		}),
		[interactive],
	);

	useEffect(() => {
		if (started.current) {
			return;
		}
		started.current = true;
		void workflow(ui).then(
			() => {
				setPrompt(undefined);
				setBusyLabel(undefined);
				setFinishedCode(0);
			},
			(error: unknown) => {
				setPrompt(undefined);
				setBusyLabel(undefined);
				const code =
					typeof error === 'object' &&
					error !== null &&
					'exitCode' in error &&
					typeof error.exitCode === 'number'
						? error.exitCode
						: 1;
				append(code === 130 ? 'warning' : 'error', errorMessage(error));
				setFinishedCode(code);
			},
		);
	}, [ui, workflow]);

	useEffect(() => {
		if (finishedCode === undefined) {
			return;
		}
		const timer = setTimeout(() => exit(finishedCode), 0);
		return () => {
			clearTimeout(timer);
		};
	}, [exit, finishedCode]);

	useInput(
		(input, key) => {
			if (key.ctrl && input === 'c') {
				prompt?.reject(new CancelledError());
				setPrompt(undefined);
			}
		},
		{isActive: interactive && finishedCode === undefined},
	);

	const answer = <T,>(value: T): void => {
		const current = prompt;
		if (current === undefined) {
			return;
		}
		setPrompt(undefined);
		(current.resolve as (answer: T) => void)(value);
	};

	return (
		<Box flexDirection="column">
			<Text bold color="cyan">
				repo-lib
			</Text>
			{messages.map(message => {
				const style = marker(message.kind);
				return (
					<Text key={message.id} color={style.color}>
						{style.icon} {message.text}
					</Text>
				);
			})}
			{busyLabel === undefined ? null : <Spinner label={busyLabel} />}
			{prompt === undefined ? null : (
				<Box flexDirection="column" marginTop={1}>
					<Text bold>{prompt.message}</Text>
					{prompt.type === 'text' ? (
						<TextInput
							{...(prompt.defaultValue === undefined
								? {}
								: {defaultValue: prompt.defaultValue})}
							onSubmit={value => answer(value)}
						/>
					) : null}
					{prompt.type === 'select' ? (
						<Select
							options={[...prompt.options]}
							visibleOptionCount={Math.min(7, prompt.options.length)}
							onChange={value => answer(value)}
						/>
					) : null}
					{prompt.type === 'confirm' ? (
						<ConfirmInput
							defaultChoice="cancel"
							onConfirm={() => answer(true)}
							onCancel={() => answer(false)}
						/>
					) : null}
				</Box>
			)}
		</Box>
	);
}
