import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { encodeDraftPayload, decodeDraftPayload } from '../src/draftPayload.ts';

/**
 * A draft is unsaved work, and for the voice recorder that work is audio.
 * The payload column is JSON, and `JSON.stringify(blob)` is `{}` — so a Blob
 * used to be replaced by an empty object with nothing thrown, and the app
 * discarded its own crash draft as corrupt on every restore.
 */
describe('draft payload encoding', () => {
	const roundTrip = async (v: unknown) => decodeDraftPayload(await encodeDraftPayload(v));

	it('round-trips a Blob, which plain JSON silently emptied', async () => {
		const blob = new Blob([new Uint8Array([1, 2, 3, 250])], { type: 'audio/webm' });
		// The bug, stated: this is what the old path stored.
		assert.equal(JSON.stringify(blob), '{}');

		const back = (await roundTrip(blob)) as Blob;
		assert.ok(back instanceof Blob);
		assert.equal(back.type, 'audio/webm');
		assert.deepEqual([...new Uint8Array(await back.arrayBuffer())], [1, 2, 3, 250]);
	});

	it('round-trips a Blob nested inside the payload an app actually writes', async () => {
		const payload = {
			id: 'voice:current-draft',
			blob: new Blob([new Uint8Array([9, 8, 7])], { type: 'audio/webm' }),
			samples: [0.1, 0.2],
			duration: 0.5,
			markers: [{ id: 'm1', time: 0.2, name: 'Marker' }],
			loadedRecordingId: null,
			updatedAt: 1234
		};
		const back = (await roundTrip(payload)) as typeof payload;
		assert.ok(back.blob instanceof Blob);
		assert.equal(back.blob.size, 3);
		assert.deepEqual(back.samples, [0.1, 0.2]);
		assert.deepEqual(back.markers, payload.markers);
		assert.equal(back.loadedRecordingId, null);
		assert.equal(back.updatedAt, 1234);
	});

	it('survives the JSON hop the catalog actually performs', async () => {
		const payload = { blob: new Blob([new Uint8Array([4, 5])], { type: 'audio/webm' }) };
		const stored = JSON.stringify(await encodeDraftPayload(payload));
		const back = decodeDraftPayload(JSON.parse(stored)) as { blob: Blob };
		assert.ok(back.blob instanceof Blob);
		assert.deepEqual([...new Uint8Array(await back.blob.arrayBuffer())], [4, 5]);
	});

	it('round-trips typed arrays and array buffers', async () => {
		const back = (await roundTrip({
			bytes: new Uint8Array([1, 2, 3]),
			buffer: new Uint8Array([4, 5]).buffer
		})) as { bytes: Uint8Array; buffer: Uint8Array };
		assert.deepEqual([...back.bytes], [1, 2, 3]);
		assert.deepEqual([...back.buffer], [4, 5]);
	});

	it('leaves ordinary payloads exactly as they were', async () => {
		const payload = { a: 1, b: 'two', c: [1, { d: true }], e: null };
		assert.deepEqual(await roundTrip(payload), payload);
	});

	it('handles a blob big enough to break naive base64', async () => {
		// String.fromCharCode(...bytes) throws past the argument limit.
		const big = new Uint8Array(200_000).map((_, i) => i % 256);
		const back = (await roundTrip(new Blob([big], { type: 'audio/webm' }))) as Blob;
		assert.equal(back.size, 200_000);
		const bytes = new Uint8Array(await back.arrayBuffer());
		assert.equal(bytes[0], 0);
		assert.equal(bytes[199_999], big[199_999]);
	});

	it('decodes a payload that was never encoded', async () => {
		assert.deepEqual(decodeDraftPayload({ plain: 'value' }), { plain: 'value' });
		assert.equal(decodeDraftPayload(null), null);
	});
});
