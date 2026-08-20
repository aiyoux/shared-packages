import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { svelteTesting } from '@testing-library/svelte/vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

/**
 * Component tests for FileExplorer (jsdom + @testing-library/svelte).
 * Unit API tests stay on node:test (`npm test`).
 */
export default defineConfig({
	plugins: [
		svelte({
			compilerOptions: { css: 'injected' },
			// Disable runes warning noise in tests; FileExplorer is runes mode
		}),
		svelteTesting()
	],
	test: {
		// Component tests (jsdom). B2 unit tests: vitest.b2.config.ts (node).
		environment: 'jsdom',
		include: ['test/**/*.component.test.ts'],
		setupFiles: ['./test/setup.mjs', '@testing-library/svelte/vitest']
	},
	root,
	resolve: {
		alias: {
			'@shared-packages/design-system/button.css': path.resolve(
				root,
				'../design-system/src/button.css'
			),
			'@shared-packages/design-system': path.resolve(root, '../design-system/src')
		}
	}
});
