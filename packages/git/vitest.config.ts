import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { svelteTesting } from '@testing-library/svelte/vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

/** Vite /@fs/ follows realpaths; allow the install even when node_modules is a symlink. */
function nodeModulesAllow(from: string): string[] {
	const out: string[] = [];
	let dir = from;
	for (;;) {
		const nm = path.join(dir, 'node_modules');
		if (fs.existsSync(nm)) {
			out.push(nm);
			try {
				const real = fs.realpathSync(nm);
				if (real !== nm) out.push(real);
			} catch {
				/* dangling symlink */
			}
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return out;
}

export default defineConfig({
	plugins: [
		svelte({ compilerOptions: { css: 'injected' } }),
		svelteTesting()
	],
	test: {
		include: ['src/**/*.test.ts'],
		environment: 'jsdom',
		setupFiles: ['./src/testSetup.ts', '@testing-library/svelte/vitest'],
		testTimeout: 20_000,
		server: {
			deps: {
				inline: [/@lucide\/svelte/]
			}
		}
	},
	server: {
		fs: {
			allow: [root, ...nodeModulesAllow(root)]
		}
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
