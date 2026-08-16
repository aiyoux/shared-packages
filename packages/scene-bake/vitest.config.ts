import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	resolve: {
		alias: {
			'@shared-packages/drawing-tools': resolve(root, '../drawing-tools/src/index.ts')
		}
	},
	test: {
		include: ['src/**/*.test.ts'],
		environment: 'jsdom',
		testTimeout: 30_000
	}
});
