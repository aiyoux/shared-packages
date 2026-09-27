// Vite aliases for every `@shared-packages/ui/<subpath>` export, read from this
// package's `exports` so a sibling's vitest config cannot drift from it.
//
// A hand-kept list missed `./subscribeStorageKey`, and Vite then resolved the
// import through the package-root alias to `src/index.ts/subscribeStorageKey`
// (ENOTDIR) — every git test file failed to load. Spread the result BEFORE the
// `@shared-packages/ui` root alias: Vite matches aliases in declaration order.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const uiRoot = path.dirname(fileURLToPath(import.meta.url));

/** @returns {Record<string, string>} subpath specifier → absolute source file, longest first */
export function uiSubpathAliases() {
	const { exports } = JSON.parse(fs.readFileSync(path.join(uiRoot, 'package.json'), 'utf8'));
	const entries = Object.entries(exports)
		.filter(([key]) => key !== '.')
		.map(([key, target]) => {
			const file = typeof target === 'string' ? target : (target.svelte ?? target.default);
			return [`@shared-packages/ui/${key.slice(2)}`, path.join(uiRoot, file)];
		})
		// `ui/timeline/pan` must precede `ui/timeline`, which prefix-matches it.
		.sort(([a], [b]) => b.length - a.length);
	return Object.fromEntries(entries);
}
