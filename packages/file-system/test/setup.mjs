import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import { Blob as NodeBlob } from 'node:buffer';

globalThis.indexedDB = indexedDB;
globalThis.IDBKeyRange = IDBKeyRange;

// jsdom Blob lacks arrayBuffer/stream in some versions — use Node's Blob for VFS serialize.
if (
	typeof globalThis.Blob === 'undefined' ||
	typeof globalThis.Blob.prototype.arrayBuffer !== 'function'
) {
	globalThis.Blob = NodeBlob;
}
