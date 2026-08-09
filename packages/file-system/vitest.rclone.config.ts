import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

/**
 * rclone unit tests (simulator, credentials, driver) — Node environment so
 * Blob/arrayBuffer match browser-ish APIs used by the driver.
 */
export default defineConfig({
	test: {
		environment: 'node',
		include: [
			'src/rclone/**/*.test.ts',
			'src/monitor/**/*.test.ts',
			'src/ui/treeDnd/**/*.test.ts',
			'src/memoryVfs.test.ts'
		],
		setupFiles: ['./test/setup.mjs']
	},
	root
});
