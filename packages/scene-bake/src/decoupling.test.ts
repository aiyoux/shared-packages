import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const srcDir = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(srcDir, '..', 'package.json'), 'utf8')) as {
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
};

function depNames(): string[] {
	return [
		...Object.keys(pkg.dependencies ?? {}),
		...Object.keys(pkg.devDependencies ?? {}),
		...Object.keys(pkg.peerDependencies ?? {}),
		...Object.keys(pkg.optionalDependencies ?? {})
	];
}

function collectTs(dir: string): string[] {
	const out: string[] = [];
	for (const ent of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, ent.name);
		if (ent.isDirectory()) out.push(...collectTs(p));
		else if (ent.name.endsWith('.ts') && !ent.name.endsWith('.test.ts')) out.push(p);
	}
	return out;
}

describe('decoupling', () => {
	it('does not depend on infographic, composition, or video', () => {
		const names = depNames();
		expect(names).not.toContain('@shared-packages/infographic');
		expect(names).not.toContain('@shared-packages/composition');
		expect(names).not.toContain('@shared-packages/video');
	});

	it('source does not import infographic or composition', () => {
		const banned = /@shared-packages\/(infographic|composition|video)\b/;
		for (const file of collectTs(srcDir)) {
			expect(readFileSync(file, 'utf8'), file).not.toMatch(banned);
		}
	});
});
