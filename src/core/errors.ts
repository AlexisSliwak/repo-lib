export class RepoLibError extends Error {
	readonly exitCode: 1 | 2 | 130;

	constructor(message: string, exitCode: 1 | 2 | 130 = 1, options?: ErrorOptions) {
		super(message, options);
		this.name = 'RepoLibError';
		this.exitCode = exitCode;
	}
}

export class UsageError extends RepoLibError {
	constructor(message: string, options?: ErrorOptions) {
		super(message, 2, options);
		this.name = 'UsageError';
	}
}

export class CancelledError extends RepoLibError {
	constructor(message = 'Cancelled.') {
		super(message, 130);
		this.name = 'CancelledError';
	}
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
