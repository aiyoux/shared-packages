import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	createDocument,
	createTake,
	getActiveScene,
	getActiveTake,
	instantiateTemplate,
	MAX_OBJECTS_PER_SCENE,
	MAX_SCENES,
	parseIgfx,
	renderSvg,
	resolve,
	resolveScene,
	TEMPLATE_IDS
} from './index.js';
import type { IgfxDocument, ResolvedFrame, ResolvedNode } from './types.js';

const goldensDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'goldens');

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

/** Innermost node with this id (renderer root under the shim wrapper). */
function findInner(nodes: ResolvedNode[], id: string): ResolvedNode | undefined {
	const outer = findById(nodes, id);
	if (outer?.children?.length === 1 && outer.children[0].id === id) return outer.children[0];
	return outer;
}

/** Drop identity rotate wrappers so S2 SVG compares to pre-S1 snapshots. */
function flattenIdentityWrappers(node: ResolvedNode): ResolvedNode {
	const children = node.children?.map(flattenIdentityWrappers);
	const next = children ? { ...node, children } : { ...node };
	if (
		next.tag === 'g' &&
		next.children?.length === 1 &&
		next.children[0].tag === 'g' &&
		next.children[0].id === next.id
	) {
		const inner = next.children[0];
		const rot = /^rotate\(([-\d.eE]+)\s/.exec(next.attrs.transform ?? '');
		const angle = rot ? Number(rot[1]) : 0;
		const wrapperOpacity = Number(next.attrs.opacity ?? 1);
		const innerOpacity = Number(inner.attrs.opacity ?? 1);
		const attrs: Record<string, string> = {
			...inner.attrs,
			opacity: String(wrapperOpacity * innerOpacity)
		};
		if (angle !== 0 && next.attrs.transform) attrs.transform = next.attrs.transform;
		return { ...inner, id: next.id, attrs, children: inner.children };
	}
	return next;
}

function visualSvg(frame: ResolvedFrame): string {
	return renderSvg({ ...frame, nodes: frame.nodes.map(flattenIdentityWrappers) });
}

function linearProgressDoc(kind: 'bar' | 'line' | 'stat'): IgfxDocument {
	if (kind === 'bar') {
		return parseIgfx({
			format: 'igfx',
			schemaVersion: 1,
			name: 'motion',
			datasets: [
				{
					id: 'd',
					label: 'D',
					columns: [
						{ id: 'cat', label: 'Cat', type: 'string' },
						{ id: 'n', label: 'N', type: 'number' }
					],
					rows: [
						{ cat: 'A', n: 10 },
						{ cat: 'B', n: 20 }
					]
				}
			],
			marks: [
				{
					id: 'm',
					kind: 'bar',
					layout: { x: 0, y: 0, w: 200, h: 100 },
					bindings: { category: { ref: 'dataset:d.cat' }, value: { ref: 'dataset:d.n' } }
				}
			],
			timeline: {
				durationMs: 8000,
				posterMs: 8000,
				tracks: [
					{
						id: 'grow',
						target: 'mark:m.progress',
						keyframes: [
							{ tMs: 0, value: 0, easing: 'linear' },
							{ tMs: 1000, value: 1 }
						]
					}
				]
			}
		});
	}
	if (kind === 'line') {
		return parseIgfx({
			format: 'igfx',
			schemaVersion: 1,
			name: 'motion',
			datasets: [
				{
					id: 'd',
					label: 'D',
					columns: [
						{ id: 't', label: 'T', type: 'number' },
						{ id: 'n', label: 'N', type: 'number' }
					],
					rows: [
						{ t: 0, n: 1 },
						{ t: 1, n: 3 },
						{ t: 2, n: 2 }
					]
				}
			],
			marks: [
				{
					id: 'm',
					kind: 'line',
					layout: { x: 10, y: 10, w: 200, h: 100 },
					bindings: { x: { ref: 'dataset:d.t' }, y: { ref: 'dataset:d.n' } }
				}
			],
			timeline: {
				durationMs: 8000,
				posterMs: 8000,
				tracks: [
					{
						id: 'grow',
						target: 'mark:m.progress',
						keyframes: [
							{ tMs: 0, value: 0, easing: 'linear' },
							{ tMs: 1000, value: 1 }
						]
					}
				]
			}
		});
	}
	return parseIgfx({
		format: 'igfx',
		schemaVersion: 1,
		name: 'motion',
		scalars: [{ id: 'v', label: 'V', type: 'number', value: 100 }],
		marks: [
			{
				id: 'm',
				kind: 'stat',
				layout: { x: 0, y: 0, w: 200, h: 80 },
				bindings: { value: { ref: 'scalar:v' } }
			}
		],
		timeline: {
			durationMs: 8000,
			posterMs: 8000,
			tracks: [
				{
					id: 'grow',
					target: 'mark:m.progress',
					keyframes: [
						{ tMs: 0, value: 0, easing: 'linear' },
						{ tMs: 1000, value: 1 }
					]
				}
			]
		}
	});
}

describe('resolve progress', () => {
	it('changes bar length at 0 / 0.5 / 1', () => {
		const doc = linearProgressDoc('bar');
		const a = findById(resolve(doc, 0).nodes, 'm:1');
		const b = findById(resolve(doc, 500).nodes, 'm:1');
		const c = findById(resolve(doc, 1000).nodes, 'm:1');
		const l0 = Number(a?.attrs['data-length']);
		const lHalf = Number(b?.attrs['data-length']);
		const l1 = Number(c?.attrs['data-length']);
		expect(l0).toBe(0);
		expect(l1).toBeGreaterThan(0);
		expect(lHalf).toBeCloseTo(l1 * 0.5, 5);
		expect(Number(c?.attrs.height)).toBeGreaterThan(Number(a?.attrs.height));
	});

	it('changes line clip-rect width at 0 / 0.5 / 1', () => {
		const doc = linearProgressDoc('line');
		const r0 = findById(resolve(doc, 0).nodes, 'm:clip-rect');
		const rHalf = findById(resolve(doc, 500).nodes, 'm:clip-rect');
		const r1 = findById(resolve(doc, 1000).nodes, 'm:clip-rect');
		expect(r0?.attrs.x).toBe('10');
		expect(rHalf?.attrs.x).toBe('10');
		expect(r1?.attrs.x).toBe('10');
		expect(Number(r0?.attrs.width)).toBe(0);
		expect(Number(rHalf?.attrs.width)).toBeCloseTo(100, 5);
		expect(Number(r1?.attrs.width)).toBe(200);
		expect(r0?.attrs.height).toBe('100');
		expect(r1?.attrs.y).toBe('10');
	});

	it('changes stat count-up at 0 / 0.5 / 1', () => {
		const doc = linearProgressDoc('stat');
		expect(findById(resolve(doc, 0).nodes, 'm:value')?.attrs['data-raw']).toBe('0');
		expect(findById(resolve(doc, 500).nodes, 'm:value')?.attrs['data-raw']).toBe('50');
		expect(findById(resolve(doc, 1000).nodes, 'm:value')?.attrs['data-raw']).toBe('100');
	});
});

describe('missing bindings', () => {
	it('yields empty series and warnings', () => {
		const doc = parseIgfx({
			format: 'igfx',
			schemaVersion: 1,
			marks: [
				{
					id: 'bars',
					kind: 'bar',
					layout: { x: 0, y: 0, w: 100, h: 100 },
					bindings: { category: { ref: 'dataset:missing.cat' }, value: { ref: 'dataset:missing.n' } }
				},
				{
					id: 'trend',
					kind: 'line',
					layout: { x: 0, y: 0, w: 100, h: 100 },
					bindings: { x: { ref: 'dataset:missing.t' }, y: { ref: 'dataset:missing.n' } }
				},
				{
					id: 'kpi',
					kind: 'stat',
					layout: { x: 0, y: 0, w: 100, h: 100 },
					bindings: { value: { ref: 'scalar:gone' } }
				},
				{
					id: 'caption',
					kind: 'text',
					layout: { x: 0, y: 0, w: 100, h: 40 },
					bindings: {}
				},
				{
					id: 'leg',
					kind: 'legend',
					layout: { x: 0, y: 0, w: 100, h: 20 },
					bindings: {}
				},
				{
					id: 'ax',
					kind: 'axis',
					layout: { x: 0, y: 0, w: 100, h: 100 },
					bindings: {}
				}
			]
		});
		const frame = resolve(doc, 0);
		expect(frame.warnings.length).toBeGreaterThan(0);
		const bars = findById(frame.nodes, 'bars');
		const barsInner =
			bars?.children?.length === 1 && bars.children[0].id === 'bars' ? bars.children[0] : bars;
		expect(barsInner?.children ?? []).toEqual([]);
		expect(findById(frame.nodes, 'trend:path')?.attrs.d).toBe('');
		expect(findById(frame.nodes, 'kpi:value')?.text).toBe('—');
		expect(findById(frame.nodes, 'caption:text')?.text).toBe('');
		expect(findInner(frame.nodes, 'leg')?.attrs['data-hidden']).toBe('true');
		expect(findInner(frame.nodes, 'ax')?.attrs['data-hidden']).toBe('true');
	});

	it('warns when forMark is dangling or has no series', () => {
		const doc = parseIgfx({
			format: 'igfx',
			schemaVersion: 1,
			marks: [
				{
					id: 'leg',
					kind: 'legend',
					layout: { x: 0, y: 0, w: 100, h: 20 },
					bindings: { forMark: 'bars' }
				},
				{
					id: 'ax',
					kind: 'axis',
					layout: { x: 0, y: 0, w: 100, h: 100 },
					bindings: { forMark: 'gone' }
				}
			]
		});
		const frame = resolve(doc, 0);
		expect(frame.warnings.some((w) => /Mark "leg" forMark "bars" has no series/.test(w))).toBe(true);
		expect(frame.warnings.some((w) => /Mark "ax" forMark "gone" has no series/.test(w))).toBe(true);
		expect(findInner(frame.nodes, 'leg')?.attrs['data-hidden']).toBe('true');
		expect(findInner(frame.nodes, 'ax')?.attrs['data-hidden']).toBe('true');
	});
});

describe('template motion vs poster', () => {
	it('bar-compare title is faded at t=0 and solid at posterMs', () => {
		const doc = instantiateTemplate('bar-compare');
		const start = findById(resolve(doc, 0).nodes, 'title');
		const end = findById(resolve(doc, getActiveTake(getActiveScene(doc)).posterMs).nodes, 'title');
		expect(Number(start?.attrs.opacity)).toBe(0);
		expect(Number(end?.attrs.opacity)).toBe(1);
	});

	it('bar-compare still has #bars geometry at posterMs and durationMs', () => {
		const doc = instantiateTemplate('bar-compare');
		const take = getActiveTake(getActiveScene(doc));
		expect(take.durationMs).toBe(8000);
		for (const tMs of [8000, take.durationMs, take.posterMs]) {
			const frame = resolve(doc, tMs);
			const bars = findById(frame.nodes, 'bars');
			expect(bars?.children?.length).toBeGreaterThan(0);
			expect(Number(findById(frame.nodes, 'bars:0')?.attrs['data-length'])).toBeGreaterThan(0);
		}
	});
});

describe('scene overrides', () => {
	it('uses the active scene artboard and theme for the frame', () => {
		const doc = parseIgfx({
			format: 'igfx',
			schemaVersion: 2,
			artboard: { width: 1920, height: 1080 },
			theme: { background: '#ffffff' },
			scenes: [
				{
					id: 'scene-square',
					name: 'Square',
					artboard: { width: 1080, height: 1080 },
					themeOverride: { background: '#111111' },
					objects: [],
					timelines: [{ id: 'take-1', name: 'Take 1', durationMs: 8000, posterMs: 8000, tracks: [] }],
					activeTimelineId: 'take-1'
				}
			],
			activeSceneId: 'scene-square'
		});
		const frame = resolve(doc, 0);
		expect(frame.width).toBe(1080);
		expect(frame.height).toBe(1080);
		expect(frame.background).toBe('#111111');
	});
});

describe('resolveScene / take semantics', () => {
	it('empty take draws unlinked objects at rest pose', () => {
		const doc = parseIgfx({
			format: 'igfx',
			schemaVersion: 1,
			marks: [
				{
					id: 't',
					kind: 'text',
					layout: { x: 10, y: 20, w: 200, h: 40 },
					bindings: { text: 'rest' }
				}
			]
		});
		expect(getActiveTake(getActiveScene(doc)).tracks).toEqual([]);
		const frame = resolve(doc, 0);
		expect(findById(frame.nodes, 't:text')?.text).toBe('rest');
		expect(Number(findById(frame.nodes, 't')?.attrs.opacity)).toBe(1);
	});

	it('unlinked objects stay visible when the take has other tracks', () => {
		const doc = parseIgfx({
			format: 'igfx',
			schemaVersion: 1,
			marks: [
				{
					id: 'title',
					kind: 'text',
					layout: { x: 0, y: 0, w: 100, h: 40 },
					bindings: { text: 'A' }
				},
				{
					id: 'caption',
					kind: 'text',
					layout: { x: 0, y: 50, w: 100, h: 40 },
					bindings: { text: 'B' }
				}
			],
			timeline: {
				durationMs: 8000,
				posterMs: 8000,
				tracks: [
					{
						id: 'title-in',
						target: 'mark:title.opacity',
						keyframes: [
							{ tMs: 0, value: 0 },
							{ tMs: 400, value: 1 }
						]
					}
				]
			}
		});
		const frame = resolve(doc, 0);
		expect(findById(frame.nodes, 'title:text')?.text).toBe('A');
		expect(findById(frame.nodes, 'caption:text')?.text).toBe('B');
	});

	it('hides a linked object outside its closed track range', () => {
		const doc = createDocument();
		const scene = getActiveScene(doc);
		scene.objects = [
			{
				id: 't',
				name: 't',
				parentId: null,
				kind: 'text',
				visible: true,
				transform: { x: 0, y: 0, w: 100, h: 40, rotation: 0, opacity: 1 },
				bindings: { text: 'clip' }
			}
		];
		getActiveTake(scene).tracks = [
			{
				id: 'track-t',
				objectId: 't',
				startMs: 1000,
				durationMs: 500,
				curves: []
			}
		];
		expect(findById(resolve(doc, 0).nodes, 't')).toBeUndefined();
		expect(findById(resolve(doc, 1000).nodes, 't:text')?.text).toBe('clip');
		expect(findById(resolve(doc, 1500).nodes, 't:text')?.text).toBe('clip');
		expect(findById(resolve(doc, 1501).nodes, 't')).toBeUndefined();
	});

	it('warns when the scene is missing', () => {
		const doc = createDocument();
		const frame = resolveScene(doc, 'nope', 0);
		expect(frame.warnings).toContain('missing scene:nope');
		expect(frame.nodes).toEqual([]);
	});

	it('warns when the take is missing and uses rest pose', () => {
		const doc = parseIgfx({
			format: 'igfx',
			schemaVersion: 1,
			marks: [
				{
					id: 't',
					kind: 'text',
					layout: { x: 0, y: 0, w: 100, h: 40 },
					bindings: { text: 'hi' }
				}
			]
		});
		const scene = getActiveScene(doc);
		const frame = resolveScene(doc, scene.id, 0, 'nope');
		expect(frame.warnings).toContain('missing take:nope');
		expect(findById(frame.nodes, 't:text')?.text).toBe('hi');
	});

	it('overlays sampled value on a stat binding', () => {
		const doc = parseIgfx({
			format: 'igfx',
			schemaVersion: 1,
			scalars: [{ id: 'v', label: 'V', type: 'number', value: 100 }],
			marks: [
				{
					id: 'm',
					kind: 'stat',
					layout: { x: 0, y: 0, w: 200, h: 80 },
					bindings: { value: { ref: 'scalar:v' } }
				}
			],
			timeline: {
				durationMs: 8000,
				posterMs: 8000,
				tracks: [
					{
						id: 'val',
						target: 'mark:m.value',
						keyframes: [{ tMs: 0, value: 50 }]
					},
					{
						id: 'grow',
						target: 'mark:m.progress',
						keyframes: [
							{ tMs: 0, value: 0.5 },
							{ tMs: 1000, value: 1 }
						]
					}
				]
			}
		});
		expect(findById(resolve(doc, 0).nodes, 'm:value')?.attrs['data-raw']).toBe('25');
		expect(findById(resolve(doc, 1000).nodes, 'm:value')?.attrs['data-raw']).toBe('50');
	});
});

describe('caps fixtures', () => {
	it('does not read objects[] of inactive scenes in a 32-scene file', () => {
		const doc = instantiateTemplate('bar-compare');
		const active = doc.scenes[0];
		let inactiveReads = 0;
		const scenes = [active];
		for (let i = 1; i < MAX_SCENES; i += 1) {
			const payload = [
				{
					id: `inactive-${i}`,
					name: `inactive-${i}`,
					parentId: null as string | null,
					kind: 'text' as const,
					visible: true,
					transform: { x: 0, y: 0, w: 10, h: 10, rotation: 0, opacity: 1 },
					bindings: { text: 'nope' }
				}
			];
			const take = createTake('Take 1');
			scenes.push({
				id: `scene-inactive-${i}`,
				name: `Inactive ${i}`,
				get objects() {
					inactiveReads += 1;
					return payload;
				},
				timelines: [take],
				activeTimelineId: take.id
			});
		}
		doc.scenes = scenes;
		doc.activeSceneId = active.id;
		const frame = resolve(doc, 8000);
		expect(inactiveReads).toBe(0);
		expect(findById(frame.nodes, 'bars')).toBeTruthy();
	});

	it('resolves a 256-object active scene', () => {
		const doc = createDocument();
		const scene = getActiveScene(doc);
		scene.objects = Array.from({ length: MAX_OBJECTS_PER_SCENE }, (_, i) => ({
			id: `o${i}`,
			name: `o${i}`,
			parentId: null,
			kind: 'text' as const,
			visible: true,
			transform: { x: 0, y: i, w: 10, h: 10, rotation: 0, opacity: 1 },
			bindings: { text: String(i) }
		}));
		const frame = resolve(doc, 0);
		expect(frame.nodes).toHaveLength(MAX_OBJECTS_PER_SCENE);
		expect(findById(frame.nodes, 'o0:text')?.text).toBe('0');
		expect(findById(frame.nodes, 'o255:text')?.text).toBe('255');
	});
});

describe('template goldens vs pre-S1 renderSvg', () => {
	it.each(TEMPLATE_IDS)('%s matches pre-S1 at 0 / 400 / 800 / 8000', (id) => {
		const doc = instantiateTemplate(id);
		const take = getActiveTake(getActiveScene(doc));
		expect(take.posterMs).toBe(8000);
		expect(take.durationMs).toBe(8000);
		for (const tMs of [0, 400, 800, 8000] as const) {
			const svg = visualSvg(resolve(doc, tMs));
			const expected = readFileSync(join(goldensDir, `${id}-${tMs}.svg`), 'utf8');
			expect(svg).toBe(expected);
		}
		expect(visualSvg(resolve(doc, take.posterMs))).toBe(readFileSync(join(goldensDir, `${id}-8000.svg`), 'utf8'));
		expect(visualSvg(resolve(doc, take.durationMs))).toBe(readFileSync(join(goldensDir, `${id}-8000.svg`), 'utf8'));
	});

	it('migrated bar-compare at t=8000 contains #bars geometry', () => {
		const doc = instantiateTemplate('bar-compare');
		const svg = renderSvg(resolve(doc, 8000));
		expect(svg).toContain('id="bars"');
		const bars = findById(resolve(doc, 8000).nodes, 'bars');
		expect(bars).toBeTruthy();
		expect(Number(findById(resolve(doc, 8000).nodes, 'bars:0')?.attrs['data-length'])).toBeGreaterThan(0);
	});
});

