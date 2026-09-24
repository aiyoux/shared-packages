/// <reference lib="webworker" />
/**
 * One ZipKit WASM engine per worker. The page fans ZIP entry deflate across
 * these so a multi-file archive uses more than one core. Node's worker_threads
 * pool cannot be constructed in the Vite browser bundle.
 */
import { getEngine } from '@myrialabs/zipkit';

type Request = {
	id: number;
	data: Uint8Array;
	level: number;
};

type Response = {
	id: number;
	result?: Uint8Array;
	error?: string;
};

const ctx = self as unknown as {
	onmessage: ((event: MessageEvent<Request>) => void) | null;
	postMessage: (message: Response, transfer?: Transferable[]) => void;
};

ctx.onmessage = async (event) => {
	const { id, data, level } = event.data;
	try {
		const engine = await getEngine();
		const result = engine.deflateCompress(data, level);
		ctx.postMessage({ id, result }, [result.buffer]);
	} catch (err) {
		ctx.postMessage({
			id,
			error: err instanceof Error ? err.message : String(err)
		});
	}
};
