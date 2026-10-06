import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { svelteTesting } from '@testing-library/svelte/vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { uiSubpathAliases } from '../ui/subpathAliases.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));

/**
 * Component tests for the video editor UI (jsdom + @testing-library/svelte).
 * Pure-logic unit tests stay on the default node config (`npm test`).
 */
export default defineConfig({
	plugins: [
		svelte({
			compilerOptions: { css: 'injected' }
		}),
		svelteTesting()
	],
	test: {
		environment: 'jsdom',
		include: ['test/**/*.component.test.ts'],
		setupFiles: ['./test/setup.mjs', '@testing-library/svelte/vitest'],
		server: {
			deps: {
				inline: [/@lucide\/svelte/]
			}
		}
	},
	root,
	resolve: {
		alias: {
			...uiSubpathAliases(),
			'@shared-packages/ui': path.resolve(root, '../ui/src/index.ts'),
			'@shared-packages/composition': path.resolve(root, '../composition/src/index.ts')
		}
	}
});
