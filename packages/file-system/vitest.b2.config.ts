import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

/**
 * B2 unit tests (simulator, credentials, cache) — Node environment required
 * so Blob/arrayBuffer match the SDK (jsdom Blob is incomplete).
 */
export default defineConfig({
	test: {
		environment: 'node',
		include: ['src/b2/**/*.test.ts'],
		setupFiles: ['./test/setup.mjs']
	},
	root
});
