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
		else if (ent.name.endsWith('.ts') && ent.name !== 'decoupling.test.ts') out.push(p);
	}
	return out;
}

describe('decoupling', () => {
	it('package.json does not list infographic or video', () => {
		const names = depNames();
		expect(names).not.toContain('@shared-packages/infographic');
		expect(names).not.toContain('@shared-packages/video');
		expect(names.some((n) => n.includes('infographic'))).toBe(false);
	});

	it('source does not import infographic or video', () => {
		const banned = /@shared-packages\/(infographic|video)\b/;
		for (const file of collectTs(srcDir)) {
			expect(readFileSync(file, 'utf8'), file).not.toMatch(banned);
		}
	});

	it('source does not mention IgfxScene, IgfxObject, or SceneTrack', () => {
		const banned = /\b(IgfxScene|IgfxObject|SceneTrack)\b/;
		for (const file of collectTs(srcDir)) {
			expect(readFileSync(file, 'utf8'), file).not.toMatch(banned);
		}
	});
});
