import {defineConfig} from 'vitest/config';

export default defineConfig({
	test: {
		environment: 'node',
		include: ['tests/**/*.test.{ts,tsx}'],
		testTimeout: 20_000,
		hookTimeout: 20_000,
		coverage: {
			provider: 'v8',
			include: ['src/core/**/*.{ts,tsx}'],
			exclude: ['src/core/types.ts'],
			reporter: ['text', 'json-summary'],
			thresholds: {
				lines: 90,
				functions: 90,
				statements: 90,
				branches: 85
			}
		}
	}
});
