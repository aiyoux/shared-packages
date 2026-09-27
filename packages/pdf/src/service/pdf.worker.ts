/// <reference lib="webworker" />
/**
 * The PDF service's worker: opens documents with the chosen engine and runs
 * page jobs off the main thread. Engines load on first use, so a PDFium-only
 * worker never downloads pdf.js.
 */
import { openServiceDoc, type ServiceDoc } from './engines.js';
import type { PdfServiceRequest, PdfServiceResponse } from './protocol.js';

const scope = self as unknown as DedicatedWorkerGlobalScope;
const docs = new Map<string, Promise<ServiceDoc>>();

function reply(msg: PdfServiceResponse): void {
	scope.postMessage(msg);
}

function message(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

scope.onmessage = async (e: MessageEvent<PdfServiceRequest>) => {
	const msg = e.data;
	// pdf.js's own worker plumbing shares this scope; its frames are not ours.
	if (!msg || typeof msg !== 'object' || !('docId' in msg)) return;
	if (msg.type === 'open') {
		// Set before any await so a job posted right after finds it.
		const opening = openServiceDoc(msg.engine, msg.bytes, msg.assets);
		docs.set(msg.docId, opening);
		try {
			const doc = await opening;
			reply({ type: 'opened', reqId: msg.reqId, sizes: doc.sizes });
		} catch (err) {
			if (docs.get(msg.docId) === opening) docs.delete(msg.docId);
			reply({ type: 'failed', reqId: msg.reqId, message: message(err) });
		}
		return;
	}
	if (msg.type === 'close') {
		const held = docs.get(msg.docId);
		docs.delete(msg.docId);
		void held?.then((doc) => doc.close(), () => {});
		return;
	}
	try {
		const held = docs.get(msg.docId);
		if (!held) throw new Error('PDF is not open in this worker.');
		const doc = await held;
		if (msg.type === 'render') {
			reply({ type: 'rendered', reqId: msg.reqId, blob: await doc.render(msg.index, msg.width, msg.format) });
		} else {
			reply({ type: 'interpreted', reqId: msg.reqId, result: await doc.interpret(msg.index, msg.target) });
		}
	} catch (err) {
		reply({ type: 'failed', reqId: msg.reqId, message: message(err) });
	}
};
