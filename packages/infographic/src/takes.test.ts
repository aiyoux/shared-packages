import { describe, expect, it } from 'vitest';
import {
	addKeyframe,
	createDocument,
	createTake,
	duplicateTake,
	ensureFullSpanTrack,
	getActiveScene,
	getActiveTake,
	instantiateTemplate,
	MAX_KEYS_PER_CURVE,
	MAX_TAKES_PER_SCENE,
	MAX_TRACKS_PER_TAKE,
	moveTrack,
	placeObjectAtPlayhead,
	resolve,
	sampleTake,
	setTakeDuration,
	setTakePoster,
	trimTrack,
	unlinkTrack
} from './index.js';
import type { IgfxObject, ResolvedNode } from './types.js';

function obj(id: string, extra: Partial<IgfxObject> = {}): IgfxObject {
	return {
		id,
		name: id,
		parentId: extra.parentId ?? null,
		kind: extra.kind ?? 'text',
		visible: extra.visible ?? true,
		transform: extra.transform ?? { x: 0, y: 0, w: 10, h: 10, rotation: 0, opacity: 1 },
		...extra
	};
}

function findById(nodes: ResolvedNode[], id: string): ResolvedNode | undefined {
	for (const node of nodes) {
		if (node.id === id) return node;
		if (node.children) {
			const hit = findById(node.children, id);
			if (hit) return hit;
		}
	}
	return undefined;
}

function barsVisible(nodes: ResolvedNode[]): boolean {
	const bars = findById(nodes, 'bars');
	if (!bars) return false;
	const first = findById(nodes, 'bars:0');
	return Number(first?.attrs['data-length']) > 0;
}

describe('placeObjectAtPlayhead', () => {
	it('places a 2s visibility clip at the playhead and does not auto-place descendants', () => {
		const doc = createDocument();
		const scene = getActiveScene(doc);
		const take = getActiveTake(scene);
		scene.objects = [obj('g', { kind: 'group' }), obj('child', { parentId: 'g' })];

		const clip = placeObjectAtPlayhead(take, 'g', 1000);
		expect(clip.startMs).toBe(1000);
		expect(clip.durationMs).toBe(2000);
		expect(take.tracks).toHaveLength(1);
		expect(take.tracks[0].objectId).toBe('g');
		expect(take.tracks.some((tr) => tr.objectId === 'child')).toBe(false);

		expect(sampleTake(scene, take, 0).byObject.get('g')?.visible).toBe(false);
		expect(sampleTake(scene, take, 0).byObject.get('child')?.visible).toBe(false);
		expect(sampleTake(scene, take, 1000).byObject.get('g')?.visible).toBe(true);
		expect(sampleTake(scene, take, 1000).byObject.get('child')?.visible).toBe(true);
		expect(sampleTake(scene, take, 3000).byObject.get('g')?.visible).toBe(true);
		expect(sampleTake(scene, take, 3001).byObject.get('g')?.visible).toBe(false);
	});

	it('caps default duration at the remaining take and at least 1ms', () => {
		const doc = createDocument();
		const take = getActiveTake(getActiveScene(doc));
		expect(placeObjectAtPlayhead(take, 'a', 7000).durationMs).toBe(1000);
		const atEnd = placeObjectAtPlayhead(take, 'b', 8000);
		expect(atEnd).toMatchObject({ startMs: 8000, durationMs: 1 });
		const pastEnd = placeObjectAtPlayhead(take, 'c', 10000);
		expect(pastEnd).toMatchObject({ startMs: 8000, durationMs: 1 });
		expect(placeObjectAtPlayhead(take, 'd', 0, 500).durationMs).toBe(500);
	});

	it('overlapping place clips are visible by OR of ranges', () => {
		const doc = createDocument();
		const scene = getActiveScene(doc);
		const take = getActiveTake(scene);
		scene.objects = [obj('t')];
		placeObjectAtPlayhead(take, 't', 0, 1000);
		placeObjectAtPlayhead(take, 't', 2000, 1000);
		expect(sampleTake(scene, take, 500).byObject.get('t')?.visible).toBe(true);
		expect(sampleTake(scene, take, 1500).byObject.get('t')?.visible).toBe(false);
		expect(sampleTake(scene, take, 2000).byObject.get('t')?.visible).toBe(true);
		expect(sampleTake(scene, take, 3000).byObject.get('t')?.visible).toBe(true);
	});
});

describe('addKeyframe / ensureFullSpanTrack', () => {
	it('first curve on an unlinked object inserts a full-span track', () => {
		const doc = createDocument();
		const scene = getActiveScene(doc);
		const take = getActiveTake(scene);
		scene.objects = [obj('t')];

		const track = addKeyframe(take, 't', 'opacity', { tMs: 0, value: 0, easing: 'linear' });
		addKeyframe(take, 't', 'opacity', { tMs: 400, value: 1 });
		expect(track.startMs).toBe(0);
		expect(track.durationMs).toBe(take.durationMs);
		expect(take.tracks).toHaveLength(1);
		expect(track.curves).toHaveLength(1);
		expect(track.curves[0]).toMatchObject({
			id: 't-opacity',
			prop: 'opacity',
			keyframes: [
				{ tMs: 0, value: 0, easing: 'linear' },
				{ tMs: 400, value: 1 }
			]
		});
		expect(sampleTake(scene, take, 0).byObject.get('t')?.visible).toBe(true);
		expect(sampleTake(scene, take, 8000).byObject.get('t')?.visible).toBe(true);
		expect(sampleTake(scene, take, 0).byObject.get('t')?.motion.opacity).toBe(0);
		expect(sampleTake(scene, take, 400).byObject.get('t')?.motion.opacity).toBe(1);
	});

	it('writes onto the later covering track; otherwise ensureFullSpanTrack, not a second 2s clip', () => {
		const doc = createDocument();
		const scene = getActiveScene(doc);
		const take = getActiveTake(scene);
		scene.objects = [obj('t')];
		const early = placeObjectAtPlayhead(take, 't', 0, 3000);
		const later = placeObjectAtPlayhead(take, 't', 1000, 2000);

		const onLater = addKeyframe(take, 't', 'opacity', { tMs: 1500, value: 0.4 });
		expect(onLater.id).toBe(later.id);
		expect(early.curves).toHaveLength(0);
		expect(later.curves[0].keyframes).toEqual([{ tMs: 1500, value: 0.4 }]);
		expect(sampleTake(scene, take, 1500).byObject.get('t')?.motion.opacity).toBe(0.4);

		const full = addKeyframe(take, 't', 'opacity', { tMs: 4000, value: 0.1 });
		expect(full.startMs).toBe(0);
		expect(full.durationMs).toBe(take.durationMs);
		expect(full.id).not.toBe(early.id);
		expect(full.id).not.toBe(later.id);
		expect(take.tracks.filter((tr) => tr.durationMs === 2000)).toHaveLength(1);
		expect(ensureFullSpanTrack(take, 't').id).toBe(full.id);
	});
});

describe('moveTrack / trimTrack / unlinkTrack', () => {
	it('moves, trims, and unlinks a place clip without dropping the object', () => {
		const doc = createDocument();
		const scene = getActiveScene(doc);
		const take = getActiveTake(scene);
		scene.objects = [obj('t')];
		const clip = placeObjectAtPlayhead(take, 't', 1000);

		moveTrack(take, clip.id, 500);
		expect(clip.startMs).toBe(500);
		expect(clip.durationMs).toBe(2000);

		trimTrack(take, clip.id, 200, 800);
		expect(clip.startMs).toBe(200);
		expect(clip.durationMs).toBe(800);
		expect(sampleTake(scene, take, 200).byObject.get('t')?.visible).toBe(true);
		expect(sampleTake(scene, take, 1001).byObject.get('t')?.visible).toBe(false);

		unlinkTrack(take, clip.id);
		expect(take.tracks).toHaveLength(0);
		expect(scene.objects.map((o) => o.id)).toEqual(['t']);
		expect(sampleTake(scene, take, 0).byObject.get('t')?.visible).toBe(true);
	});
});

describe('setTakeDuration / setTakePoster', () => {
	it('8000 → 12000 keeps migrated bars visible at the new poster', () => {
		const doc = instantiateTemplate('bar-compare');
		const take = getActiveTake(getActiveScene(doc));
		const bars = take.tracks.find((tr) => tr.objectId === 'bars');
		expect(bars).toMatchObject({ startMs: 0, durationMs: 8000 });

		setTakeDuration(take, 12000);
		expect(take.durationMs).toBe(12000);
		expect(take.posterMs).toBe(12000);
		expect(bars?.durationMs).toBe(12000);
		expect(barsVisible(resolve(doc, take.posterMs).nodes)).toBe(true);
		expect(barsVisible(resolve(doc, 12000).nodes)).toBe(true);
	});

	it('a 2s place clip at startMs=1000 is unchanged when the take is lengthened or shortened', () => {
		const doc = createDocument();
		const take = getActiveTake(getActiveScene(doc));
		const clip = placeObjectAtPlayhead(take, 'box', 1000);
		expect(clip).toMatchObject({ startMs: 1000, durationMs: 2000 });

		setTakeDuration(take, 12000);
		expect(clip).toMatchObject({ startMs: 1000, durationMs: 2000 });

		setTakeDuration(take, 200);
		expect(clip).toMatchObject({ startMs: 1000, durationMs: 2000 });
	});

	it('8000 → 200 stretches full-span tracks to 200 so the object stays visible at the new poster', () => {
		const doc = instantiateTemplate('bar-compare');
		const take = getActiveTake(getActiveScene(doc));
		setTakeDuration(take, 200);
		expect(take.durationMs).toBe(200);
		expect(take.posterMs).toBe(200);
		for (const track of take.tracks) {
			expect(track.startMs).toBe(0);
			expect(track.durationMs).toBe(200);
		}
		expect(barsVisible(resolve(doc, take.posterMs).nodes)).toBe(true);
	});

	it('clamps a non-end poster instead of pinning it', () => {
		const doc = createDocument();
		const take = getActiveTake(getActiveScene(doc));
		setTakePoster(take, 4000);
		expect(take.posterMs).toBe(4000);

		setTakeDuration(take, 12000);
		expect(take.posterMs).toBe(4000);

		setTakeDuration(take, 200);
		expect(take.posterMs).toBe(200);

		setTakePoster(take, -10);
		expect(take.posterMs).toBe(0);
		setTakePoster(take, 999);
		expect(take.posterMs).toBe(200);
	});
});

describe('duplicateTake', () => {
	it('clones tracks under a new id and makes the copy active', () => {
		const doc = createDocument();
		const scene = getActiveScene(doc);
		const take = getActiveTake(scene);
		scene.objects = [obj('t')];
		addKeyframe(take, 't', 'opacity', { tMs: 0, value: 0.2 });
		const sourceId = take.id;

		const copy = duplicateTake(scene, sourceId);
		expect(copy.id).not.toBe(sourceId);
		expect(scene.activeTimelineId).toBe(copy.id);
		expect(scene.timelines).toHaveLength(2);
		expect(copy.tracks).toHaveLength(1);
		expect(copy.tracks[0].curves[0].keyframes).toEqual([{ tMs: 0, value: 0.2 }]);
		expect(copy.tracks[0].id).toBe(take.tracks[0].id);

		copy.tracks[0].curves[0].keyframes[0].value = 0.9;
		expect(take.tracks[0].curves[0].keyframes[0].value).toBe(0.2);
		expect(sampleTake(scene, copy, 0).byObject.get('t')?.motion.opacity).toBe(0.9);
		expect(sampleTake(scene, take, 0).byObject.get('t')?.motion.opacity).toBe(0.2);
	});
});

describe('mutate caps', () => {
	it('256th+ place/ensure is a no-op and returns an already-inserted track', () => {
		const doc = createDocument();
		const take = getActiveTake(getActiveScene(doc));
		take.tracks = Array.from({ length: MAX_TRACKS_PER_TAKE }, (_, i) => ({
			id: `track-${i}`,
			objectId: `o${i}`,
			startMs: 0,
			durationMs: 100,
			curves: []
		}));
		const last = take.tracks[MAX_TRACKS_PER_TAKE - 1];
		const placed = placeObjectAtPlayhead(take, 'fresh', 0);
		expect(take.tracks).toHaveLength(MAX_TRACKS_PER_TAKE);
		expect(take.tracks.includes(placed)).toBe(true);
		expect(placed).toBe(last);

		const ensured = ensureFullSpanTrack(take, 'fresh');
		expect(take.tracks).toHaveLength(MAX_TRACKS_PER_TAKE);
		expect(take.tracks.includes(ensured)).toBe(true);
		expect(ensured).toBe(last);
	});

	it('drops a 257th key but still upserts an existing tMs', () => {
		const doc = createDocument();
		const scene = getActiveScene(doc);
		const take = getActiveTake(scene);
		scene.objects = [obj('t')];
		addKeyframe(take, 't', 'opacity', { tMs: 0, value: 0 });
		const curve = take.tracks[0].curves[0];
		curve.keyframes = Array.from({ length: MAX_KEYS_PER_CURVE }, (_, i) => ({
			tMs: i,
			value: i / MAX_KEYS_PER_CURVE
		}));

		addKeyframe(take, 't', 'opacity', { tMs: MAX_KEYS_PER_CURVE + 10, value: 1 });
		expect(curve.keyframes).toHaveLength(MAX_KEYS_PER_CURVE);
		expect(curve.keyframes.some((k) => k.tMs === MAX_KEYS_PER_CURVE + 10)).toBe(false);

		addKeyframe(take, 't', 'opacity', { tMs: 0, value: 0.77 });
		expect(curve.keyframes).toHaveLength(MAX_KEYS_PER_CURVE);
		expect(curve.keyframes[0]).toMatchObject({ tMs: 0, value: 0.77 });
	});

	it('does not push a 17th take and leaves activeTimelineId unchanged', () => {
		const doc = createDocument();
		const scene = getActiveScene(doc);
		const first = getActiveTake(scene);
		while (scene.timelines.length < MAX_TAKES_PER_SCENE) {
			scene.timelines.push(createTake(`Take ${scene.timelines.length + 1}`));
		}
		const active = scene.activeTimelineId;
		expect(scene.timelines).toHaveLength(MAX_TAKES_PER_SCENE);

		const refused = duplicateTake(scene, first.id);
		expect(refused).toBe(first);
		expect(scene.timelines).toHaveLength(MAX_TAKES_PER_SCENE);
		expect(scene.activeTimelineId).toBe(active);
	});
});
