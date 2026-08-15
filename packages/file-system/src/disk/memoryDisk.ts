/**
 * In-memory File System Access mock for unit tests.
 */
import type { DiskDirHandle, DiskFileHandle } from './handles.js';

type MemFile = { kind: 'file'; name: string; bytes: Uint8Array; type: string };
type MemDir = { kind: 'directory'; name: string; children: Map<string, MemNode> };
type MemNode = MemFile | MemDir;

/** The real API rejects with a DOMException; callers branch on `.name`. */
function fsError(name: 'NotFoundError' | 'TypeMismatchError', message: string): Error {
	const e = new Error(message);
	e.name = name;
	return e;
}

function nowFile(name: string, bytes: Uint8Array, type: string): File {
	return new File([bytes], name, { type });
}

function wrapFile(node: MemFile): DiskFileHandle {
	return {
		kind: 'file',
		name: node.name,
		async getFile() {
			return nowFile(node.name, node.bytes, node.type);
		},
		async createWritable() {
			const chunks: Uint8Array[] = [];
			return {
				async write(data) {
					if (typeof data === 'string') {
						chunks.push(new TextEncoder().encode(data));
						return;
					}
					if (data instanceof Blob) {
						chunks.push(new Uint8Array(await data.arrayBuffer()));
						return;
					}
					chunks.push(new Uint8Array(data as ArrayBuffer));
				},
				async close() {
					let len = 0;
					for (const c of chunks) len += c.byteLength;
					const out = new Uint8Array(len);
					let o = 0;
					for (const c of chunks) {
						out.set(c, o);
						o += c.byteLength;
					}
					node.bytes = out;
				}
			};
		}
	};
}

function wrapDir(node: MemDir): DiskDirHandle {
	return {
		kind: 'directory',
		name: node.name,
		async *entries() {
			for (const [name, child] of node.children) {
				yield [name, child.kind === 'directory' ? wrapDir(child) : wrapFile(child)];
			}
		},
		async getDirectoryHandle(name, opts) {
			const existing = node.children.get(name);
			if (existing?.kind === 'directory') return wrapDir(existing);
			if (existing) throw fsError('TypeMismatchError', 'TYPE_MISMATCH');
			if (!opts?.create) throw fsError('NotFoundError', 'NOT_FOUND');
			const created: MemDir = { kind: 'directory', name, children: new Map() };
			node.children.set(name, created);
			return wrapDir(created);
		},
		async getFileHandle(name, opts) {
			const existing = node.children.get(name);
			if (existing?.kind === 'file') return wrapFile(existing);
			if (existing) throw fsError('TypeMismatchError', 'TYPE_MISMATCH');
			if (!opts?.create) throw fsError('NotFoundError', 'NOT_FOUND');
			const created: MemFile = { kind: 'file', name, bytes: new Uint8Array(), type: '' };
			node.children.set(name, created);
			return wrapFile(created);
		},
		async removeEntry(name) {
			if (!node.children.delete(name)) throw fsError('NotFoundError', 'NOT_FOUND');
		}
	};
}

export function createMemoryDiskRoot(name = 'picked'): DiskDirHandle {
	return wrapDir({ kind: 'directory', name, children: new Map() });
}
