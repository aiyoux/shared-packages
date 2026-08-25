import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

/**
 * Node-environment unit tests: rclone + monitor drivers, tree DnD, the central
 * in-memory VFS and the global transfer registry. Node (not jsdom) so
 * Blob/arrayBuffer match the browser-ish APIs the drivers use.
 *
 * Despite the `rclone` filename (kept so existing `npm run test:rclone`
 * muscle-memory and CI invocations keep working) this is the catch-all Node
 * config. **Any new `src/**` unit test must be matched by an include here**, or
 * it silently never runs — `src/transferRegistry.test.ts` sat unexecuted
 * because it was added without a matching pattern.
 */
export default defineConfig({
	resolve: {
		alias: {
			// Worktree node_modules is shared with development; pin kb-model to this tree.
			'@shared-packages/kb-model': path.join(root, '../kb-model/src/index.ts')
		}
	},
	test: {
		environment: 'node',
		include: [
			'src/rclone/**/*.test.ts',
			'src/monitor/**/*.test.ts',
			'src/ui/treeDnd/**/*.test.ts',
			'src/memoryVfs.test.ts',
			'src/transferRegistry.test.ts'
		],
		setupFiles: ['./test/setup.mjs']
	},
	root
});
