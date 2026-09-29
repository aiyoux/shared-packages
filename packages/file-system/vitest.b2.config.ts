import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

/**
 * B2 unit tests (monitor client, driver, cache) — Node environment so
 * Blob/Response streams behave like the browser (jsdom Blob is incomplete).
 */
export default defineConfig({
	test: {
		environment: 'node',
		include: ['src/b2/**/*.test.ts'],
		setupFiles: ['./test/setup.mjs']
	},
	root,
	resolve: {
		alias: {
			'@shared-packages/crypto': path.resolve(root, '../crypto/src/index.ts')
		}
	}
});
