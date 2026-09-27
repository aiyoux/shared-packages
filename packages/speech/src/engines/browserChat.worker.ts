/** Small text-only browser LLM. Model files are fetched by Transformers.js and
 * cached in the browser; no input is sent to the monitor or an API provider. */
import { serveWorkerRpc } from './workerRpc.js';

const MODEL = 'onnx-community/SmolLM2-135M-Instruct-ONNX';
type ChatTurn = { role: 'system' | 'user' | 'assistant'; content: string };
let generator: ((messages: ChatTurn[], options: object) => Promise<unknown>) | null = null;
let loadedDevice: 'wasm' | 'webgpu' | null = null;

serveWorkerRpc({
	async generate(payload) {
		const device = payload.device === 'webgpu' ? 'webgpu' : 'wasm';
		const messages = payload.messages as ChatTurn[];
		if (!Array.isArray(messages) || messages.length === 0) throw new Error('Chat messages are required');
		if (!generator || loadedDevice !== device) {
			const { pipeline } = await import('@huggingface/transformers');
			generator = await pipeline('text-generation', MODEL, {
				device, dtype: device === 'webgpu' ? 'q4f16' : 'q4'
			}) as unknown as typeof generator;
			loadedDevice = device;
		}
		const output = await generator!(messages, { max_new_tokens: 256, do_sample: false });
		const first = Array.isArray(output) ? output[0] as { generated_text?: unknown } : null;
		const generated = first?.generated_text;
		const answer = Array.isArray(generated)
			? (generated.at(-1) as { content?: unknown } | undefined)?.content
			: generated;
		if (typeof answer !== 'string' || !answer.trim()) throw new Error('Browser model returned an empty answer');
		return { result: answer.trim() };
	}
});
