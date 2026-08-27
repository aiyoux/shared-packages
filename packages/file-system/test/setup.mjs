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

// Swapping Blob above is not enough for Files: jsdom's File class captured the
// ORIGINAL jsdom Blob prototype at env creation, so File instances still lack
// arrayBuffer() — which the local driver's writeFile reads. Patch it onto the
// prototype, backed by jsdom's own FileReader (which does read jsdom Blobs).
// Swapping in Node's File instead would break jsdom's FileReader, which is the
// path osDrop uses for dropped-folder snapshots. Real browsers always have
// arrayBuffer(); this only repairs the test env.
if (
	typeof globalThis.File !== 'undefined' &&
	typeof globalThis.File.prototype?.arrayBuffer !== 'function' &&
	typeof FileReader === 'function'
) {
	globalThis.File.prototype.arrayBuffer = function () {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => {
				if (reader.result instanceof ArrayBuffer) resolve(reader.result);
				else reject(new Error('Could not read file'));
			};
			reader.onerror = () => reject(reader.error ?? new Error('Could not read file'));
			reader.readAsArrayBuffer(this);
		});
	};
}
