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
