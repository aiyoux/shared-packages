import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { svelteTesting } from '@testing-library/svelte/vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	plugins: [
		svelte({ compilerOptions: { css: 'injected' } }),
		svelteTesting()
	],
	test: {
		include: ['src/**/*.test.ts'],
		environment: 'jsdom',
		setupFiles: ['./src/testSetup.ts', '@testing-library/svelte/vitest'],
		testTimeout: 20_000
	},
	root,
	resolve: {
		alias: {
			'@shared-packages/file-system/ui': path.resolve(root, '../file-system/src/ui/index.ts'),
			'@shared-packages/file-system/monitor': path.resolve(
				root,
				'../file-system/src/monitor/index.ts'
			),
			'@shared-packages/file-system': path.resolve(root, '../file-system/src/index.ts'),
			'@shared-packages/design-system': path.resolve(root, '../design-system/src'),
			'@shared-packages/ui': path.resolve(root, '../ui/src/index.ts')
		}
	}
});
