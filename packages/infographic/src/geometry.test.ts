import { describe, expect, it } from 'vitest';
import { createDocument, getActiveScene, getActiveTake, renderSvg, resolve } from './index.js';
import { MAX_PATH_COMMANDS, MAX_PATH_D_CHARS, sanitizePathD } from './geometry.js';
import type { IgfxObject, ResolvedNode } from './types.js';

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

function shapeObj(extra: Partial<IgfxObject>): IgfxObject {
	return {
		id: extra.id ?? 'shape',
		name: extra.name ?? extra.id ?? 'shape',
		parentId: extra.parentId ?? null,
		kind: extra.kind ?? 'shape',
		visible: extra.visible ?? true,
		transform: extra.transform ?? { x: 10, y: 20, w: 100, h: 50, rotation: 0, opacity: 1 },
		...extra
	};
}

describe('sanitizePathD', () => {
	it('re-emits commands and numbers and strips markup', () => {
		expect(sanitizePathD('M0,0 L10 10')).toBe('M 0 0 L 10 10');
		expect(sanitizePathD('M0 0 L10 10<script>alert(x)</script>')).toBe('M 0 0 L 10 10');
		expect(sanitizePathD('M0 0 <image href="x"> L1 1')).toBe('M 0 0 L 1 1');
		expect(sanitizePathD('')).toBe('');
	});

	it('caps command count and input length', () => {
		const many = Array.from({ length: MAX_PATH_COMMANDS + 50 }, (_, i) => `M${i} 0`).join(' ');
		const sanitized = sanitizePathD(many);
		const commands = sanitized.match(/[MmLlHhVvCcSsQqTtAaZz]/g) ?? [];
		expect(commands.length).toBe(MAX_PATH_COMMANDS);
		const long = `M0 0 ${'1 '.repeat(MAX_PATH_D_CHARS)}`;
		expect(sanitizePathD(long).length).toBeLessThan(long.length);
	});
});

describe('shape and path renderers', () => {
	it('renders rect / ellipse / line from the world box', () => {
		const doc = createDocument();
		const scene = getActiveScene(doc);
		scene.objects = [
			shapeObj({ id: 'box', shape: { primitive: 'rect' }, style: { fill: '#ff0000' } }),
			shapeObj({
				id: 'oval',
				shape: { primitive: 'ellipse' },
				transform: { x: 200, y: 40, w: 80, h: 40, rotation: 0, opacity: 1 }
			}),
			shapeObj({
				id: 'rule',
				shape: { primitive: 'line' },
				transform: { x: 0, y: 0, w: 40, h: 30, rotation: 0, opacity: 1 },
				style: { stroke: '#111111', strokeWidth: 4 }
			})
		];
		const frame = resolve(doc, 0);
		const rect = findById(frame.nodes, 'box:shape');
		expect(rect?.tag).toBe('rect');
		expect(rect?.attrs).toMatchObject({ x: '10', y: '20', width: '100', height: '50', fill: '#ff0000' });
		const oval = findById(frame.nodes, 'oval:shape');
		expect(oval?.tag).toBe('ellipse');
		expect(Number(oval?.attrs.cx)).toBe(240);
		expect(Number(oval?.attrs.cy)).toBe(60);
		expect(Number(oval?.attrs.rx)).toBe(40);
		expect(Number(oval?.attrs.ry)).toBe(20);
		const line = findById(frame.nodes, 'rule:shape');
		expect(line?.tag).toBe('line');
		expect(line?.attrs).toMatchObject({ x1: '0', y1: '0', x2: '40', y2: '30', stroke: '#111111' });
		expect(line?.attrs['stroke-width']).toBe('4');
	});

	it('applies sampled w/h to the shape box', () => {
		const doc = createDocument();
		getActiveScene(doc).objects = [
			shapeObj({ id: 'box', shape: { primitive: 'rect' }, transform: { x: 10, y: 20, w: 100, h: 50, rotation: 0, opacity: 1 } })
		];
		getActiveTake(getActiveScene(doc)).tracks = [
			{
				id: 'track-box',
				objectId: 'box',
				startMs: 0,
				durationMs: 8000,
				curves: [
					{ id: 'w', prop: 'w', keyframes: [{ tMs: 0, value: 200 }] },
					{ id: 'h', prop: 'h', keyframes: [{ tMs: 0, value: 80 }] }
				]
			}
		];
		const rect = findById(resolve(doc, 0).nodes, 'box:shape');
		expect(rect?.attrs.width).toBe('200');
		expect(rect?.attrs.height).toBe('80');
	});

	it('sanitises path.d and translates object-local commands', () => {
		const doc = createDocument();
		getActiveScene(doc).objects = [
			shapeObj({
				id: 'ink',
				kind: 'path',
				path: { d: 'M0 0 L20 0<script>hack()</script>', closed: true },
				transform: { x: 50, y: 60, w: 20, h: 20, rotation: 0, opacity: 1 }
			})
		];
		const frame = resolve(doc, 0);
		const path = findById(frame.nodes, 'ink:path');
		expect(path?.attrs.d).toMatch(/^M 0 0 L 20 0 Z$/);
		expect(path?.attrs.d).not.toContain('<');
		expect(path?.attrs.d).not.toContain('script');
		expect(path?.attrs.transform).toBe('translate(50 60)');
		expect(path?.attrs.fill).toBe('#2563eb');
		const svg = renderSvg(frame);
		expect(svg).not.toContain('<script');
		expect(svg).toContain('d="M 0 0 L 20 0 Z"');
	});
});
