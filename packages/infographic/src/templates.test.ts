import { describe, expect, it } from 'vitest';
import { instantiateTemplate, listTemplates, resolve, TEMPLATE_IDS } from './index.js';

describe('templates', () => {
	it('ships three first-party documents', () => {
		expect(listTemplates().map((t) => t.id)).toEqual([...TEMPLATE_IDS]);
	});

	it.each(TEMPLATE_IDS)('%s has progress 0→1 and title opacity tracks, posterMs = durationMs', (id) => {
		const doc = instantiateTemplate(id);
		expect(doc.artboard).toEqual({ width: 1920, height: 1080 });
		expect(doc.timeline.durationMs).toBe(8000);
		expect(doc.timeline.posterMs).toBe(8000);
		expect(doc.timeline.posterMs).toBe(doc.timeline.durationMs);

		const progress = doc.timeline.tracks.filter((t) => t.target.endsWith('.progress'));
		const title = doc.timeline.tracks.find((t) => t.target === 'mark:title.opacity');
		expect(progress.length).toBeGreaterThan(0);
		for (const track of progress) {
			expect(track.keyframes[0]).toMatchObject({ tMs: 0, value: 0 });
			expect(track.keyframes[track.keyframes.length - 1]).toMatchObject({ value: 1 });
		}
		expect(title).toBeDefined();
		expect(title?.keyframes[0]).toMatchObject({ tMs: 0, value: 0 });
		expect(title?.keyframes[title.keyframes.length - 1]).toMatchObject({ value: 1 });
	});

	it.each(TEMPLATE_IDS)('%s is deterministic at posterMs', (id) => {
		const a = instantiateTemplate(id);
		const b = instantiateTemplate(id);
		expect(resolve(a, a.timeline.posterMs)).toEqual(resolve(b, b.timeline.posterMs));
	});
});
