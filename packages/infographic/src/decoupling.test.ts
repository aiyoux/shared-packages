import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const srcDir = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
	readFileSync(join(srcDir, '../package.json'), 'utf8')
) as {
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
};

function collectTs(dir: string): string[] {
	const out: string[] = [];
	for (const ent of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, ent.name);
		if (ent.isDirectory()) out.push(...collectTs(p));
		else if (ent.name.endsWith('.ts') && ent.name !== 'decoupling.test.ts') out.push(p);
	}
	return out;
}

describe('package decoupling', () => {
	it('does not depend on composition, video, scene-bake, or three', () => {
		const deps = {
			...pkg.dependencies,
			...pkg.devDependencies,
			...pkg.peerDependencies
		};
		expect(deps['@shared-packages/composition']).toBeUndefined();
		expect(deps['@shared-packages/video']).toBeUndefined();
		expect(deps['@shared-packages/scene-bake']).toBeUndefined();
		expect(deps.three).toBeUndefined();
	});

	it('source does not import composition or video', () => {
		const banned = /@shared-packages\/(composition|video)\b/;
		for (const file of collectTs(srcDir)) {
			expect(readFileSync(file, 'utf8'), file).not.toMatch(banned);
		}
	});
});
