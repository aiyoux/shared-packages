// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEraseDelta, rebuildFromEraseDelta } from '../src/eraseDelta.ts';
import { splitPathsByEraser } from '../src/eraser.ts';

// The erase undo entry is a POSITIONAL DIFF of only the touched paths. Its whole
// job is to reconstruct the other side of the change exactly — including z-order,
// which is array order — so these tests reconstruct in both directions and
// compare against the real arrays.

const p = (id, d) => ({ id, d, fill: '#000', layerId: 'default' });

test('delta round-trips a synthetic split in both directions', () => {
    const before = [p('a', 'A'), p('b', 'B'), p('c', 'C')];
    // 'b' is replaced by two pieces; 'a' and 'c' carry through by identity.
    const b1 = p('b1', 'B1'), b2 = p('b2', 'B2');
    const after = [before[0], b1, b2, before[2]];
    const sync = { removed: [before[1]], added: [b1, b2] };

    const delta = buildEraseDelta(before, after, sync);
    assert.ok(delta, 'delta should be derivable');
    assert.equal(delta.beforeLen, 3);
    assert.equal(delta.afterLen, 4);
    assert.deepEqual(delta.removed.map(r => r.i), [1]);
    assert.deepEqual(delta.added.map(a => a.i), [1, 2]);

    // after -> before (undo)
    const undone = rebuildFromEraseDelta(after, delta.beforeLen, delta.added, delta.removed);
    assert.deepEqual(undone, before);
    // before -> after (redo)
    const redone = rebuildFromEraseDelta(before, delta.afterLen, delta.removed, delta.added);
    assert.deepEqual(redone, after);
});

test('delta preserves z-order when a path is fully erased', () => {
    const before = [p('a', 'A'), p('b', 'B'), p('c', 'C')];
    const after = [before[0], before[2]]; // 'b' erased entirely, no pieces
    const sync = { removed: [before[1]], added: [] };
    const delta = buildEraseDelta(before, after, sync);
    assert.ok(delta);
    assert.deepEqual(rebuildFromEraseDelta(after, delta.beforeLen, delta.added, delta.removed), before);
    assert.deepEqual(rebuildFromEraseDelta(before, delta.afterLen, delta.removed, delta.added), after);
});

test('delta keys off identity, not id (translate-strip emits a new object with the SAME id)', () => {
    const original = p('same', 'ORIG');
    // This mirrors the real `{...path, transform: undefined}` case in the eraser:
    // a different object carrying an identical id.
    const stripped = { ...original, transform: undefined };
    const before = [original];
    const after = [stripped];
    const delta = buildEraseDelta(before, after, { removed: [original], added: [stripped] });
    assert.ok(delta, 'identity-keyed diff must see this as a real change');
    assert.deepEqual(delta.removed.map(r => r.i), [0]);
    assert.deepEqual(delta.added.map(a => a.i), [0]);
    // An id-keyed diff would have produced an empty delta and lost the edit.
    const undone = rebuildFromEraseDelta(after, delta.beforeLen, delta.added, delta.removed);
    assert.equal(undone[0], original);
});

test('delta refuses to build when the arrays do not line up', () => {
    const before = [p('a', 'A')];
    const after = [p('x', 'X')];
    // `removed` names a path that is not in `before` — unbuildable, must bail so
    // the caller stores the whole-array entry instead of a wrong diff.
    assert.equal(buildEraseDelta(before, after, { removed: [p('ghost', 'G')], added: [after[0]] }), null);
});

test('rebuild refuses a diff that does not fit the array', () => {
    const cur = [p('a', 'A'), p('b', 'B')];
    // Target length too small for the surviving entries.
    assert.equal(rebuildFromEraseDelta(cur, 1, [], []), null);
    // Two inserts colliding on one index.
    assert.equal(rebuildFromEraseDelta(cur, 4, [], [{ i: 0, p: cur[0] }, { i: 0, p: cur[1] }]), null);
});

test('delta round-trips a REAL erase pass exactly', () => {
    // Drive the actual eraser so the diff is tested against genuine output
    // (many pieces, mixed carry-throughs), not a hand-built fixture.
    const before = [
        p('h', 'M 20 100 L 300 100 L 300 130 L 20 130 Z'),
        p('v', 'M 50 40 L 70 40 L 70 260 L 50 260 Z'),
        p('far', 'M 500 500 L 560 500 L 560 520 L 500 520 Z')
    ];
    const trail = [];
    for (let i = 0; i <= 40; i++) trail.push({ x: 40 + i * 5, y: 90 + Math.sin(i / 5) * 40 });

    const sync = { removed: [], added: [] };
    const after = splitPathsByEraser(before, trail, 16, () => false, { sync });
    assert.ok(sync.removed.length > 0, 'the fixture must actually erase something');
    assert.notEqual(after.length, 0);

    const delta = buildEraseDelta(before, after, sync);
    assert.ok(delta, 'delta should be derivable from a real pass');

    const undone = rebuildFromEraseDelta(after, delta.beforeLen, delta.added, delta.removed);
    assert.ok(undone, 'undo rebuild should succeed');
    assert.equal(undone.length, before.length);
    for (let i = 0; i < before.length; i++) {
        assert.equal(undone[i], before[i], `undo mismatch at ${i} (z-order or content changed)`);
    }

    const redone = rebuildFromEraseDelta(before, delta.afterLen, delta.removed, delta.added);
    assert.ok(redone, 'redo rebuild should succeed');
    assert.equal(redone.length, after.length);
    for (let i = 0; i < after.length; i++) {
        assert.equal(redone[i], after[i], `redo mismatch at ${i}`);
    }

    // The point of the exercise: the diff stores ONLY touched paths. The distant
    // rectangle the eraser never reached must not appear on either side — that
    // is what makes the entry scale with the edit instead of with the drawing.
    //
    // NOTE this does NOT imply the diff is always smaller than the array it
    // replaces: an erase that shatters its targets emits more piece data than
    // the originals held. The win comes from untouched paths being excluded, so
    // it grows with how much of the scene an erase actually touches.
    const far = before[2];
    assert.ok(!delta.removed.some(r => r.p === far), 'untouched path leaked into the diff');
    assert.ok(!delta.added.some(a => a.p === far), 'untouched path leaked into the diff');
    assert.ok(after.includes(far), 'the untouched path should still be carried through by identity');
});
