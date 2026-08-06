// @ts-nocheck

import test from 'node:test';
import assert from 'node:assert/strict';

import { freehandSourceToPath, splitPathsByEraser, buildEraserCtx, splitOnePathByEraser } from '../src/eraser.ts';
import { PathBboxGrid } from '../src/raster.ts';

const linePath = (d) => ({
    d,
    stroke: '#000',
    fill: 'none',
    strokeWidth: 2
});

const pathNumbers = (d) => [...d.matchAll(/-?\d+(?:\.\d+)?/g)].map(match => Number(match[0]));

const pathMinMaxX = (d) => {
    const nums = pathNumbers(d);
    const xs = nums.filter((_, index) => index % 2 === 0);
    return { min: Math.min(...xs), max: Math.max(...xs) };
};

const pathOuterArea = (d) => {
    const nums = pathNumbers(d);
    const points = [];
    for (let i = 0; i + 1 < nums.length; i += 2) {
        points.push([nums[i], nums[i + 1]]);
    }

    let area = 0;
    for (let i = 0; i < points.length; i++) {
        const [x1, y1] = points[i];
        const [x2, y2] = points[(i + 1) % points.length];
        area += x1 * y2 - x2 * y1;
    }
    return Math.abs(area / 2);
};

test('split eraser removes a section from a long line when only the eraser stroke crosses it', () => {
    const paths = [linePath('M 0 0 L 100 0')];
    const result = splitPathsByEraser(paths, [
        { x: 50, y: 10 },
        { x: 50, y: -10 }
    ], 5);

    assert.equal(result.length, 2);
    assert.match(result[0].d, /^M 0(\.0+)? 0(\.0+)? L /);
    assert.match(result[1].d, /^M 5[6-9](\.\d+)? 0(\.0+)? L /);
});

test('split eraser keeps both sides when erasing through the middle of a long stroke', () => {
    const paths = [linePath('M 0 0 L 200 0')];
    const result = splitPathsByEraser(paths, [
        { x: 100, y: -20 },
        { x: 100, y: 20 }
    ], 10);

    assert.equal(result.length, 2);
    assert.equal(pathMinMaxX(result[0].d).min, 0);
    assert.equal(pathMinMaxX(result[1].d).max, 200);
});

test('split eraser uses the full eraser radius, not only centerline overlap', () => {
    const paths = [linePath('M 0 0 L 100 0')];
    const result = splitPathsByEraser(paths, [
        { x: 50, y: 5 }
    ], 5);

    assert.equal(result.length, 2);
});

test('split eraser does not delete a short remaining open stroke just because cap padding reaches both ends', () => {
    const paths = [{
        ...linePath('M 0 0 L 10 0'),
        strokeWidth: 2
    }];
    const result = splitPathsByEraser(paths, [
        { x: 8, y: 0 }
    ], 6);

    assert.equal(result.length, 1);
    assert.equal(pathMinMaxX(result[0].d).min, 0);
    assert.ok(pathMinMaxX(result[0].d).max > 0);
});

test('split eraser leaves a short open stroke alone until the eraser reaches its centerline', () => {
    // The cut threshold is the eraser radius measured to the CENTERLINE: at that
    // distance the eraser has taken half the stroke's visible thickness, so
    // cutting is the closest a centerline can get to what the preview shows.
    // Beyond it the eraser is only shaving the flank and the ink stays.
    const paths = [{
        ...linePath('M 0 0 L 10 0'),
        strokeWidth: 2
    }];

    assert.deepEqual(
        splitPathsByEraser(paths, [{ x: 5, y: 6.5 }], 6),
        paths,
        'the eraser has not reached the centerline yet'
    );
    // Touching the centerline: the eraser reaches it at a single point, so the
    // stroke is cut there and both ends survive.
    const atTheCenterline = splitPathsByEraser(paths, [{ x: 5, y: 6 }], 6);
    assert.equal(atTheCenterline.length, 2);
    assert.equal(pathMinMaxX(atTheCenterline[0].d).min, 0);
    assert.equal(pathMinMaxX(atTheCenterline[1].d).max, 10);
});

test('split eraser leaves no stub behind when it engulfs a short stroke', () => {
    // The live drag preview drops everything under the eraser, so anything the
    // committed pass leaves behind inside it reads as ink popping back on
    // release. This used to keep a fragment at one end: the segment was fully
    // covered, so a second "trim at the full-thickness radius" rule re-cut it a
    // strokeRadius short of the first rule's cut and stranded the difference.
    const paths = [{
        ...linePath('M 0 0 L 10 0'),
        strokeWidth: 2
    }];

    for (const radius of [5, 6, 8, 12]) {
        assert.deepEqual(
            splitPathsByEraser(paths, [{ x: 5, y: 0 }], radius),
            [],
            `radius ${radius} left a stub of an engulfed stroke behind`
        );
    }
});

test('split eraser deletes a segment lying entirely inside the eraser', () => {
    // radius 6 - strokeRadius 1 = 5 covers the full 10-long segment end to end:
    // the whole thing is under the eraser, so none of it may survive. Keeping a
    // stub here is what made already-wiped fragments reappear when the drag
    // ended, since the live preview drops everything the eraser passes over.
    const paths = [{
        ...linePath('M 0 0 L 10 0'),
        strokeWidth: 2
    }];
    const result = splitPathsByEraser(paths, [
        { x: 5, y: 0 }
    ], 6);

    assert.equal(result.length, 0, 'a fully-engulfed segment is erased outright');
});

test('split eraser does not miss radius-edge hits between sample positions', () => {
    // The eraser lands exactly ON the cut radius (6 from the centerline) and
    // between the polyline's own sample positions. A hit at the very edge of the
    // threshold still has to register.
    const paths = [{
        ...linePath('M 0 0 L 103 0'),
        strokeWidth: 3
    }];
    const result = splitPathsByEraser(paths, [
        { x: 50, y: 6 }
    ], 6);

    assert.equal(result.length, 2);
    assert.notEqual(result[0].d, paths[0].d);
});

test('split eraser leaves a line alone when the pass only clips its outer flank', () => {
    // The reported "little holes in basic lines" bug. The eraser (radius 6) runs
    // past a 3-wide line at 7.5 from its centerline: it reaches the ink's outer
    // edge (7.5 - 1.5 = 6) and takes away nothing at all — the live preview,
    // which subtracts the eraser from the rendered pixels, shows the line
    // untouched. The committed pass used to sever it there, punching holes
    // through lines the eraser had never visibly touched.
    const paths = [{
        ...linePath('M 0 0 L 103 0'),
        strokeWidth: 3
    }];
    const result = splitPathsByEraser(paths, [
        { x: 50, y: 7.5 }
    ], 6);

    assert.deepEqual(result, paths, 'a flank graze must not cut the line');
});

test('split eraser does not delete a whole run of line that a drag merely passes alongside', () => {
    // The same bug at drag scale, and the shape of the actual report: a long
    // eraser drag running PARALLEL to a line, close enough to graze its flank but
    // never covering it. `preserveThinRemnant` decided each grazed segment
    // survives — and the fallback arm then threw every one of those vertices away
    // for sitting inside the eraser radius, deleting hundreds of px of line.
    const line = {
        ...linePath('M ' + Array.from({ length: 101 }, (_, i) => `${i * 4} 0`).join(' L ')),
        strokeWidth: 4
    };
    const radius = 20;
    // y = 22 = radius + strokeRadius: tangent to the ink's outer edge, so not a
    // single pixel of the line is inside the eraser.
    const trail = Array.from({ length: 60 }, (_, i) => ({ x: 40 + i * 5, y: 22 }));

    const result = splitPathsByEraser([line], trail, radius);

    assert.deepEqual(result, [line], 'the drag never touched the ink, so the line must be untouched');
});

test('split eraser cuts a line the drag actually runs over', () => {
    // The counterpart to the graze tests: the same parallel drag, but ON the
    // line, must still remove it. (A "keep everything" regression would pass the
    // graze tests and break erasing entirely.)
    const line = {
        ...linePath('M ' + Array.from({ length: 101 }, (_, i) => `${i * 4} 0`).join(' L ')),
        strokeWidth: 4
    };
    const trail = Array.from({ length: 60 }, (_, i) => ({ x: 40 + i * 5, y: 0 }));

    const result = splitPathsByEraser([line], trail, 20);

    const survivingX = result.flatMap(p => {
        const { min, max } = pathMinMaxX(p.d);
        return [min, max];
    });
    assert.ok(result.length > 0, 'the untouched ends survive');
    assert.equal(
        survivingX.some(x => x > 20 && x < 355),
        false,
        `ink survived under the drag: ${result.map(p => p.d).join(' | ')}`
    );
});

test('split eraser includes H and V segment geometry in hit testing bounds', () => {
    const paths = [linePath('M 0 0 H 100')];
    const result = splitPathsByEraser(paths, [
        { x: 50, y: 10 },
        { x: 50, y: -10 }
    ], 5);

    assert.equal(result.length, 2);
});

test('split eraser handles a swept eraser segment between pointer samples', () => {
    const paths = [linePath('M 0 0 L 100 0')];
    const result = splitPathsByEraser(paths, [
        { x: 30, y: 20 },
        { x: 70, y: -20 }
    ], 5);

    assert.equal(result.length, 2);
});

test('split eraser keeps locked layer paths unchanged', () => {
    const paths = [{ ...linePath('M 0 0 L 100 0'), layerId: 'locked' }];
    const result = splitPathsByEraser(paths, [
        { x: 50, y: 10 },
        { x: 50, y: -10 }
    ], 5, layerId => layerId === 'locked');

    assert.deepEqual(result, paths);
});

test('split eraser applies baked path translate before hit testing open edges', () => {
    const paths = [{
        ...linePath('M -50 0 L 50 0'),
        transform: 'translate(100, 25)',
        bakeGroupId: 'bake-1'
    }];
    const result = splitPathsByEraser(paths, [
        { x: 100, y: 15 },
        { x: 100, y: 35 }
    ], 5);

    assert.equal(result.length, 2);
    assert.equal(result.every(path => path.transform === undefined), true);
    assert.equal(pathMinMaxX(result[0].d).min, 50);
    assert.equal(pathMinMaxX(result[1].d).max, 150);
});

test('split eraser destroys geometry in closed filled outline paths', () => {
    const paths = [{
        d: 'M 0 0 L 100 0 L 100 10 L 0 10 Z',
        stroke: 'none',
        fill: '#000',
        strokeWidth: 0
    }];
    const result = splitPathsByEraser(paths, [
        { x: 50, y: -10 },
        { x: 50, y: 20 }
    ], 8);

    assert.notDeepEqual(result, paths);
    assert.equal(result.length, 2);
    assert.equal(result.some(path => /\b50(\.0+)? 0(\.0+)?\b/.test(path.d)), false);
    assert.equal(result.every(path => !path.fillRule), true);
});

test('split eraser applies baked path translate before clipping filled faces', () => {
    const paths = [{
        d: 'M -50 -10 L 50 -10 L 50 10 L -50 10 Z',
        stroke: 'none',
        fill: '#000',
        strokeWidth: 0,
        transform: 'translate(100, 100)',
        bakeGroupId: 'bake-1'
    }];
    const result = splitPathsByEraser(paths, [
        { x: 100, y: 80 },
        { x: 100, y: 120 }
    ], 8);

    assert.equal(result.length, 2);
    assert.equal(result.every(path => path.transform === undefined), true);
    assert.equal(result.every(path => path.fill === '#000'), true);
    assert.equal(result.some(path => /\b50(\.0+)? 90(\.0+)?\b/.test(path.d)), true);
});

test('split eraser treats same-winding baked face subpaths as separate filled polygons', () => {
    const paths = [{
        d: 'M 0 0 L 20 0 L 20 20 L 0 20 z M 40 0 L 60 0 L 60 20 L 40 20 z',
        stroke: 'none',
        fill: '#000',
        strokeWidth: 0,
        bakeGroupId: 'bake-1'
    }];
    const result = splitPathsByEraser(paths, [
        { x: 50, y: -10 },
        { x: 50, y: 30 }
    ], 5);

    assert.equal(result.length, 3);
    assert.equal(result.every(path => path.fill === '#000'), true);
    assert.equal(result.some(path => /\b0(\.0+)? 0(\.0+)?\b/.test(path.d)), true);
    assert.equal(result.some(path => /\b40(\.0+)? 0(\.0+)?\b/.test(path.d)), true);
    assert.equal(result.some(path => /\b60(\.0+)? 0(\.0+)?\b/.test(path.d)), true);
});

test('split eraser preserves untouched translated baked paths', () => {
    const paths = [{
        ...linePath('M -50 0 L 50 0'),
        transform: 'translate(100, 25)',
        bakeGroupId: 'bake-1'
    }];
    const result = splitPathsByEraser(paths, [
        { x: 400, y: 400 }
    ], 5);

    assert.deepEqual(result, paths);
});

test('split eraser keeps small filled end-cap remnants until they are actually erased', () => {
    const paths = [{
        d: 'M 0 0 L 100 0 L 100 12 L 0 12 Z',
        stroke: 'none',
        fill: '#000',
        strokeWidth: 0
    }];
    const result = splitPathsByEraser(paths, [
        { x: 88, y: 6 }
    ], 12);

    assert.ok(result.length > 1);
    assert.equal(result.some(path => path.d.includes('100.0')), true);
});

test('split eraser does not crash on long swept eraser paths over filled outlines', () => {
    const paths = [{
        d: 'M 250 250 L 1100 250 L 1100 620 L 250 620 Z',
        stroke: 'none',
        fill: '#000',
        strokeWidth: 0
    }];
    const eraserPoints = Array.from({ length: 60 }, (_, i) => ({
        x: 300 + i * 12,
        y: 500 + Math.sin(i / 3) * 60
    }));
    const result = splitPathsByEraser(paths, eraserPoints, 28);

    assert.ok(result.length > 0);
    assert.equal(result.every(path => path.fill === '#000'), true);
});

test('split eraser cleans tiny filled remnants from a fast sparse pass', () => {
    const paths = Array.from({ length: 20 }, (_, i) => ({
        d: `M ${i * 10} 0 L ${i * 10 + 8} 0 L ${i * 10 + 8} 8 L ${i * 10} 8 Z`,
        stroke: 'none',
        fill: '#000',
        strokeWidth: 0
    }));
    const result = splitPathsByEraser(paths, [
        { x: -20, y: -6 },
        { x: 220, y: 14 }
    ], 8);

    assert.ok(result.length > 0);
    assert.equal(result.every(path => path.fill === '#000'), true);
    assert.equal(result.every(path => pathOuterArea(path.d) > 8 * 8 * 0.08), true);
});

test('split eraser preserves holes in clipped filled outline paths with nonzero winding', () => {
    const paths = [{
        d: 'M 0 0 L 120 0 L 120 80 L 0 80 Z',
        stroke: 'none',
        fill: '#000',
        strokeWidth: 0
    }];
    const result = splitPathsByEraser(paths, [
        { x: 60, y: 40 }
    ], 12);

    assert.equal(result.length, 1);
    assert.equal(result[0].fillRule, undefined);
    assert.ok((result[0].d.match(/ Z/g) || []).length >= 2);
});

test('split eraser does not turn existing smooth-stroke overlap contours into holes', () => {
    const paths = [{
        d: 'M 0 0 L 100 0 L 100 30 L 0 30 Z M 40 8 L 60 8 L 60 22 L 40 22 Z',
        stroke: 'none',
        fill: '#000',
        strokeWidth: 0
    }];
    const result = splitPathsByEraser(paths, [
        { x: 100, y: 15 }
    ], 8);

    assert.equal(result.length, 1);
    assert.equal(result[0].fillRule, undefined);
    assert.equal(result[0].d.includes('40.0 8.0'), false);
});

test('split eraser preserves previous erased gaps when erasing another part of the same filled stroke', () => {
    const paths = [{
        d: 'M 0 0 L 100 0 L 100 30 L 0 30 Z M 40 8 L 40 22 L 60 22 L 60 8 Z',
        stroke: 'none',
        fill: '#000',
        strokeWidth: 0
    }];
    const result = splitPathsByEraser(paths, [
        { x: 100, y: 15 }
    ], 8);

    assert.equal(result.length, 1);
    assert.equal(result[0].fillRule, undefined);
    assert.equal(/\b40(\.0+)? 8(\.0+)?\b/.test(result[0].d), true);
});

test('split eraser does not break a thick valid filled stroke when the eraser only touches one side', () => {
    const paths = [{
        d: 'M 0 0 L 120 0 L 120 40 L 0 40 Z',
        stroke: 'none',
        fill: '#000',
        strokeWidth: 0
    }];
    const result = splitPathsByEraser(paths, [
        { x: 120, y: 20 }
    ], 8);

    assert.equal(result.length, 1);
    assert.equal(result[0].fill, '#000');
    assert.equal(result[0].fillRule, undefined);
});

test('split eraser keeps clipped filled outlines filled instead of converting them to boundary lines', () => {
    const paths = [{
        d: 'M 0 0 L 100 40 L 0 40 L 100 0 Z',
        stroke: 'none',
        fill: '#000',
        strokeWidth: 0
    }];
    const result = splitPathsByEraser(paths, [
        { x: 50, y: 20 }
    ], 12);

    assert.ok(result.length > 0);
    assert.equal(result.every(path => path.fill === '#000'), true);
    assert.equal(result.every(path => !path.fillRule), true);
});

test('split eraser clips flattened smooth source strokes without reshaping untouched outline', () => {
    const source = {
        points: [
            [0, 0, 0.5],
            [100, 40, 0.5],
            [0, 40, 0.5],
            [100, 0, 0.5]
        ],
        options: {
            size: 12,
            thinning: 0.6,
            smoothing: 0.5,
            streamline: 0.5
        }
    };
    const paths = [{
        d: freehandSourceToPath(source),
        stroke: 'none',
        fill: '#000',
        strokeWidth: 0,
        freehandSource: source
    }];
    const result = splitPathsByEraser(paths, [
        { x: 50, y: 20 }
    ], 8);

    assert.ok(result.length > 0);
    assert.equal(result.every(path => path.fill === '#000'), true);
    assert.equal(result.every(path => !path.fillRule), true);
    // Clip bakes the freehand stroke into plain filled outline pieces — the
    // centerline freehandSource is dropped (pieces are no longer node-editable).
    assert.equal(result.every(path => path.freehandSource === undefined), true);
    assert.equal(result.every(path => path.d.startsWith('M ')), true);
});

test('freehand source path builder flattens self-overlapping smooth outlines before erasing', () => {
    const source = {
        points: [
            [0, 0, 0.5],
            [100, 40, 0.5],
            [0, 40, 0.5],
            [100, 0, 0.5]
        ],
        options: {
            size: 12,
            thinning: 0.6,
            smoothing: 0.5,
            streamline: 0.5
        }
    };
    const d = freehandSourceToPath(source);

    assert.match(d, /^M /);
    assert.equal(d.includes(' Z'), true);
    assert.equal(d.includes('50.0 20.0'), false);
});

test('freehand source path builder is used as the canonical smooth stroke geometry', () => {
    const source = {
        points: [
            [0, 0, 0.5],
            [20, 0, 0.5],
            [40, 10, 0.5]
        ],
        options: {
            size: 10,
            thinning: 0.6,
            smoothing: 0.5,
            streamline: 0.5
        }
    };
    const d = freehandSourceToPath(source);

    assert.match(d, /^M /);
    assert.equal(d.includes(' Z'), true);
});

test('smooth strokes remain filled ink outlines after split erasing', () => {
    const paths = [{
        d: 'M 0 0 L 100 0 L 100 12 L 0 12 Z',
        stroke: 'none',
        fill: '#000',
        strokeWidth: 0
    }];
    const result = splitPathsByEraser(paths, [
        { x: 50, y: -10 },
        { x: 50, y: 22 }
    ], 8);

    assert.equal(result.length, 2);
    assert.equal(result.every(path => path.stroke === 'none'), true);
    assert.equal(result.every(path => path.fill === '#000'), true);
    assert.equal(result.every(path => !path.fillRule), true);
});

test('split eraser preserves pencil material props when splitting centerline paths', () => {
    const paths = [{
        ...linePath('M 0 0 L 100 0'),
        stroke: '#333333',
        strokeWidth: 4,
        opacity: 0.34,
        blendMode: 'multiply',
        layerId: 'sketch'
    }];

    const result = splitPathsByEraser(paths, [
        { x: 50, y: -12 },
        { x: 50, y: 12 }
    ], 5);

    assert.equal(result.length, 2);
    assert.equal(result.every(path => path.stroke === '#333333'), true);
    assert.equal(result.every(path => path.fill === 'none'), true);
    assert.equal(result.every(path => path.strokeWidth === 4), true);
    assert.equal(result.every(path => path.opacity === 0.34), true);
    assert.equal(result.every(path => path.blendMode === 'multiply'), true);
    assert.equal(result.every(path => path.layerId === 'sketch'), true);
});

test('split eraser preserves highlighter material props when splitting centerline paths', () => {
    const paths = [{
        ...linePath('M 0 0 L 100 0'),
        stroke: '#ffff00',
        strokeWidth: 20,
        opacity: 0.35,
        blendMode: 'multiply'
    }];

    const result = splitPathsByEraser(paths, [
        { x: 50, y: -24 },
        { x: 50, y: 24 }
    ], 5);

    assert.equal(result.length, 2);
    assert.equal(result.every(path => path.stroke === '#ffff00'), true);
    assert.equal(result.every(path => path.strokeWidth === 20), true);
    assert.equal(result.every(path => path.opacity === 0.35), true);
    assert.equal(result.every(path => path.blendMode === 'multiply'), true);
});

test('split eraser accounts for brush stroke width when hit testing highlighter strokes', () => {
    const thinPen = [{
        ...linePath('M 0 0 L 100 0'),
        strokeWidth: 2
    }];
    const wideHighlighter = [{
        ...linePath('M 0 0 L 100 0'),
        strokeWidth: 20,
        opacity: 0.35,
        blendMode: 'multiply'
    }];

    // Far from both centerlines: nothing is cut, whatever the brush width. A
    // small eraser skimming the flank of a fat highlighter must not sever the
    // whole 20-wide band — it only shaves an edge the preview keeps showing.
    const alongTheFlank = [{ x: 50, y: 10 }];
    assert.deepEqual(splitPathsByEraser(thinPen, alongTheFlank, 3), thinPen);
    assert.deepEqual(splitPathsByEraser(wideHighlighter, alongTheFlank, 3), wideHighlighter);

    // Over the centerline: both are cut, and the highlighter's material props
    // ride along onto every piece.
    const overTheLine = [{ x: 50, y: 0 }];
    assert.equal(splitPathsByEraser(thinPen, overTheLine, 3).length, 2);
    const highlighterResult = splitPathsByEraser(wideHighlighter, overTheLine, 3);
    assert.equal(highlighterResult.length, 2);
    assert.equal(highlighterResult.every(path => path.blendMode === 'multiply'), true);
    assert.equal(highlighterResult.every(path => path.opacity === 0.35), true);
});

test('split eraser preserves highlighter material props when clipping filled freehand outlines', () => {
    const source = {
        points: [
            [0, 0, 0.5],
            [100, 0, 0.5],
            [100, 30, 0.5],
            [0, 30, 0.5]
        ],
        options: {
            size: 18,
            thinning: 0,
            smoothing: 0.6,
            streamline: 0.5
        }
    };
    const paths = [{
        d: freehandSourceToPath(source),
        stroke: 'none',
        fill: '#ffff00',
        strokeWidth: 0,
        opacity: 0.35,
        blendMode: 'multiply',
        freehandSource: source
    }];

    const result = splitPathsByEraser(paths, [
        { x: 50, y: -20 },
        { x: 50, y: 50 }
    ], 10);

    assert.ok(result.length > 0);
    assert.equal(result.every(path => path.stroke === 'none'), true);
    assert.equal(result.every(path => path.fill === '#ffff00'), true);
    assert.equal(result.every(path => path.strokeWidth === 0), true);
    assert.equal(result.every(path => path.opacity === 0.35), true);
    assert.equal(result.every(path => path.blendMode === 'multiply'), true);
    // Clip bakes the stroke into a plain filled outline (freehandSource dropped).
    assert.equal(result.every(path => path.freehandSource === undefined), true);
});

test('split eraser keeps all output within the original shape bounds (no stray fills)', () => {
    // A filled square erased through the middle must only ever yield geometry
    // inside the square — guards against polygon-clipping artifacts appearing
    // "in an unrelated place".
    const paths = [{
        d: 'M 0 0 L 100 0 L 100 100 L 0 100 Z',
        stroke: 'none',
        fill: '#000',
        strokeWidth: 0
    }];
    const result = splitPathsByEraser(paths, [
        { x: 30, y: 50 },
        { x: 70, y: 50 }
    ], 12);

    assert.ok(result.length > 0);
    for (const path of result) {
        const nums = pathNumbers(path.d);
        assert.ok(nums.every(Number.isFinite), 'all coordinates finite');
        for (let i = 0; i + 1 < nums.length; i += 2) {
            assert.ok(nums[i] >= -1 && nums[i] <= 101, `x ${nums[i]} within bounds`);
            assert.ok(nums[i + 1] >= -1 && nums[i + 1] <= 101, `y ${nums[i + 1]} within bounds`);
        }
    }
});

// ---- Freehand clip erase --------------------------------------------------

const straightSource = () => ({
    points: Array.from({ length: 21 }, (_, i) => [i * 10, 0, 0.5]), // straight line 0..200
    options: { size: 12, thinning: 0.5, smoothing: 0.5, streamline: 0.5 }
});

const coordsOf = (d) => {
    const nums = pathNumbers(d);
    const pts = [];
    for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i], nums[i + 1]]);
    return pts;
};

const distToEraser = (x, y, eraserPoints) => {
    let minSq = Infinity;
    for (const p of eraserPoints) minSq = Math.min(minSq, (x - p.x) ** 2 + (y - p.y) ** 2);
    for (let i = 1; i < eraserPoints.length; i++) {
        const a = eraserPoints[i - 1], b = eraserPoints[i];
        const l2 = (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
        let t = l2 === 0 ? 0 : ((x - a.x) * (b.x - a.x) + (y - a.y) * (b.y - a.y)) / l2;
        t = Math.max(0, Math.min(1, t));
        minSq = Math.min(minSq, (x - (a.x + t * (b.x - a.x))) ** 2 + (y - (a.y + t * (b.y - a.y))) ** 2);
    }
    return Math.sqrt(minSq);
};

const eraseArgs = (radius = 12) => ([
    { x: 100, y: -20 },
    { x: 100, y: 20 }
]);

test('clip strategy does not reshape untouched outline vertices', () => {
    const source = straightSource();
    const origD = freehandSourceToPath(source);
    const origPts = coordsOf(origD);
    const paths = [{
        d: origD,
        stroke: 'none',
        fill: '#000',
        strokeWidth: 0,
        freehandSource: source
    }];
    const eraser = eraseArgs(12);
    const result = splitPathsByEraser(paths, eraser, 12, () => false);

    // No-reshape guard for clip: every result vertex that is safely outside the
    // eraser must match an original outline vertex (within the 0.1 snap tolerance).
    // Clip rebuilds the subject via `union`, which may drop collinear vertices,
    // so we don't require every original vertex to survive — only that no result
    // vertex is new or moved (which is what "reshape" would look like).
    const origCoords = origPts;
    const farResultPts = [];
    for (const p of result) {
        for (const [x, y] of coordsOf(p.d)) {
            if (distToEraser(x, y, eraser) > 12 + 2) farResultPts.push([x, y]);
        }
    }
    assert.ok(farResultPts.length > 4, `found untouched result vertices (${farResultPts.length})`);
    for (const [x, y] of farResultPts) {
        const near = origCoords.some(([ox, oy]) => Math.abs(ox - x) <= 1 && Math.abs(oy - y) <= 1);
        assert.ok(near, `untouched result vertex ${x},${y} matches an original outline vertex (no reshape)`);
    }
});

test('clip strategy splits a freehand stroke into plain filled pieces with no freehandSource', () => {
    const source = straightSource();
    const paths = [{
        d: freehandSourceToPath(source),
        stroke: 'none',
        fill: '#000',
        strokeWidth: 0,
        freehandSource: source
    }];
    const eraser = eraseArgs(12);
    const result = splitPathsByEraser(paths, eraser, 12, () => false);

    assert.ok(result.length > 0);
    assert.equal(result.every(p => p.fill === '#000'), true);
    assert.equal(result.every(p => p.stroke === 'none'), true);
    assert.equal(result.every(p => p.freehandSource === undefined), true);
});

test('clip strategy keeps all output within the original outline bounds', () => {
    const source = straightSource();
    const origPts = coordsOf(freehandSourceToPath(source));
    const maxX = Math.max(...origPts.map(p => p[0]));
    const minX = Math.min(...origPts.map(p => p[0]));
    const paths = [{
        d: freehandSourceToPath(source),
        stroke: 'none',
        fill: '#000',
        strokeWidth: 0,
        freehandSource: source
    }];
    const result = splitPathsByEraser(paths, eraseArgs(12), 12, () => false);

    assert.ok(result.length > 0);
    for (const p of result) {
        for (const [x, y] of coordsOf(p.d)) {
            assert.ok(Number.isFinite(x) && Number.isFinite(y), 'finite coords');
            assert.ok(x >= minX - 1 && x <= maxX + 1, `x ${x} within bounds`);
        }
    }
});

test('clip strategy leaves a freehand stroke unchanged when the eraser misses', () => {
    const source = straightSource();
    const paths = [{
        d: freehandSourceToPath(source),
        stroke: 'none',
        fill: '#000',
        strokeWidth: 0,
        freehandSource: source
    }];
    const result = splitPathsByEraser(paths, [{ x: 500, y: 500 }], 12, () => false);

    assert.deepEqual(result, paths);
});

// Eraser fully inside a thick stroke (does not cross the outline) must punch a
// HOLE, not leave the shape whole. Regression guard for the over-aggressive
// validation that rejected the legit hole result and fell back to a no-op.
test('clip strategy punches a hole when the eraser is fully inside a thick stroke', () => {
    const source = {
        points: Array.from({ length: 21 }, (_, i) => [i * 10, 0, 0.5]), // 0..200
        options: { size: 40, thinning: 0.2, smoothing: 0.5, streamline: 0.5 }
    };
    const origD = freehandSourceToPath(source);
    const paths = [{
        d: origD,
        stroke: 'none',
        fill: '#000',
        strokeWidth: 0,
        freehandSource: source
    }];
    // Small eraser dab at the stroke center, fully inside the capsule.
    const result = splitPathsByEraser(paths, [{ x: 100, y: 0 }], 8, () => false);

    assert.equal(result.length, 1);
    assert.notEqual(result[0].d, origD, 'the dab must change the stroke, not leave it whole');
    assert.equal(result[0].fill, '#000');
    assert.equal(result[0].freehandSource, undefined);
    // A hole punch yields an outer ring plus the eraser-shaped hole (>= 2 Z's).
    assert.ok((result[0].d.match(/ Z/g) || []).length >= 2, 'result has a hole');
});

const centroidOf = (d) => {
    const pts = coordsOf(d);
    if (pts.length === 0) return null;
    const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    return [cx, cy];
};

// Noisy scenario for clip: a long freehand stroke with a wavy swept eraser that
// crosses it many times. This is the input class where polygon-clipping used to
// emit a relocated "section fills in" artifact. The hardened guards must reject
// any such spurious fill (or fall back to the deterministic cut), so every
// surviving piece stays within the original outline bounds AND outside the eraser.
test('clip strategy never leaves a piece filling the erased zone on a noisy wavy erase', () => {
    const source = {
        points: Array.from({ length: 101 }, (_, i) => [i * 20, 0, 0.5]), // 0..2000
        options: { size: 16, thinning: 0.4, smoothing: 0.5, streamline: 0.5 }
    };
    const origPts = coordsOf(freehandSourceToPath(source));
    const minX = Math.min(...origPts.map(p => p[0]));
    const maxX = Math.max(...origPts.map(p => p[0]));
    const minY = Math.min(...origPts.map(p => p[1]));
    const maxY = Math.max(...origPts.map(p => p[1]));
    const paths = [{
        d: freehandSourceToPath(source),
        stroke: 'none',
        fill: '#000',
        strokeWidth: 0,
        freehandSource: source
    }];
    const eraserPoints = Array.from({ length: 60 }, (_, i) => ({
        x: 400 + i * 20,
        y: -50 + Math.sin(i / 2) * 60
    }));
    const radius = 14;
    const result = splitPathsByEraser(paths, eraserPoints, radius, () => false);

    assert.ok(result.length > 0);
    for (const p of result) {
        const pts = coordsOf(p.d);
        assert.ok(pts.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)), 'finite coords');
        for (const [x, y] of pts) {
            assert.ok(x >= minX - 2 && x <= maxX + 2, `x ${x} within outline bounds`);
            assert.ok(y >= minY - 2 && y <= maxY + 2, `y ${y} within outline bounds`);
        }
        // No surviving piece may sit deep inside the eraser (the relocated-fill signature).
        const c = centroidOf(p.d);
        assert.ok(c, 'piece has a centroid');
        assert.ok(
            distToEraser(c[0], c[1], eraserPoints) >= radius * 0.5,
            `piece centroid not inside eraser (dist ${distToEraser(c[0], c[1], eraserPoints)})`
        );
    }
});

// ---- helpers for hole / stray-fill regression tests ----
// Nonzero winding number at (x, y) over every subpath in one path `d`.
const windingAt = (d, x, y) => {
    const rings = d.split(/(?=M)/).filter(s => s.trim()).map(p => {
        const n = pathNumbers(p);
        const pts = [];
        for (let i = 0; i + 1 < n.length; i += 2) pts.push([n[i], n[i + 1]]);
        return pts;
    });
    let wn = 0;
    for (const ring of rings) {
        for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
            const [xa, ya] = ring[a];
            const [xb, yb] = ring[b];
            if (ya <= y) { if (yb > y && (xb - xa) * (y - ya) - (yb - ya) * (x - xa) > 0) wn++; }
            else { if (yb <= y && (xb - xa) * (y - ya) - (yb - ya) * (x - xa) < 0) wn--; }
        }
    }
    return wn;
};
// A point is rendered filled iff ANY emitted <path> element has nonzero winding there
// (separate path elements do not share a winding context under SVG nonzero fill).
const pointFilled = (paths, x, y) => paths.some(p => windingAt(p.d, x, y) !== 0);

// A closed circular freehand stroke: getStroke + union yields an outer ring with a
// large internal HOLE in the middle (the loop's interior). Center (cx,cy) sits in
// that hole; the ring is solid around it.
const circularSource = (cx = 200, cy = 100, radius = 50, n = 48) => ({
    points: Array.from({ length: n }, (_, i) => {
        const a = (Math.PI * 2 * i) / n;
        return [cx + Math.cos(a) * radius, cy + Math.sin(a) * radius, 0.5];
    }),
    options: { size: 18, thinning: 0.4, smoothing: 0.5, streamline: 0.3 }
});

// Regression guard for the freehand subject reconstruction fix (flatPathToFillGeometry
// now rebuilds a freehand outline's subject via authoritative `union` instead of the
// centroid-based heuristic). A looped freehand outline has a real internal hole; erasing
// a notch on the opposite side of the ring must NOT fill that hole in. The old heuristic
// could orphan a hole (centroid outside every outer) and render its region solid — the
// "random part fills in when I erase" glitch.
test('clip strategy keeps a looped freehand outline internal hole empty when erasing elsewhere', () => {
    const source = circularSource();
    const origD = freehandSourceToPath(source);
    const paths = [{
        d: origD,
        stroke: 'none',
        fill: '#000',
        strokeWidth: 0,
        freehandSource: source
    }];

    // Sanity: the loop's center is a hole (empty) in the committed outline.
    assert.equal(windingAt(origD, 200, 100), 0, 'center is a hole in the original outline');

    // Erase a small notch on the right side of the ring, far from the center hole.
    const result = splitPathsByEraser(paths, [{ x: 255, y: 100 }], 5, () => false);
    assert.ok(result.length > 0);
    assert.equal(result.every(p => p.fill === '#000'), true);
    assert.equal(result.every(p => p.freehandSource === undefined), true);

    // The internal hole must stay empty — it must not "fill in".
    assert.equal(pointFilled(result, 200, 100), false, 'center hole stays empty after erasing elsewhere');
    // The erased notch itself must be empty (material was actually removed).
    assert.equal(pointFilled(result, 255, 100), false, 'erased notch is empty');
});

// A second erase on the same loop must still keep the hole empty (guards against
// accumulated subject corruption across repeated clip erases).
test('clip strategy keeps a looped freehand outline hole empty across two separate erases', () => {
    const source = circularSource();
    let paths = [{
        d: freehandSourceToPath(source),
        stroke: 'none',
        fill: '#000',
        strokeWidth: 0,
        freehandSource: source
    }];
    paths = splitPathsByEraser(paths, [{ x: 255, y: 100 }], 5, () => false);
    assert.ok(paths.length > 0);
    paths = splitPathsByEraser(paths, [{ x: 145, y: 100 }], 5, () => false);
    assert.ok(paths.length > 0);
    assert.equal(pointFilled(paths, 200, 100), false, 'center hole still empty after two erases');
});

// Regression guard for the defensive half of the fix: the heuristic fallback (used for
// non-freehand paths) now DROPS a "homeless" hole — a hole ring whose interior sample is
// outside every outer — instead of pushing it as a standalone solid. The authored path
// below has a square outer plus a small opposite-wound ring sitting OUTSIDE the square.
// The old code rendered that stray ring as a solid filled region (the "section fills in"
// glitch); the fix drops it, so the stray region stays empty and no output path carries
// the stray ring's coordinates.
test('clip strategy drops a homeless hole instead of filling it in on a non-freehand outline', () => {
    // Outer square (CCW) + a small CW ring at (200,200)-(220,220), outside the square.
    const d = 'M 0 0 L 100 0 L 100 100 L 0 100 Z M 200 200 L 200 220 L 220 220 L 220 200 Z';
    const paths = [{
        d,
        stroke: 'none',
        fill: '#000',
        strokeWidth: 0
    }];
    // Erase a notch on the square's top edge (far from the stray ring).
    const result = splitPathsByEraser(paths, [{ x: 50, y: 0 }], 5, () => false);
    assert.ok(result.length > 0);

    // The stray ring's region must NOT be filled in.
    assert.equal(pointFilled(result, 210, 210), false, 'homeless hole region is not filled');
    // No emitted path should carry the stray ring's coordinates.
    assert.equal(result.some(p => p.d.includes('200.0 200.0')), false, 'no output path contains the stray ring');
});

// ---- id-keyed spatial broadphase (candidates + sync) ---------------------

const idPath = (id, d, extra = {}) => ({
    id,
    d,
    stroke: '#000',
    fill: 'none',
    strokeWidth: 2,
    ...extra
});

test('candidates broadphase carries through non-candidate paths untouched (same object)', () => {
    const a = idPath('a', 'M 0 0 L 100 0');
    const b = idPath('b', 'M 1000 0 L 1100 0'); // far from the eraser
    const sync = { removed: [], added: [] };
    const result = splitPathsByEraser(
        [a, b],
        [{ x: 50, y: -10 }, { x: 50, y: 10 }],
        5,
        () => false,
        { candidates: new Set(['a']), sync }
    );

    // `b` was not a candidate, so it passes through as the SAME object (no work).
    assert.equal(result.includes(b), true, 'non-candidate carried through');
    assert.equal(result.includes(a), false, 'candidate was split (original removed)');
    assert.equal(result.length, 1 + 2, 'two pieces from a plus untouched b');
    // Nothing was recorded for the untouched path.
    assert.equal(sync.removed.includes(b), false, 'non-candidate not recorded as removed');
    assert.equal(sync.added.includes(b), false, 'non-candidate not recorded as added');
});

test('sync records removed originals and added pieces with fresh ids', () => {
    const a = idPath('orig-a', 'M 0 0 L 100 0');
    const sync = { removed: [], added: [] };
    const result = splitPathsByEraser(
        [a],
        [{ x: 50, y: -10 }, { x: 50, y: 10 }],
        5,
        () => false,
        { candidates: new Set(['orig-a']), sync }
    );

    assert.deepEqual(sync.removed, [a], 'original recorded as removed');
    assert.equal(sync.added.length, result.length, 'every piece recorded as added');
    // Each piece gets a fresh id, distinct from the original and from each other.
    assert.equal(sync.added.every(p => typeof p.id === 'string' && p.id !== 'orig-a'), true, 'pieces have fresh ids');
    assert.equal(new Set(sync.added.map(p => p.id)).size, sync.added.length, 'piece ids are unique');
});

test('PathBboxGrid query returns only ids whose bounds intersect the rect', () => {
    const grid = new PathBboxGrid();
    const near = idPath('near', 'M 0 0 L 50 0');
    const far = idPath('far', 'M 5000 5000 L 5100 5000');
    grid.insert(near);
    grid.insert(far);

    const hits = grid.query({ x: -20, y: -20, width: 100, height: 100 });
    assert.equal(hits.has('near'), true, 'near path is a candidate');
    assert.equal(hits.has('far'), false, 'far path is not a candidate');
    assert.equal(grid.size, 2);
});

test('PathBboxGrid remove drops an id so it is no longer a candidate', () => {
    const grid = new PathBboxGrid();
    const p = idPath('p', 'M 0 0 L 50 0');
    grid.insert(p);
    assert.equal(grid.query({ x: 0, y: 0, width: 50, height: 10 }).has('p'), true);
    grid.remove(p);
    assert.equal(grid.query({ x: 0, y: 0, width: 50, height: 10 }).has('p'), false);
    assert.equal(grid.size, 0);
});

// splitOnePathByEraser is the per-path body of splitPathsByEraser factored out
// so the store can build one EraserCtx per move and split each broadphase
// candidate without re-running the shared eraser setup (resample/bounds/segments
// + a getStroke) per candidate. The store's in-place splice Pass 2 relies on
// per-candidate results being identical to a single full-array split. These
// checks pin that equivalence across flat, closed-filled, freehand, miss, and
// locked cases — comparing emitted `d` strings (piece ids are freshly generated
// on each call, so they intentionally differ; geometry is what must match).
const onePathEquivalenceCases = [
    {
        name: 'flat line split',
        path: linePath('M 0 0 L 100 0'),
        eraser: [{ x: 50, y: 10 }, { x: 50, y: -10 }],
        radius: 5,
        locked: () => false
    },
    {
        name: 'flat line miss carries through',
        path: linePath('M 0 0 L 100 0'),
        eraser: [{ x: 500, y: 500 }, { x: 510, y: 510 }],
        radius: 5,
        locked: () => false
    },
    {
        name: 'closed filled rect punched',
        path: { d: 'M 0 0 L 120 0 L 120 40 L 0 40 Z', stroke: 'none', fill: '#000', strokeWidth: 0 },
        eraser: [{ x: 60, y: 20 }, { x: 62, y: 20 }],
        radius: 10,
        locked: () => false
    },
    {
        name: 'closed filled rect miss carries through',
        path: { d: 'M 0 0 L 120 0 L 120 40 L 0 40 Z', stroke: 'none', fill: '#000', strokeWidth: 0 },
        eraser: [{ x: 500, y: 500 }],
        radius: 8,
        locked: () => false
    },
    {
        name: 'freehand stroke clip',
        path: (() => {
            const source = {
                points: [[0, 0, 0.5], [100, 40, 0.5], [0, 40, 0.5], [100, 0, 0.5]],
                options: { size: 12, thinning: 0.6, smoothing: 0.5, streamline: 0.5 }
            };
            return { d: freehandSourceToPath(source), stroke: 'none', fill: '#000', strokeWidth: 0, freehandSource: source };
        })(),
        eraser: [{ x: 50, y: 20 }],
        radius: 8,
        locked: () => false
    },
    {
        name: 'locked path carries through',
        path: linePath('M 0 0 L 100 0'),
        eraser: [{ x: 50, y: 0 }],
        radius: 5,
        locked: () => true
    }
];

for (const c of onePathEquivalenceCases) {
    test(`splitOnePathByEraser matches splitPathsByEraser per-path: ${c.name}`, () => {
        const full = splitPathsByEraser([c.path], c.eraser, c.radius, c.locked);
        const ctx = buildEraserCtx(c.eraser, c.radius);
        const one = splitOnePathByEraser(c.path, ctx, c.locked);

        assert.equal(one.length, full.length, 'piece count matches');
        for (let i = 0; i < full.length; i++) {
            assert.equal(one[i].d, full[i].d, `piece ${i} d matches`);
        }
        // Carry-through (no-op) must return the SAME object so the store's
        // `pieces.length === 1 && pieces[0] === path` skip fires and avoids
        // spurious grid churn + splices.
        if (full.length === 1 && full[0] === c.path) {
            assert.equal(one[0], c.path, 'carry-through returns the same object');
        }
    });
}

test('buildEraserCtx populates shared geometry; closed-filled candidates clip against a local region', () => {
    const eraser = [{ x: 0, y: 0 }, { x: 40, y: 0 }];
    const ctx = buildEraserCtx(eraser, 8);
    assert.ok(ctx.eraserBounds.minX <= 0 && ctx.eraserBounds.maxX >= 40, 'bounds cover the sweep');
    assert.ok(ctx.eraserSegments.length > 0, 'segments are populated');

    // Flat strokes split via interval math (no polygon clipping involved).
    // This one lies 5 from the centreline of a radius-8 sweep spanning its whole
    // length, so it is entirely inside the eraser and goes completely.
    const flat = linePath('M 0 -5 L 40 -5');
    const flatPieces = splitOnePathByEraser(flat, ctx, () => false);
    assert.equal(flatPieces.length, 0, 'flat stroke inside the sweep is erased, not carried through');

    // Closed-filled candidates clip against the LOCAL portion of the trail
    // (localEraserRegion — capsules whose segment bbox can reach the path's
    // bbox). Behaviorally: a rect overlapping the sweep gets cut, and repeat
    // calls on the identical inputs produce identical output.
    const rect = { d: 'M 0 0 L 120 0 L 120 40 L 0 40 Z', stroke: 'none', fill: '#000', strokeWidth: 0 };
    const first = splitOnePathByEraser(rect, ctx, () => false);
    assert.ok(first.length >= 1 && first[0] !== rect, 'closed-filled candidate is clipped');
    const second = splitOnePathByEraser(rect, ctx, () => false);
    assert.deepEqual(second.map(p => p.d), first.map(p => p.d), 'repeat split is deterministic');

    // A closed-filled path entirely OUT of the trail's reach is carried
    // through untouched (localEraserRegion returns null).
    const farRect = { d: 'M 500 500 L 560 500 L 560 540 L 500 540 Z', stroke: 'none', fill: '#000', strokeWidth: 0 };
    const far = splitOnePathByEraser(farRect, ctx, () => false);
    assert.equal(far.length, 1);
    assert.equal(far[0], farRect, 'far path passes through as the same object');
});
