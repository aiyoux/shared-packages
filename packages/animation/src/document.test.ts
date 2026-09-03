import { describe, expect, it } from 'vitest';
import { createCompositionClock } from '@shared-packages/composition';
import {
	AnimParseError,
	assertClipMatchesDoc,
	clipSpanMs,
	clipVisibleAt,
	createCompositionClock as reexportedClock,
	createPlayheadRegistry as reexportedRegistry,
	parseAnimDocument,
	sameFsBackend,
	serializeAnimDocument,
	type AnimClip,
	type AnimDocument
} from './index.js';

const cloneDoc: AnimDocument = {
	schemaVersion: 1,
	durationMs: 4000,
	clips: [
		{
			id: 'c1',
			startMs: 0,
			durationMs: 2000,
			frame: { x: 10, y: 20, w: 100, h: 80 },
			bind: 'clone'
		}
	]
};

const liveVfsClip = {
	id: 'live-1',
	startMs: 100,
	durationMs: 500,
	frame: { x: 0, y: 0, w: 320, h: 240 },
	bind: 'live' as const,
	source: { backend: 'shared-vfs' as const, nodeId: 'node-1', generation: 3, blobId: 'blob-1' }
};

describe('parseAnimDocument / serializeAnimDocument', () => {
	it('round-trips a clone clip with no source', () => {
		const json = serializeAnimDocument(cloneDoc);
		const parsed = parseAnimDocument(json);
		expect(parsed).toEqual(cloneDoc);
		expect(parsed.clips[0]).not.toHaveProperty('source');
		expect(json).not.toMatch(/"source"/);
	});

	it('round-trips from bytes', () => {
		const json = serializeAnimDocument(cloneDoc);
		const bytes = new TextEncoder().encode(json);
		expect(parseAnimDocument(bytes)).toEqual(cloneDoc);
	});

	it('round-trips rotation and keyframes', () => {
		const withMotion: AnimDocument = {
			schemaVersion: 1,
			durationMs: 4000,
			clips: [
				{
					id: 'c1',
					startMs: 0,
					durationMs: 2000,
					frame: { x: 10, y: 20, w: 100, h: 80, rotation: 0.5 },
					keyframes: [{ tMs: 1000, x: 40, rotation: 1 }],
					bind: 'clone'
				}
			]
		};
		expect(parseAnimDocument(serializeAnimDocument(withMotion))).toEqual(withMotion);
	});

	it('requires source on live, snapshot, and gitPin', () => {
		const base = {
			schemaVersion: 1,
			durationMs: 1000,
			clips: [
				{
					id: 'x',
					startMs: 0,
					durationMs: 10,
					frame: { x: 0, y: 0, w: 1, h: 1 }
				}
			]
		};
		for (const bind of ['live', 'snapshot', 'gitPin'] as const) {
			expect(() => parseAnimDocument({ ...base, clips: [{ ...base.clips[0], bind }] })).toThrow(
				AnimParseError
			);
			expect(() => parseAnimDocument({ ...base, clips: [{ ...base.clips[0], bind }] })).toThrow(
				/requires source/
			);
		}
	});

	it('rejects source on clone', () => {
		expect(() =>
			parseAnimDocument({
				schemaVersion: 1,
				durationMs: 1000,
				clips: [
					{
						id: 'c',
						startMs: 0,
						durationMs: 10,
						frame: { x: 0, y: 0, w: 1, h: 1 },
						bind: 'clone',
						source: { backend: 'shared-vfs', nodeId: 'n1' }
					}
				]
			})
		).toThrow(/omit source/);
	});

	it('rejects unknown bind', () => {
		expect(() =>
			parseAnimDocument({
				schemaVersion: 1,
				durationMs: 1000,
				clips: [
					{
						id: 'c',
						startMs: 0,
						durationMs: 10,
						frame: { x: 0, y: 0, w: 1, h: 1 },
						bind: 'linked'
					}
				]
			})
		).toThrow(/unknown bind/);
	});

	it('keeps frame.rotation and drops unknown extra fields', () => {
		const parsed = parseAnimDocument({
			schemaVersion: 1,
			durationMs: 2000,
			name: 'extra',
			clips: [
				{
					id: 'r',
					startMs: 0,
					durationMs: 2000,
					rotation: 45,
					frame: { x: 1, y: 2, w: 3, h: 4, rotation: 90 },
					bind: 'live',
					source: { backend: 'shared-vfs', nodeId: 'n', extra: true },
					mystery: 1
				}
			]
		});
		expect(parsed.clips[0]?.frame).toEqual({ x: 1, y: 2, w: 3, h: 4, rotation: 90 });
		expect(parsed).not.toHaveProperty('name');
		const json = serializeAnimDocument(parsed);
		expect(json).not.toMatch(/mystery/);
		expect(JSON.parse(json)).toEqual({
			schemaVersion: 1,
			durationMs: 2000,
			clips: [
				{
					id: 'r',
					startMs: 0,
					durationMs: 2000,
					frame: { x: 1, y: 2, w: 3, h: 4, rotation: 90 },
					bind: 'live',
					source: { backend: 'shared-vfs', nodeId: 'n' }
				}
			]
		});
	});

	it('keeps monitor ino/dev as decimal strings', () => {
		const doc = parseAnimDocument({
			schemaVersion: 1,
			durationMs: 100,
			clips: [
				{
					id: 'm',
					startMs: 0,
					durationMs: 100,
					frame: { x: 0, y: 0, w: 8, h: 8 },
					bind: 'gitPin',
					source: {
						backend: 'monitor',
						profileId: 'p1',
						relPath: 'clips/a.mp4',
						ino: '18446744073709551615',
						dev: '0'
					},
					snapshot: { bytesRef: 'opfs:1', atCommit: 'abc123' }
				}
			]
		});
		expect(doc.clips[0]).toMatchObject({
			bind: 'gitPin',
			source: {
				backend: 'monitor',
				profileId: 'p1',
				relPath: 'clips/a.mp4',
				ino: '18446744073709551615',
				dev: '0'
			}
		});
		expect(() =>
			parseAnimDocument({
				schemaVersion: 1,
				durationMs: 100,
				clips: [
					{
						id: 'm',
						startMs: 0,
						durationMs: 100,
						frame: { x: 0, y: 0, w: 8, h: 8 },
						bind: 'live',
						source: { backend: 'monitor', profileId: 'p1', relPath: 'a', ino: 12 }
					}
				]
			})
		).toThrow(/decimal string/);
	});

	it('rejects schemaVersion other than 1', () => {
		expect(() => parseAnimDocument({ schemaVersion: 3, durationMs: 0, clips: [] })).toThrow(
			/schemaVersion/
		);
		expect(() => parseAnimDocument({ schemaVersion: 2, durationMs: 0, clips: [] })).toThrow(
			/schemaVersion/
		);
	});

	it('round-trips a paired video+audio clip', () => {
		const doc: AnimDocument = {
			schemaVersion: 1,
			durationMs: 2500,
			clips: [
				{
					id: 'vid',
					startMs: 0,
					durationMs: 2500,
					frame: { x: 0, y: 0, w: 320, h: 180 },
					bind: 'clone',
					mediaKind: 'video',
					pairId: 'pair-1',
					snapshot: { bytesRef: 'data:video/webm;base64,xx' }
				},
				{
					id: 'aud',
					startMs: 0,
					durationMs: 2500,
					frame: { x: 0, y: 0, w: 0, h: 0 },
					bind: 'clone',
					mediaKind: 'audio',
					pairId: 'pair-1',
					snapshot: { bytesRef: 'data:audio/webm;base64,xx' }
				}
			]
		};
		const json = serializeAnimDocument(doc);
		expect(JSON.parse(json).schemaVersion).toBe(1);
		expect(parseAnimDocument(json)).toEqual(doc);
	});

	it('round-trips a layer fragment source', () => {
		const doc: AnimDocument = {
			schemaVersion: 1,
			durationMs: 4000,
			clips: [
				{
					id: 'frag',
					startMs: 0,
					durationMs: 2000,
					frame: { x: 10, y: 20, w: 100, h: 80 },
					bind: 'live',
					mediaKind: 'sketch-fragment',
					source: {
						backend: 'shared-vfs',
						nodeId: 'skch-1',
						generation: 4,
						fragment: { kind: 'layer', pageId: 'page-1', layerId: 'default' }
					}
				}
			]
		};
		const json = serializeAnimDocument(doc);
		expect(JSON.parse(json).schemaVersion).toBe(1);
		expect(parseAnimDocument(json)).toEqual(doc);
	});

	it('drops unknown fragment kinds', () => {
		expect(() =>
			parseAnimDocument({
				schemaVersion: 1,
				durationMs: 100,
				clips: [
					{
						id: 'f',
						startMs: 0,
						durationMs: 100,
						frame: { x: 0, y: 0, w: 1, h: 1 },
						bind: 'live',
						source: {
							backend: 'shared-vfs',
							nodeId: 'skch-1',
							fragment: { kind: 'stroke', pathId: 'p1' }
						}
					}
				]
			})
		).toThrow(/unknown fragment.kind/);
	});

	it('round-trips a path object fragment', () => {
		const json = serializeAnimDocument({
			schemaVersion: 1,
			durationMs: 1000,
			clips: [
				{
					id: 'ink',
					startMs: 0,
					durationMs: 500,
					frame: { x: 0, y: 0, w: 8, h: 8 },
					bind: 'live',
					mediaKind: 'sketch-fragment',
					source: {
						backend: 'shared-vfs',
						nodeId: 'skch-1',
						fragment: {
							kind: 'object',
							pageId: 'page-1',
							layerId: 'default',
							objectKind: 'path',
							objectId: 'stroke-1'
						}
					}
				}
			]
		});
		expect(JSON.parse(json).schemaVersion).toBe(1);
		expect(parseAnimDocument(json).clips[0]).toMatchObject({
			source: { fragment: { objectKind: 'path', objectId: 'stroke-1' } }
		});
	});

	it('clone still forbids source when mediaKind is sketch-fragment', () => {
		expect(() =>
			parseAnimDocument({
				schemaVersion: 1,
				durationMs: 100,
				clips: [
					{
						id: 'c',
						startMs: 0,
						durationMs: 10,
						frame: { x: 0, y: 0, w: 1, h: 1 },
						bind: 'clone',
						mediaKind: 'sketch-fragment',
						source: { backend: 'shared-vfs', nodeId: 'skch-1' }
					}
				]
			})
		).toThrow(/omit source/);
	});

	it('round-trips the view block: layout, windows, playheads', () => {
		const view = {
			layout: { kind: 'split', id: 'anim-root-split', direction: 'col', ratio: 0.6 },
			windows: {
				'anim-canvas': { role: 'canvas', clockId: 'primary' },
				'anim-timeline': { role: 'timeline', clockId: 'clock-2' }
			},
			playheads: { primary: { timeMs: 1200 }, 'clock-2': { timeMs: 3400 } }
		};
		const doc: AnimDocument = { ...cloneDoc, view };
		const json = serializeAnimDocument(doc);
		expect(parseAnimDocument(json).view).toEqual(view);
	});

	it('drops junk view fields and omits an empty view', () => {
		const parsed = parseAnimDocument({
			schemaVersion: 1,
			durationMs: 100,
			clips: [],
			view: {
				layout: 'not-a-layout-object',
				windows: { leaf1: { role: 'canvas', clockId: 'primary' } },
				playheads: { primary: { timeMs: 500 } },
				mystery: true
			}
		});
		expect(parsed.view).toEqual({
			windows: { leaf1: { role: 'canvas', clockId: 'primary' } },
			playheads: { primary: { timeMs: 500 } }
		});
		// Structural junk inside collections is rejected, not silently dropped.
		expect(() =>
			parseAnimDocument({ ...cloneDoc, view: { windows: { leaf2: 'junk' } } })
		).toThrow(/must be an object/);
		expect(() =>
			parseAnimDocument({ ...cloneDoc, view: { playheads: { p: { timeMs: 'nope' } } } })
		).toThrow(/finite number/);
		const json = serializeAnimDocument({ ...cloneDoc, view: undefined });
		expect(JSON.parse(json)).not.toHaveProperty('view');
	});
});

describe('sameFsBackend / assertClipMatchesDoc', () => {
	it('is true iff backends match', () => {
		expect(sameFsBackend('shared-vfs', liveVfsClip.source)).toBe(true);
		expect(sameFsBackend('monitor', liveVfsClip.source)).toBe(false);
		expect(
			sameFsBackend('monitor', { backend: 'monitor', profileId: 'p', relPath: 'a' })
		).toBe(true);
	});

	it('throws on cross-backend clips and allows clone-only', () => {
		expect(() => assertClipMatchesDoc('shared-vfs', liveVfsClip)).not.toThrow();
		expect(() => assertClipMatchesDoc('monitor', liveVfsClip)).toThrow(AnimParseError);
		expect(() => assertClipMatchesDoc('monitor', liveVfsClip)).toThrow(/does not match/);
		expect(() => assertClipMatchesDoc('monitor', cloneDoc.clips[0]!)).not.toThrow();
	});

	it('throws when a non-clone clip is missing source', () => {
		const liveNoSource = {
			id: 'x',
			startMs: 0,
			durationMs: 1,
			frame: { x: 0, y: 0, w: 1, h: 1 },
			bind: 'live'
		} as AnimClip;
		expect(() => assertClipMatchesDoc('shared-vfs', liveNoSource)).toThrow(AnimParseError);
		expect(() => assertClipMatchesDoc('shared-vfs', liveNoSource)).toThrow(/requires source/);
	});
});

describe('composition re-exports', () => {
	it('re-exports the composition clock', () => {
		expect(reexportedClock).toBe(createCompositionClock);
		const clock = reexportedClock(1500);
		expect(clock.get().durationMs).toBe(1500);
		clock.dispose();
	});

	it('re-exports the playhead registry', () => {
		const reg = reexportedRegistry();
		const clock = reg.acquire('primary', 1000);
		expect(clock.get().durationMs).toBe(1000);
		reg.disposeAll();
	});
});
describe('clipSpanMs / clipVisibleAt', () => {
	const spanned: AnimClip = {
		id: 's',
		startMs: 1000,
		durationMs: 4000,
		frame: { x: 0, y: 0, w: 10, h: 10 },
		bind: 'clone',
		keyframes: [{ tMs: 0, x: 1 }, { tMs: 2000, x: 2 }, { tMs: 3500, x: 3 }]
	};

	it('spans from first to last keyframe, absolute', () => {
		expect(clipSpanMs(spanned)).toEqual({ startMs: 1000, endMs: 4500 });
	});

	it('is null for keyframe-less clips and never visible', () => {
		expect(clipSpanMs(cloneDoc.clips[0]!)).toBeNull();
		expect(clipVisibleAt(cloneDoc.clips[0]!, 0)).toBe(false);
	});

	it('is visible exactly inside the span', () => {
		expect(clipVisibleAt(spanned, 999)).toBe(false);
		expect(clipVisibleAt(spanned, 1000)).toBe(true);
		expect(clipVisibleAt(spanned, 4500)).toBe(true);
		expect(clipVisibleAt(spanned, 4501)).toBe(false);
	});
});

describe('view.autoKeyframe', () => {
	it('round-trips the toggle and drops non-true values', () => {
		const on = parseAnimDocument({ ...cloneDoc, view: { autoKeyframe: true } });
		expect(on.view).toEqual({ autoKeyframe: true });
		expect(serializeAnimDocument(on)).toMatch(/autoKeyframe/);
		const off = parseAnimDocument({ ...cloneDoc, view: { autoKeyframe: false } });
		expect(off.view).toBeUndefined();
	});
});
