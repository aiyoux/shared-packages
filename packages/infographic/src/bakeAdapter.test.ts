import { afterEach, describe, expect, it } from 'vitest';
import {
	bakeFpsFor,
	bakeSignature,
	clearBakeCache,
	defaultScene3dMark,
	documentHasScene3d,
	ensureBaked,
	ensureDocumentBaked,
	peekBake,
	setBakeAdapter,
	type BakeAdapter,
	type BakedPath
} from './bakeAdapter.js';
import { createDocument, parseIgfx, resolve } from './index.js';
import { SCENE3D_EXPORT_FPS } from './types.js';

const samplePath: BakedPath = { d: 'M0 0 L10 0', stroke: '#000', fill: 'none', strokeWidth: 2 };

function mockAdapter(paths: BakedPath[] = [samplePath]): BakeAdapter & { encodes: number } {
	const adapter = {
		encodes: 0,
		async encodeToSvg() {
			adapter.encodes += 1;
			return paths;
		},
		async acquireLive() {
			throw new Error('live not used in unit tests');
		}
	};
	return adapter;
}

afterEach(() => {
	clearBakeCache();
	setBakeAdapter(null);
});

describe('bake cache', () => {
	it('resolve stays sync and warns when the cache is cold', () => {
		const doc = createDocument();
		doc.marks = [defaultScene3dMark('cube')];
		const frame = resolve(doc, 0);
		expect(frame.warnings.some((w) => w === 'bake pending:cube')).toBe(true);
		expect(frame.nodes[0]?.children?.[0]?.attrs['data-bake']).toBe('pending');
	});

	it('ensureBaked fills the cache and resolve consumes it', async () => {
		const adapter = mockAdapter();
		setBakeAdapter(adapter);
		const mark = defaultScene3dMark('cube');
		const paths = await ensureBaked(mark, 0, 30);
		expect(paths).toEqual([samplePath]);
		expect(adapter.encodes).toBe(1);
		const again = await ensureBaked(mark, 0, 30);
		expect(again).toEqual([samplePath]);
		expect(adapter.encodes).toBe(1);
		expect(peekBake(mark.id, bakeSignature(mark, 0, 30))).toEqual([samplePath]);

		const doc = createDocument();
		doc.marks = [mark];
		const frame = resolve(doc, 0);
		expect(frame.warnings.some((w) => w.startsWith('bake pending:'))).toBe(false);
		expect(frame.nodes[0]?.attrs['data-bake']).toBe('ready');
		expect(frame.nodes[0]?.children?.[0]?.attrs.d).toBe(samplePath.d);
	});

	it('export fps drops to 12 when any scene3d is present', () => {
		const doc = createDocument();
		expect(bakeFpsFor(doc, true)).toBe(30);
		doc.marks = [defaultScene3dMark('a')];
		expect(documentHasScene3d(doc)).toBe(true);
		expect(bakeFpsFor(doc, true)).toBe(SCENE3D_EXPORT_FPS);
		expect(bakeFpsFor(doc, false)).toBe(30);
	});

	it('ensureDocumentBaked walks every scene3d mark', async () => {
		const adapter = mockAdapter();
		setBakeAdapter(adapter);
		const doc = parseIgfx({
			format: 'igfx',
			marks: [defaultScene3dMark('a'), defaultScene3dMark('b', { x: 500, y: 80, w: 200, h: 200 })]
		});
		await ensureDocumentBaked(doc, 0, 12);
		expect(adapter.encodes).toBe(2);
		expect(peekBake('a', bakeSignature(doc.marks[0] as never, 0, 12))?.length).toBe(1);
	});
});
