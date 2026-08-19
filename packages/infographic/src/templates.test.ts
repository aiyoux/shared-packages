import { describe, expect, it } from 'vitest';
import {
	getActiveScene,
	getActiveTake,
	instantiateTemplate,
	listTemplates,
	resolve,
	TEMPLATE_IDS
} from './index.js';

describe('templates', () => {
	it('ships three first-party documents', () => {
		expect(listTemplates().map((t) => t.id)).toEqual([...TEMPLATE_IDS]);
	});

	it.each(TEMPLATE_IDS)('%s has progress 0→1 and title opacity tracks, posterMs = durationMs', (id) => {
		const doc = instantiateTemplate(id);
		expect(doc.artboard).toEqual({ width: 1920, height: 1080 });
		expect(doc.scenes).toHaveLength(1);
		const take = getActiveTake(getActiveScene(doc));
		expect(take.durationMs).toBe(8000);
		expect(take.posterMs).toBe(8000);
		expect(take.posterMs).toBe(take.durationMs);

		const curves = take.tracks.flatMap((t) => t.curves.map((c) => ({ objectId: t.objectId, ...c })));
		const progress = curves.filter((c) => c.prop === 'progress');
		const title = curves.find((c) => c.objectId === 'title' && c.prop === 'opacity');
		expect(progress.length).toBeGreaterThan(0);
		for (const curve of progress) {
			expect(curve.keyframes[0]).toMatchObject({ tMs: 0, value: 0 });
			expect(curve.keyframes[curve.keyframes.length - 1]).toMatchObject({ value: 1 });
		}
		expect(title).toBeDefined();
		expect(title?.keyframes[0]).toMatchObject({ tMs: 0, value: 0 });
		expect(title?.keyframes[title.keyframes.length - 1]).toMatchObject({ value: 1 });
	});

	it.each(TEMPLATE_IDS)('%s is deterministic at posterMs', (id) => {
		const a = instantiateTemplate(id);
		const b = instantiateTemplate(id);
		expect(resolve(a, getActiveTake(getActiveScene(a)).posterMs)).toEqual(
			resolve(b, getActiveTake(getActiveScene(b)).posterMs)
		);
	});
});
