/** Small text-only browser LLM. Weights come only from the browser model store
 * (Settings → AI models); no input is sent to the monitor or an API provider. */
import { browserModelStore, transformersCache } from '@shared-packages/model-store';
import { BROWSER_CHAT_MODELS } from '../models.js';
import { configureTransformersEnv, type TransformEnv } from './transformersEnv.js';
import { serveWorkerRpc } from './workerRpc.js';

type ChatTurn = { role: 'system' | 'user' | 'assistant'; content: string };
type Generator = (messages: ChatTurn[], options: object) => Promise<unknown>;
let generator: Generator | null = null;
let loadedKey: string | null = null;

/** Reload when the device or the stored files change (a clear or replace in Settings). */
async function generatorFor(device: 'wasm' | 'webgpu'): Promise<Generator> {
	const def = BROWSER_CHAT_MODELS[device];
	return browserModelStore.readReady(def.model, async (files) => {
		const key = `${device}|${files.manifest.revision}`;
		if (generator && loadedKey === key) return generator;
		const mod = await import('@huggingface/transformers');
		configureTransformersEnv(mod as unknown as { env: TransformEnv }, transformersCache(def.model, files));
		generator = await mod.pipeline('text-generation', def.repo, { device, dtype: def.dtype }) as unknown as Generator;
		loadedKey = key;
		return generator;
	});
}

serveWorkerRpc({
	async generate(payload) {
		const device = payload.device === 'webgpu' ? 'webgpu' : 'wasm';
		const messages = payload.messages as ChatTurn[];
		if (!Array.isArray(messages) || messages.length === 0) throw new Error('Chat messages are required');
		const output = await (await generatorFor(device))(messages, { max_new_tokens: 256, do_sample: false });
		const first = Array.isArray(output) ? output[0] as { generated_text?: unknown } : null;
		const generated = first?.generated_text;
		const answer = Array.isArray(generated)
			? (generated.at(-1) as { content?: unknown } | undefined)?.content
			: generated;
		if (typeof answer !== 'string' || !answer.trim()) throw new Error('Browser model returned an empty answer');
		return { result: answer.trim() };
	}
});
