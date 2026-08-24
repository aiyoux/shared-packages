import { describe, expect, it } from 'vitest';
import { parseExplorerDropPayload } from './explorer-drop.ts';

describe('parseExplorerDropPayload', () => {
	it('prefers JSON driverId + ids', () => {
		expect(
			parseExplorerDropPayload('{"driverId":"memory","ids":[" a ","b"]}')
		).toEqual({ driverId: 'memory', ids: ['a', 'b'] });
	});

	it('omits a missing or blank driverId', () => {
		expect(parseExplorerDropPayload('{"ids":["x"]}')).toEqual({ ids: ['x'] });
		expect(parseExplorerDropPayload('{"driverId":"  ","ids":["x"]}')).toEqual({
			ids: ['x']
		});
	});

	it('falls back to comma-separated ids', () => {
		expect(parseExplorerDropPayload(' a, b , ,c ')).toEqual({ ids: ['a', 'b', 'c'] });
		expect(parseExplorerDropPayload('')).toEqual({ ids: [] });
	});

	it('falls back to csv when JSON is invalid', () => {
		expect(parseExplorerDropPayload('{not-json')).toEqual({ ids: ['{not-json'] });
	});

	it('does not treat a JSON object without an ids array as csv', () => {
		expect(parseExplorerDropPayload('{"driverId":"memory"}')).toEqual({
			driverId: 'memory',
			ids: []
		});
	});
});
