import type { PathData } from './types.ts';

export interface PathCommand {
    type: string;
    args: number[];
}

export type NodeRef = { pathIndex: number; cmdIndex: number; argOffset: number };
export type ParsedPathEntry = {
    path: PathData;
    pathIndex: number;
    commands: PathCommand[];
    translate: [number, number];
};

type IndexedNode = NodeRef & { worldX: number; worldY: number };
type CoincidentNodeIndex = Map<string, IndexedNode[]>;

export function parsePath(d: string): PathCommand[] {
    const regex = /([MmLlHhVvCcSsQqTtAaZz])([^MmLlHhVvCcSsQqTtAaZz]*)/g;
    const commands: PathCommand[] = [];
    let match;
    while ((match = regex.exec(d)) !== null) {
        const type = match[1];
        const argString = match[2].trim();
        const args: number[] = [];
        if (argString) {
            const numRegex = /-?[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?/g;
            let numMatch;
            while ((numMatch = numRegex.exec(argString)) !== null) {
                args.push(parseFloat(numMatch[0]));
            }
        }
        commands.push({ type, args });
    }
    return commands;
}

export function stringifyPath(commands: PathCommand[]): string {
    return commands.map(c => {
        if (c.args.length > 0) {
            return `${c.type} ${c.args.join(' ')}`;
        }
        return c.type;
    }).join(' ');
}

/** Number of args each command type consumes per repetition. Used to walk a
 *  parsed `d` command-by-command instead of assuming every number is half of an
 *  (x, y) pair — which is only true until an arc shows up (7 args, of which
 *  just the last two are a point). */
export const ARGS_PER_COMMAND: Record<string, number> = {
    M: 2, L: 2, T: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, A: 7, Z: 0
};

/**
 * Sample an SVG elliptical arc as a polyline, endpoint parameterization →
 * center parameterization per the SVG 1.1 implementation notes (F.6.5).
 *
 * Returns the points AFTER the start point (so a caller can append them
 * directly to a run of line segments). `maxSegLen` caps the chord length of
 * each emitted segment, matching how the bezier flatteners pick their step
 * count.
 *
 * Baked 3D primitives (cloud puffs, glows, halos) are emitted as arc circles,
 * so anything that reasons about path geometry — erasing, bounds — has to be
 * able to turn these back into points. Without it an arc contributes only its
 * start point, which reads as "the shape is a single dot at its left edge".
 */
export function sampleArc(
    x1: number,
    y1: number,
    rx: number,
    ry: number,
    xAxisRotationDeg: number,
    largeArcFlag: number,
    sweepFlag: number,
    x2: number,
    y2: number,
    maxSegLen = 8
): { x: number; y: number }[] {
    // Degenerate radii: the spec says treat the arc as a straight line.
    if (!isFinite(rx) || !isFinite(ry) || rx === 0 || ry === 0) return [{ x: x2, y: y2 }];
    if (x1 === x2 && y1 === y2) return [];

    rx = Math.abs(rx);
    ry = Math.abs(ry);
    const phi = (xAxisRotationDeg * Math.PI) / 180;
    const cosPhi = Math.cos(phi);
    const sinPhi = Math.sin(phi);

    const dx2 = (x1 - x2) / 2;
    const dy2 = (y1 - y2) / 2;
    const x1p = cosPhi * dx2 + sinPhi * dy2;
    const y1p = -sinPhi * dx2 + cosPhi * dy2;

    // Scale up radii that are too small to span the endpoints (F.6.6).
    const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
    if (lambda > 1) {
        const s = Math.sqrt(lambda);
        rx *= s;
        ry *= s;
    }

    const rx2 = rx * rx;
    const ry2 = ry * ry;
    const num = rx2 * ry2 - rx2 * y1p * y1p - ry2 * x1p * x1p;
    const den = rx2 * y1p * y1p + ry2 * x1p * x1p;
    // max(0, …) guards the exact semicircle (endpoints a full diameter apart),
    // where rounding can push `num` fractionally below zero and NaN the root.
    // That is exactly how the baked circles are emitted, so it is the common
    // case here, not an edge case.
    const coef = (largeArcFlag !== sweepFlag ? 1 : -1) * Math.sqrt(Math.max(0, num / den));
    const cxp = (coef * (rx * y1p)) / ry;
    const cyp = (coef * -(ry * x1p)) / rx;
    const cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2;
    const cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2;

    const angle = (ux: number, uy: number, vx: number, vy: number) => {
        const dot = ux * vx + uy * vy;
        const len = Math.sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy));
        const sign = ux * vy - uy * vx < 0 ? -1 : 1;
        return sign * Math.acos(Math.min(1, Math.max(-1, dot / (len || 1e-12))));
    };

    const ux = (x1p - cxp) / rx;
    const uy = (y1p - cyp) / ry;
    const vx = (-x1p - cxp) / rx;
    const vy = (-y1p - cyp) / ry;
    const theta1 = angle(1, 0, ux, uy);
    let dTheta = angle(ux, uy, vx, vy) % (Math.PI * 2);
    if (!sweepFlag && dTheta > 0) dTheta -= Math.PI * 2;
    if (sweepFlag && dTheta < 0) dTheta += Math.PI * 2;

    // Step count from the approximate arc length, same 8px chord budget the
    // cubic/quadratic flatteners use.
    const arcLen = Math.abs(dTheta) * ((rx + ry) / 2);
    const steps = Math.max(4, Math.ceil(arcLen / maxSegLen));

    const points: { x: number; y: number }[] = [];
    for (let i = 1; i <= steps; i++) {
        const theta = theta1 + (dTheta * i) / steps;
        const cosT = Math.cos(theta);
        const sinT = Math.sin(theta);
        points.push({
            x: cx + rx * cosPhi * cosT - ry * sinPhi * sinT,
            y: cy + rx * sinPhi * cosT + ry * cosPhi * sinT
        });
    }
    // Land exactly on the declared endpoint rather than a rounded sample, so
    // consecutive arcs (a circle is two of them) stay watertight.
    points[points.length - 1] = { x: x2, y: y2 };
    return points;
}

export function updatePathPoint(d: string, cmdIndex: number, argOffset: number, x: number, y: number): string {
    const commands = parsePath(d);
    const cmd = commands[cmdIndex];

    if (cmd && cmd.args && cmd.args.length >= argOffset + 2) {
        cmd.args[argOffset] = x;
        cmd.args[argOffset + 1] = y;
        return stringifyPath(commands);
    }
    return d;
}

export function parseTranslate(transform?: string): [number, number] {
    if (!transform) return [0, 0];
    const m = transform.match(/translate\(\s*(-?[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?)\s*[,\s]\s*(-?[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?)\s*\)/);
    if (!m) return [0, 0];
    const tx = parseFloat(m[1]);
    const ty = parseFloat(m[2]);
    return [isNaN(tx) ? 0 : tx, isNaN(ty) ? 0 : ty];
}

export function isMainNodeOffset(cmdType: string, argOffset: number): boolean {
    const t = cmdType.toUpperCase();
    if (t === 'M' || t === 'L' || t === 'T') return argOffset === 0;
    if (t === 'C') return argOffset === 4;
    if (t === 'Q' || t === 'S') return argOffset === 2;
    return false;
}

export function createParsedPathEntries(paths: PathData[]): ParsedPathEntry[] {
    return paths.map((path, pathIndex) => ({
        path,
        pathIndex,
        commands: parsePath(path.d),
        translate: parseTranslate(path.transform)
    }));
}

function coordinateKey(bakeGroupId: string, x: number, y: number, eps: number): string {
    const scale = eps > 0 ? eps : 1;
    return `${bakeGroupId}:${Math.round(x / scale)}:${Math.round(y / scale)}`;
}

function buildCoincidentNodeIndex(entries: ParsedPathEntry[], eps: number): CoincidentNodeIndex {
    const index: CoincidentNodeIndex = new Map();

    for (const entry of entries) {
        const bakeGroupId = entry.path.bakeGroupId;
        if (!bakeGroupId) continue;
        const [tx, ty] = entry.translate;

        for (let cmdIndex = 0; cmdIndex < entry.commands.length; cmdIndex++) {
            const cmd = entry.commands[cmdIndex];
            for (let argOffset = 0; argOffset + 1 < cmd.args.length; argOffset += 2) {
                if (!isMainNodeOffset(cmd.type, argOffset)) continue;
                const worldX = cmd.args[argOffset] + tx;
                const worldY = cmd.args[argOffset + 1] + ty;
                const key = coordinateKey(bakeGroupId, worldX, worldY, eps);
                const nodes = index.get(key) ?? [];
                nodes.push({ pathIndex: entry.pathIndex, cmdIndex, argOffset, worldX, worldY });
                index.set(key, nodes);
            }
        }
    }

    return index;
}

function findEntry(entries: ParsedPathEntry[], pathIndex: number): ParsedPathEntry | undefined {
    return entries.find(entry => entry.pathIndex === pathIndex);
}

export function findCoincidentNodesInParsedPaths(
    entries: ParsedPathEntry[],
    pathIndex: number,
    cmdIndex: number,
    argOffset: number,
    eps: number
): NodeRef[] {
    const primary: NodeRef = { pathIndex, cmdIndex, argOffset };
    const entry = findEntry(entries, pathIndex);
    const cmd = entry?.commands[cmdIndex];

    if (!entry?.path.bakeGroupId || !cmd || !isMainNodeOffset(cmd.type, argOffset)) {
        return [primary];
    }

    const [tx, ty] = entry.translate;
    const worldX = cmd.args[argOffset] + tx;
    const worldY = cmd.args[argOffset + 1] + ty;
    const index = buildCoincidentNodeIndex(entries, eps);
    const linked: NodeRef[] = [];
    const seen = new Set<string>();

    for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
            const key = coordinateKey(entry.path.bakeGroupId, worldX + (eps * dx), worldY + (eps * dy), eps);
            for (const node of index.get(key) ?? []) {
                if (Math.abs(node.worldX - worldX) > eps || Math.abs(node.worldY - worldY) > eps) continue;
                const id = `${node.pathIndex}:${node.cmdIndex}:${node.argOffset}`;
                if (seen.has(id)) continue;
                linked.push({ pathIndex: node.pathIndex, cmdIndex: node.cmdIndex, argOffset: node.argOffset });
                seen.add(id);
            }
        }
    }

    const primaryId = `${pathIndex}:${cmdIndex}:${argOffset}`;
    if (!seen.has(primaryId)) linked.unshift(primary);
    linked.sort((a, b) => a.pathIndex - b.pathIndex || a.cmdIndex - b.cmdIndex || a.argOffset - b.argOffset);
    return linked;
}

export function updateCoincidentParsedNodes(
    paths: PathData[],
    entries: ParsedPathEntry[],
    linkedNodes: NodeRef[],
    worldX: number,
    worldY: number
): void {
    const byPath = new Map<number, { cmdIndex: number, argOffset: number }[]>();

    for (const node of linkedNodes) {
        const updates = byPath.get(node.pathIndex) ?? [];
        updates.push({ cmdIndex: node.cmdIndex, argOffset: node.argOffset });
        byPath.set(node.pathIndex, updates);
    }

    for (const [pathIndex, updates] of byPath) {
        const path = paths[pathIndex];
        const entry = findEntry(entries, pathIndex);
        const [tx, ty] = entry?.translate ?? parseTranslate(path.transform);
        const commands = entry?.commands ?? parsePath(path.d);
        const localX = worldX - tx;
        const localY = worldY - ty;

        for (const update of updates) {
            const cmd = commands[update.cmdIndex];
            if (cmd && cmd.args && cmd.args.length >= update.argOffset + 2) {
                cmd.args[update.argOffset] = localX;
                cmd.args[update.argOffset + 1] = localY;
            }
        }

        path.d = stringifyPath(commands);
        paths[pathIndex] = path;
    }
}

export function polygonToPath(pointsString: string): string {
    const coords = pointsString.trim().split(/[\s,]+/);
    if (coords.length >= 2) {
        let pathString = '';
        for (let i = 0; i < coords.length; i += 2) {
            pathString += (i === 0 ? 'M ' : 'L ') + coords[i] + ' ' + (coords[i+1] || '0') + ' ';
        }
        return pathString + 'Z';
    }
    return '';
}

export function findCoincidentNodes(paths: PathData[], pathIndex: number, cmdIndex: number, argOffset: number, eps: number): NodeRef[] {
    return findCoincidentNodesInParsedPaths(createParsedPathEntries(paths), pathIndex, cmdIndex, argOffset, eps);
}

export function updateCoincidentNodes(paths: PathData[], linkedNodes: NodeRef[], worldX: number, worldY: number): void {
    updateCoincidentParsedNodes(paths, createParsedPathEntries(paths), linkedNodes, worldX, worldY);
}
