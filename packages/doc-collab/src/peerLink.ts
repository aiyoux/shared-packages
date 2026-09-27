/**
 * A peer link for the session engine: one app's lane on the shared CM
 * envelope, split into parts a data channel will carry.
 *
 * Untagged by document. An invite carries one document per app and a join
 * rides a wire of its own, so there is nothing to tell apart — and a tag is
 * worse than useless: the guest opens on a document of its own, so a tag
 * taken from it never matched the host's and every frame was dropped.
 */
import { openCollabChannel, type CmEnvelope, type CmEnvelopeChunker, type CmEnvelopeSession } from './envelope.js';

/** Characters per part. A data channel send is one SCTP message. */
export const PEER_CHUNK_CHARS = 16 * 1024;

type Part = { kind: 'chunk'; id: string; i: number; n: number; data: string };

function isPart(value: unknown): value is Part {
	const p = value as Partial<Part> | null;
	return (
		!!p &&
		p.kind === 'chunk' &&
		typeof p.id === 'string' &&
		typeof p.data === 'string' &&
		Number.isInteger(p.i) &&
		Number.isInteger(p.n) &&
		(p.n as number) >= 1 &&
		(p.i as number) >= 0 &&
		(p.i as number) < (p.n as number)
	);
}

function newId(): string {
	const c = globalThis.crypto;
	return typeof c?.randomUUID === 'function' ? c.randomUUID() : `c-${Math.random().toString(36).slice(2)}`;
}

/** Split frames whose JSON is longer than `limit`; small frames pass untouched. */
export function jsonChunker<F>(limit = PEER_CHUNK_CHARS): CmEnvelopeChunker<F> {
	const partial = new Map<string, { parts: (string | undefined)[]; have: number }>();
	return {
		split(frame) {
			const json = JSON.stringify(frame);
			if (json.length <= limit) return [frame];
			const id = newId();
			const n = Math.ceil(json.length / limit);
			const out: Part[] = [];
			for (let i = 0; i < n; i++) out.push({ kind: 'chunk', id, i, n, data: json.slice(i * limit, (i + 1) * limit) });
			return out;
		},
		push(part) {
			if (!isPart(part)) return part as F;
			let entry = partial.get(part.id);
			if (!entry) partial.set(part.id, (entry = { parts: new Array(part.n), have: 0 }));
			if (entry.parts[part.i] === undefined) {
				entry.parts[part.i] = part.data;
				entry.have += 1;
			}
			if (entry.have < part.n) return null;
			partial.delete(part.id);
			try {
				return JSON.parse(entry.parts.join('')) as F;
			} catch {
				return null;
			}
		},
		reset() {
			partial.clear();
		}
	};
}

/** One app's lane on a CM connection (an invite's, or a join wire). */
export function openPeerLink<F extends { kind: string }>(
	wire: { sendKb: (msg: CmEnvelope) => void; onKb: (handler: (msg: CmEnvelope) => void) => void },
	app: string,
	accept?: (frame: F) => boolean
): CmEnvelopeSession<F> {
	return openCollabChannel<F>({
		sendKb: (msg) => wire.sendKb(msg),
		onKb: (handler) => wire.onKb(handler),
		app,
		chunk: jsonChunker<F>(),
		accept
	});
}
