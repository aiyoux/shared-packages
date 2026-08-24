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

	it('ignores extra fields including rotation and does not persist them', () => {
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
		expect(parsed.clips[0]?.frame).toEqual({ x: 1, y: 2, w: 3, h: 4 });
		expect(parsed).not.toHaveProperty('name');
		const json = serializeAnimDocument(parsed);
		expect(json).not.toMatch(/rotation/);
		expect(json).not.toMatch(/mystery/);
		expect(JSON.parse(json)).toEqual({
			schemaVersion: 1,
			durationMs: 2000,
			clips: [
				{
					id: 'r',
					startMs: 0,
					durationMs: 2000,
					frame: { x: 1, y: 2, w: 3, h: 4 },
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
		expect(() => parseAnimDocument({ schemaVersion: 2, durationMs: 0, clips: [] })).toThrow(
			/schemaVersion/
		);
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
