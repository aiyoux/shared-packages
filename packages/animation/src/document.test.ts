import { describe, expect, it } from 'vitest';
import { createCompositionClock } from '@shared-packages/composition';
import {
	AnimParseError,
	assertClipMatchesDoc,
	createCompositionClock as reexportedClock,
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

	it('rejects unsupported schemaVersion', () => {
		expect(() => parseAnimDocument({ schemaVersion: 3, durationMs: 0, clips: [] })).toThrow(
			/schemaVersion/
		);
	});

	it('accepts schemaVersion 2 with no clips', () => {
		expect(parseAnimDocument({ schemaVersion: 2, durationMs: 0, clips: [] })).toEqual({
			schemaVersion: 2,
			durationMs: 0,
			clips: []
		});
	});

	it('rejects a sketch fragment on schemaVersion 1', () => {
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
						bind: 'live',
						source: {
							backend: 'shared-vfs',
							nodeId: 'skch-1',
							fragment: { kind: 'page', pageId: 'page-1' }
						}
					}
				]
			})
		).toThrow(/schemaVersion 1 cannot carry a sketch fragment/);
	});

	it('rejects mediaKind sketch-fragment on schemaVersion 1', () => {
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
						mediaKind: 'sketch-fragment',
						snapshot: { bytesRef: 'data:image/png;base64,xx' }
					}
				]
			})
		).toThrow(/sketch-fragment/);
	});

	it('round-trips a v2 page fragment and writes schemaVersion 2', () => {
		const doc: AnimDocument = {
			schemaVersion: 2,
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
		expect(JSON.parse(json).schemaVersion).toBe(2);
		expect(parseAnimDocument(json)).toEqual(doc);
	});

	it('serializes image-only docs as schemaVersion 1 even if the input said 2', () => {
		const json = serializeAnimDocument({
			schemaVersion: 2,
			durationMs: 4000,
			clips: cloneDoc.clips
		});
		expect(JSON.parse(json).schemaVersion).toBe(1);
		expect(parseAnimDocument(json).schemaVersion).toBe(1);
	});

	it('bumps serialize to 2 when a v1-labelled doc carries a non-file fragment', () => {
		const json = serializeAnimDocument({
			schemaVersion: 1,
			durationMs: 1000,
			clips: [
				{
					id: 'obj',
					startMs: 0,
					durationMs: 500,
					frame: { x: 0, y: 0, w: 8, h: 8 },
					bind: 'snapshot',
					mediaKind: 'sketch-fragment',
					source: {
						backend: 'shared-vfs',
						nodeId: 'skch-1',
						fragment: {
							kind: 'object',
							pageId: 'page-1',
							layerId: 'default',
							objectKind: 'image',
							objectId: 'img-1'
						}
					},
					snapshot: { bytesRef: 'data:image/png;base64,xx', atGeneration: 2 }
				}
			]
		});
		expect(JSON.parse(json).schemaVersion).toBe(2);
		const parsed = parseAnimDocument(json);
		expect(parsed.clips[0]).toMatchObject({
			bind: 'snapshot',
			mediaKind: 'sketch-fragment',
			source: {
				backend: 'shared-vfs',
				nodeId: 'skch-1',
				fragment: {
					kind: 'object',
					pageId: 'page-1',
					layerId: 'default',
					objectKind: 'image',
					objectId: 'img-1'
				}
			}
		});
	});

	it('keeps a file fragment on v1 and drops unknown fragment kinds on v2', () => {
		const withFile = parseAnimDocument({
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
						nodeId: 'img-1',
						fragment: { kind: 'file' }
					}
				}
			]
		});
		expect(withFile.schemaVersion).toBe(1);
		expect(withFile.clips[0]).toMatchObject({
			source: { backend: 'shared-vfs', nodeId: 'img-1', fragment: { kind: 'file' } }
		});
		expect(() =>
			parseAnimDocument({
				schemaVersion: 2,
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

	it('clone still forbids source when mediaKind is sketch-fragment', () => {
		expect(() =>
			parseAnimDocument({
				schemaVersion: 2,
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

describe('createCompositionClock re-export', () => {
	it('is the composition clock', () => {
		expect(reexportedClock).toBe(createCompositionClock);
		const clock = reexportedClock(1500);
		expect(clock.get().durationMs).toBe(1500);
		clock.dispose();
	});
});
