import { Buffer } from 'buffer';

/** isomorphic-git's GitIndex uses `Buffer` which browsers do not define. */
export function ensureBuffer(): void {
	const g = globalThis as typeof globalThis & { Buffer?: typeof Buffer };
	if (g.Buffer === undefined) g.Buffer = Buffer;
}

ensureBuffer();
