#!/usr/bin/env node
/**
 * Guard: every test file must be matched by at least one vitest config's
 * `include` patterns (or the node --test glob in package.json's `test` script).
 *
 * Why: this package spreads its tests across four runners (a node:test run over
 * `test/*.unit.test.ts`, plus three vitest configs). A new `src/**` test that
 * matches none of them does not fail — it silently never runs, and the suite
 * stays green while the code is unverified. `src/transferRegistry.test.ts` sat
 * in exactly that state: written, committed, never executed.
 *
 * Run: npm run check:test-coverage  (wired into `npm run test:all`)
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Recursively collect *.test.ts under a directory. */
function collect(dir, acc = []) {
	let entries;
	try {
		entries = readdirSync(path.join(root, dir));
	} catch {
		return acc;
	}
	for (const name of entries) {
		const rel = path.join(dir, name);
		if (statSync(path.join(root, rel)).isDirectory()) collect(rel, acc);
		else if (/\.test\.ts$/.test(name)) acc.push(rel);
	}
	return acc;
}

/** Minimal glob → RegExp supporting `**` and `*`. */
function toRegExp(glob) {
	return new RegExp(
		'^' +
			glob
				.split('**')
				.map((part) =>
					part
						.split('*')
						.map((s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&'))
						.join('[^/]*')
				)
				.join('.*')
				.replace(/\/\.\*\//g, '/(?:.*/)?') +
			'$'
	);
}

const patterns = [];

// vitest configs
for (const cfg of readdirSync(root).filter((f) => /^vitest.*\.config\.ts$/.test(f))) {
	const src = readFileSync(path.join(root, cfg), 'utf8');
	const block = src.match(/include:\s*\[([\s\S]*?)\]/);
	if (!block) continue;
	for (const m of block[1].matchAll(/['"]([^'"]+)['"]/g)) patterns.push({ glob: m[1], from: cfg });
}

// package.json `test` script (node --test with a shell glob)
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
for (const m of (pkg.scripts?.test ?? '').matchAll(/(\S*test\/\S*\.ts)/g)) {
	patterns.push({ glob: m[1], from: 'package.json#test' });
}

const compiled = patterns.map((p) => ({ ...p, rx: toRegExp(p.glob) }));
const files = [...collect('src'), ...collect('test')];
const orphans = files.filter((f) => !compiled.some((p) => p.rx.test(f)));

if (orphans.length) {
	console.error('\n[check-test-coverage] These test files are not run by any config:\n');
	for (const f of orphans) console.error(`  ${f}`);
	console.error(
		'\nAdd a matching `include` pattern to the appropriate vitest.*.config.ts\n' +
			'(vitest.rclone.config.ts is the catch-all Node config), or the file will\n' +
			'silently never execute.\n'
	);
	process.exit(1);
}

console.log(`[check-test-coverage] OK: all ${files.length} test files are matched by a runner.`);
