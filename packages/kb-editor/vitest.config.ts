import { svelte } from '@sveltejs/vite-plugin-svelte';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	plugins: [svelte({ compilerOptions: { css: 'injected', runes: true } })],
	test: {
		include: ['src/**/*.test.ts'],
		environment: 'jsdom',
		testTimeout: 20_000
	},
	root,
	resolve: {
		alias: {
			'@shared-packages/kb-model': path.resolve(root, '../kb-model/src/index.ts')
		}
	}
});
