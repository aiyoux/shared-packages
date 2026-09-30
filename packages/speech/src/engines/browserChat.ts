import { createWorkerRpc } from './workerRpc.js';
import { registerBrowserAiHandler, runBrowserAi, type BrowserAiRunOptions } from '@shared-packages/file-system/ai';

export const BROWSER_CHAT_MODEL = 'onnx-community/SmolLM2-135M-Instruct-ONNX';
export type BrowserChatDevice = 'wasm' | 'webgpu';
export type BrowserChatTurn = { role: 'system' | 'user' | 'assistant'; content: string };

let rpc: ReturnType<typeof createWorkerRpc> | null = null;
let currentDevice: BrowserChatDevice | null = null;

/** The worker remains loaded across turns; aborting terminates inference and
 * drops the model, so the next request starts a fresh worker. */
async function runLocalBrowserChat(
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

function disposeLocalBrowserChat(): void {
	rpc?.reset();
	rpc = null;
	currentDevice = null;
}

let registered = false;
export function initializeBrowserChatHost(): void {
 if (registered) return; registered = true;
 registerBrowserAiHandler('speech:chat', {
  kind: 'chat',
  async run(_action, value, context) {
   const payload = value as { messages: BrowserChatTurn[]; device: BrowserChatDevice };
   context.state('loading');
   const result = await runLocalBrowserChat(payload.messages, payload.device, context.signal);
   context.state('loaded'); return result;
  },
  capture(result) { return new Blob([String(result)], { type: 'text/plain' }); },
  dispose: disposeLocalBrowserChat
 });
}
export async function runBrowserChat(messages: BrowserChatTurn[], device: BrowserChatDevice, signal?: AbortSignal, options: BrowserAiRunOptions = {}): Promise<string> {
 initializeBrowserChatHost();
 return runBrowserAi<string>('speech:chat', 'generate', { messages, device }, BROWSER_CHAT_MODEL, { ...options, signal }, { webgpu: device === 'webgpu' });
}
/** Closing a chat view releases playback/UI only. The shared model and any
 * detached run belong to the host, and must survive the submitting view. */
export function disposeBrowserChat(): void {}
