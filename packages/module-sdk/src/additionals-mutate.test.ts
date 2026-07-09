import { describe, expect, it } from 'vitest';
import { applyAdditionalsMutation, mergeAdditionalsLocal, stampAdditionalUpdatedAt } from './additionals-mutate.ts';
import type { AdditionalWithId } from './types.ts';

const entry = (id: string, extra: Record<string, unknown> = {}): AdditionalWithId =>
  ({ id, type: 'pg', prog_type: { ch: 'f' }, ...extra }) as unknown as AdditionalWithId;

describe('mergeAdditionalsLocal', () => {
  it('upserts in place (order preserved), appends unknown ids, removals win', () => {
    const current = [entry('a'), entry('b')];
    const next = mergeAdditionalsLocal(current, [entry('b', { prog_type: { ch: 't' } }), entry('c')], ['a']);
    expect(next.map((e) => e.id)).toEqual(['b', 'c']);
    expect((next[0] as any).prog_type.ch).toBe('t');
  });

  it('a removal beats an upsert of the same id in one mutation', () => {
    const next = mergeAdditionalsLocal([entry('a')], [entry('a', { prog_type: { ch: 't' } })], ['a']);
    expect(next).toEqual([]);
  });
});

describe('applyAdditionalsMutation', () => {
  it('stamps client-clock updated_at on upserts and emits a merge-shaped payload', () => {
    const now = new Date('2026-07-08T10:00:00.000Z');
    const newId = crypto.randomUUID();
    const { nextAdditionals, opPayload } = applyAdditionalsMutation(
      { additionals: [entry('keep'), entry('gone')] },
      { upserts: [entry(newId)], removedIds: ['gone'] },
      now
    );
    expect(nextAdditionals.map((e) => e.id)).toEqual(['keep', newId]);
    expect(opPayload.removed_additional_ids).toEqual(['gone']);
    expect(opPayload.additionals).toHaveLength(1);
    expect((opPayload.additionals?.[0] as any).updated_at).toBe(now.toISOString());
    // Untouched siblings never travel — the wire format is upserts-only.
    expect(opPayload.additionals?.some((e) => e.id === 'keep')).toBe(false);
  });

  it('rejects envelope-invalid upserts before they can wedge the queue', () => {
    expect(() =>
      applyAdditionalsMutation({ additionals: [] }, { upserts: [entry('not-a-uuid')] })
    ).toThrow(/invalid_additional_id/);
  });

  it('omits empty payload fields (a no-op mutation queues nothing extra)', () => {
    const { opPayload } = applyAdditionalsMutation({ additionals: [entry('a')] }, {});
    expect(opPayload).toEqual({});
  });

  it('refuses server-computed entries outright', () => {
    expect(() =>
      applyAdditionalsMutation({ additionals: [] }, { upserts: [entry(crypto.randomUUID(), { computed: true })] })
    ).toThrow(/server-computed/);
  });
});

describe('stampAdditionalUpdatedAt', () => {
  it('preserves an existing stamp (unchanged entries keep their LWW position)', () => {
    const stamped = entry('a', { updated_at: '2026-01-01T00:00:00.000Z' });
    expect((stampAdditionalUpdatedAt(stamped) as any).updated_at).toBe('2026-01-01T00:00:00.000Z');
  });
});
