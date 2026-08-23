/**
 * Fetch-based SSE consumer (Local Network Access requires `fetch`, not EventSource).
 */
import { withLocalAddressSpace } from './localNetwork.js';
import { parseSseChunk } from './watchStream.js';

export async function openJsonSse(opts: {
	url: string;
	fetchImpl?: typeof fetch;
	signal?: AbortSignal;
	onEvent: (event: string, data: unknown) => void;
}): Promise<{ abort: () => void }> {
	const fetchFn = opts.fetchImpl ?? fetch;
	const ac = new AbortController();
	const onAbort = () => ac.abort();
	opts.signal?.addEventListener('abort', onAbort);
	if (opts.signal?.aborted) ac.abort();

	let res: Response;
	try {
		res = await fetchFn(
			opts.url,
			withLocalAddressSpace(opts.url, {
				method: 'GET',
				headers: { accept: 'text/event-stream' },
				signal: ac.signal
			})
		);
	} catch (e) {
		opts.signal?.removeEventListener('abort', onAbort);
		throw e;
	}
	if (!res.ok || !res.body) {
		opts.signal?.removeEventListener('abort', onAbort);
		throw new Error(`SSE failed (${res.status})`);
	}

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	let stopped = false;

	const abort = () => {
		if (stopped) return;
		stopped = true;
		ac.abort();
		opts.signal?.removeEventListener('abort', onAbort);
	};

	void (async () => {
		try {
			for (;;) {
				if (stopped) break;
				const { done, value } = await reader.read();
				if (done || stopped) break;
				buffer += decoder.decode(value, { stream: true });
				const lastBreak = buffer.lastIndexOf('\n\n');
				if (lastBreak === -1) continue;
				const complete = buffer.slice(0, lastBreak + 2);
				buffer = buffer.slice(lastBreak + 2);
				for (const ev of parseSseChunk(complete)) {
					try {
						opts.onEvent(ev.event, JSON.parse(ev.data));
					} catch {
						/* ignore malformed frames */
					}
				}
			}
		} catch {
			/* abort / network */
		} finally {
			opts.signal?.removeEventListener('abort', onAbort);
		}
	})();

	return { abort };
}
