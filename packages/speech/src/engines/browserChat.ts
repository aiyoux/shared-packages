import { createWorkerRpc } from './workerRpc.js';

export const BROWSER_CHAT_MODEL = 'onnx-community/SmolLM2-135M-Instruct-ONNX';
export type BrowserChatDevice = 'wasm' | 'webgpu';
export type BrowserChatTurn = { role: 'system' | 'user' | 'assistant'; content: string };

let rpc: ReturnType<typeof createWorkerRpc> | null = null;
let currentDevice: BrowserChatDevice | null = null;

/** The worker remains loaded across turns; aborting terminates inference and
 * drops the model, so the next request starts a fresh worker. */
export async function runBrowserChat(
	messages: BrowserChatTurn[],
	device: BrowserChatDevice,
	signal?: AbortSignal
): Promise<string> {
	if (signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
	if (!rpc) rpc = createWorkerRpc(
		() => new Worker(new URL('./browserChat.worker.ts', import.meta.url), { type: 'module', name: 'browser-chat' }),
		'Browser chat', () => { currentDevice = null; }
	);
	if (currentDevice && currentDevice !== device) rpc.reset();
	currentDevice = device;
	const bridge = rpc;
	const onAbort = () => bridge.reset();
	signal?.addEventListener('abort', onAbort, { once: true });
	if (signal?.aborted) {
		signal.removeEventListener('abort', onAbort);
		onAbort();
		throw new DOMException('Request aborted', 'AbortError');
	}
	try {
		return await bridge.call<string>('generate', { messages, device });
	} catch (error) {
		if (signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
		throw error;
	} finally {
		signal?.removeEventListener('abort', onAbort);
	}
}

export function disposeBrowserChat(): void {
	rpc?.reset();
	rpc = null;
	currentDevice = null;
}
