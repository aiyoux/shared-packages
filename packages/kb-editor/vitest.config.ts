import { svelte } from '@sveltejs/vite-plugin-svelte';
import { svelteTesting } from '@testing-library/svelte/vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	plugins: [svelte({ compilerOptions: { css: 'injected', runes: true } }), svelteTesting()],
	test: {
		include: ['src/**/*.test.ts'],
		environment: 'jsdom',
		setupFiles: ['@testing-library/svelte/vitest'],
		testTimeout: 20_000
	},
	root,
	resolve: {
		alias: {
			'@shared-packages/kb-model': path.resolve(root, '../kb-model/src/index.ts')
		}
	}
});
