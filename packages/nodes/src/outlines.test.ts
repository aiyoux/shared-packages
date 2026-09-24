import { describe, expect, it } from 'vitest';
import { evaluateOutput, outlineNodeDocument, parseNodeDocument, serializeNodeDocument } from './index.js';

describe('outline graph', () => {
	it('round-trips the automatic scene → outlines → path output graph', () => {
		const doc = outlineNodeDocument();
		const again = parseNodeDocument(serializeNodeDocument(doc));
		expect(again.nodes.map((node) => node.kind)).toEqual(['scene', 'outlines', 'output']);
		expect(again.wires).toHaveLength(2);
		const scene = again.nodes[0];
		expect(scene).toMatchObject({ kind: 'scene', bind: 'clone', host: true });
	});

	it('asks the host to encode the host scene into path items', async () => {
		const result = await evaluateOutput(outlineNodeDocument(), {
			loadImage: async () => null,
			applyFilter: async () => null,
			loadScene: async () => ({ name: 'cube' }),
			encodeOutlines: async (scene) => [{ d: `M ${scene.name}`, stroke: '#111', strokeWidth: 1.5 }]
		});
		expect(result).toEqual({
			ok: true,
			type: { kind: 'array', of: 'path' },
			items: [{ kind: 'path', d: 'M cube', stroke: '#111', strokeWidth: 1.5 }]
		});
	});
});
