// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { splitPathsByEraser } from '../src/eraser.ts';

// A filled rectangle (closed-filled branch, same code path freehand outlines use).
const rect = (x, y, w, h) => ({
    d: `M ${x} ${y} L ${x + w} ${y} L ${x + w} ${y + h} L ${x} ${y + h} Z`,
    fill: '#000', stroke: 'none', strokeWidth: 1
});

test('a fully-covered stroke is dropped (legitimate full-erase)', () => {
    const paths = [rect(0, 0, 20, 20)];
    // A big capsule fully covering the rect.
    const next = splitPathsByEraser(paths, [{ x: 10, y: -40 }, { x: 10, y: 60 }], 30, () => false);
    assert.equal(next.length, 0, `fully-covered stroke should be dropped, got ${next.length}`);
});

test('a partially-touched stroke is kept (not silently lost)', () => {
    const paths = [rect(0, 0, 100, 40)];
    // A small eraser biting a corner — most of the rect survives.
    const next = splitPathsByEraser(paths, [{ x: 80, y: -20 }, { x: 80, y: 60 }], 8, () => false);
    assert.ok(next.length >= 1, `partial touch should keep the stroke (notched piece), got ${next.length}`);
});

test('a non-overlapping eraser leaves the stroke unchanged', () => {
    const paths = [rect(0, 0, 100, 40)];
    // Eraser far from the rect — mayIntersect is false, so the path is carried through.
    const next = splitPathsByEraser(paths, [{ x: 500, y: 500 }, { x: 510, y: 510 }], 8, () => false);
    assert.equal(next.length, 1, `non-overlapping eraser should keep the stroke, got ${next.length}`);
    assert.equal(next[0].d, paths[0].d, 'unchanged stroke should pass through verbatim');
});
