/** The NovaSR chunk layout and worker-local inference loop. */
export const NOVASR_IN_RATE = 16000;
export const NOVASR_OUT_RATE = 48000;
const RATIO = NOVASR_OUT_RATE / NOVASR_IN_RATE;
const CHUNK = 60 * NOVASR_IN_RATE;
const PAD = NOVASR_IN_RATE / 4;

export type NovaSrTensor = { readonly data: Float32Array; readonly dims: readonly number[]; dispose(): void };
export type NovaSrSession = {
	readonly inputNames: readonly string[];
	readonly outputNames: readonly string[];
	run(feeds: Record<string, NovaSrTensor>): Promise<Record<string, NovaSrTensor>>;
};
export type NovaSrOrt = {
	env: { wasm: { wasmPaths: string; numThreads: number; proxy: boolean } };
	InferenceSession: { create(model: Uint8Array, opts?: unknown): Promise<NovaSrSession> };
	Tensor: new (type: 'float32', data: Float32Array, dims: readonly number[]) => NovaSrTensor;
};

/** Which input span each run sees and which output part it keeps. */
export function novasrChunks(length: number): Array<{ from: number; to: number; keepFrom: number; keepTo: number }> {
	const plan: Array<{ from: number; to: number; keepFrom: number; keepTo: number }> = [];
	for (let start = 0; start < length; start += CHUNK) {
		const end = Math.min(length, start + CHUNK);
		const from = Math.max(0, start - PAD);
		const to = Math.min(length, end + PAD);
		plan.push({ from, to, keepFrom: (start - from) * RATIO, keepTo: (end - from) * RATIO });
	}
	return plan;
}

export async function runNovasrChunks(
	samples16k: Float32Array,
	ort: NovaSrOrt,
	session: NovaSrSession,
	onProgress?: (done: number, total: number) => void
): Promise<Float32Array<ArrayBuffer>> {
	const out = new Float32Array(samples16k.length * RATIO);
	const plan = novasrChunks(samples16k.length);
	let written = 0;
	for (const [index, part] of plan.entries()) {
		const input = samples16k.slice(part.from, part.to);
		const tensor = new ort.Tensor('float32', input, [1, 1, input.length]);
		let result: Record<string, NovaSrTensor> | undefined;
		try {
			result = await session.run({ [session.inputNames[0]!]: tensor });
			const y = result[session.outputNames[0]!]!.data;
			const kept = y.subarray(part.keepFrom, Math.min(y.length, part.keepTo));
			out.set(kept, written);
			written += kept.length;
		} finally {
			tensor.dispose();
			for (const output of Object.values(result ?? {})) output.dispose();
		}
		onProgress?.(index + 1, plan.length);
	}
	return out.subarray(0, written);
}
