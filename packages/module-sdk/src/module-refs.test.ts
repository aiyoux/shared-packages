import { describe, expect, it } from 'vitest';
import { readRef, readRefList, setRef, deleteRef, refsObject } from './module-refs.ts';

describe('module-refs accessors', () => {
  it('reads single and list refs, ignoring empties', () => {
    const ns = { refs: { account_id: 'records:a', source_record_ids: ['records:x', 'records:y'] } };
    expect(readRef(ns, 'account_id')).toBe('records:a');
    expect(readRef(ns, 'missing')).toBeNull();
    expect(readRefList(ns, 'source_record_ids')).toEqual(['records:x', 'records:y']);
    expect(readRefList(ns, 'missing')).toEqual([]);
    expect(readRef({}, 'account_id')).toBeNull();
  });

  it('setRef creates the refs object and removes it when empty', () => {
    const created = setRef({ status: 'active' }, 'list_id', 'records:l');
    expect(created).toEqual({ status: 'active', refs: { list_id: 'records:l' } });
    // setting to empty drops the key and the now-empty refs object
    const cleared = deleteRef(created, 'list_id');
    expect(cleared).toEqual({ status: 'active' });
    expect('refs' in cleared).toBe(false);
  });

  it('setRef treats null/empty-string/empty-array as removal', () => {
    expect(setRef({ refs: { a: 'x' } }, 'a', null)).toEqual({});
    expect(setRef({ refs: { a: 'x' } }, 'a', '')).toEqual({});
    expect(setRef({ refs: { a: 'x' } }, 'a', [])).toEqual({});
  });

  it('refsObject builds a {refs} fragment, dropping empties, or {} when none', () => {
    expect(refsObject({ a: 'records:1', b: null, c: [], d: ['records:2'] }))
      .toEqual({ refs: { a: 'records:1', d: ['records:2'] } });
    expect(refsObject({ a: null, b: '' })).toEqual({});
  });
});
