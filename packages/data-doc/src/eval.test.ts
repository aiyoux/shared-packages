import { describe, expect, it } from 'vitest';
import { applyDataOp } from './ops.js';
import { emptyDataDocument, parseDataDocument, serializeDataDocument } from './document.js';
import { evaluateView, viewOutputShape } from './eval.js';
import type { DataDocument } from './types.js';

function doc(): DataDocument {
	return {
		schemaVersion: 1,
		id: 'doc',
		createdAt: 1,
		fields: [
			{ id: 'name', name: 'Name', type: 'string' },
			{ id: 'when', name: 'When', type: 'date' },
			{ id: 'n', name: 'Count', type: 'int' }
		],
		records: [
			{ id: 'a', values: { name: 'Ada', when: '2026-01-02', n: 1 } },
			{ id: 'b', values: { name: 'Bea', when: '2026-03-15', n: 4 } },
			{ id: 'c', values: { name: 'Ada', when: '2026-06-01', n: 2 } }
		],
		views: [
			{
				id: 'v',
				name: 'Ada in spring',
				selectFieldId: 'when',
				where: [
					{ fieldId: 'name', op: 'eq', value: 'Ada' },
					{ fieldId: 'when', op: 'gte', value: '2026-03-01' },
					{ fieldId: 'when', op: 'lte', value: '2026-06-30' }
				]
			}
		]
	};
}

describe('data document', () => {
	it('round-trips and mints identity on an empty file', () => {
		const empty = emptyDataDocument();
		expect(empty.id).toBeTruthy();
		expect(empty.fields).toHaveLength(1);
		expect(parseDataDocument(serializeDataDocument(empty))).toEqual(empty);
	});

	it('filters a date window and returns the selected field', () => {
		const result = evaluateView(doc(), 'v');
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.rows.map((r) => r.value)).toEqual(['2026-06-01']);
	});

	it('contains matches text without regard to case', () => {
		const withView = applyDataOp(doc(), {
			t: 'put-view',
			view: {
				id: 'c',
				name: 'ad',
				selectFieldId: 'name',
				where: [{ fieldId: 'name', op: 'contains', value: 'AD' }]
			}
		});
		const result = evaluateView(withView, 'c');
		if (!result.ok) throw new Error(result.message);
		expect(result.rows.map((r) => r.recordId)).toEqual(['a', 'c']);
	});

	it('declares an array of strings unless the view asks for one value', () => {
		const base = doc();
		expect(viewOutputShape(base, 'v')).toEqual({ scalar: 'string', many: true });
		const one = applyDataOp(base, {
			t: 'put-view',
			view: { ...base.views[0]!, cardinality: 'one' }
		});
		expect(viewOutputShape(one, 'v')).toEqual({ scalar: 'string', many: false });
	});

	it('drops a field from records and view clauses', () => {
		const next = applyDataOp(doc(), { t: 'remove-field', fieldId: 'when' });
		expect(next.fields.map((f) => f.id)).toEqual(['name', 'n']);
		expect(next.records[0]?.values.when).toBeUndefined();
		expect(next.views[0]?.where.map((c) => c.fieldId)).toEqual(['name']);
	});

	it('set-cell is idempotent and refuses a bad date', () => {
		const base = doc();
		const once = applyDataOp(base, { t: 'set-cell', recordId: 'a', fieldId: 'n', value: 9 });
		const twice = applyDataOp(once, { t: 'set-cell', recordId: 'a', fieldId: 'n', value: 9 });
		expect(twice).toBe(once);
		expect(once.records[0]?.values.n).toBe(9);
		const bad = applyDataOp(base, { t: 'set-cell', recordId: 'a', fieldId: 'when', value: 'March' });
		expect(bad).toBe(base);
	});
});
