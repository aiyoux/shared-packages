import type { AiLibraryEntry, AiNativeModelInput } from './library.js';
import type { AiTask } from './catalog.js';

const RUNTIMES = {
	transcription: 'whisper-cli',
	chat: 'llama-cli',
	'text-to-speech': 'piper',
	'image-generation': 'sd-cli'
};
export const NATIVE_RUNTIME_NAMES: Readonly<Record<string, string>> = RUNTIMES;
export type NativeModelTask = keyof typeof RUNTIMES;

export function canConfigureNativeTask(task: string): task is NativeModelTask {
	return Object.hasOwn(NATIVE_RUNTIME_NAMES, task);
}

export function nativeModelTaskPrefill(task: AiTask) {
	return { name: '', task, model: '', binary: '', backend: '', device: 'cpu' as const };
}

/** Start with the library's task, without carrying paths from another runtime. */
export function nativeModelLibraryPrefill(entry: AiLibraryEntry) {
	return {
		...nativeModelTaskPrefill(entry.task),
		name: entry.name,
		model: entry.installedPath ?? ''
	};
}

/** Hidden image-backend text must never leak into a different task's request. */
export function nativeModelFormInput(input: AiNativeModelInput): AiNativeModelInput {
	const { backend, ...rest } = input;
	return {
		...rest,
		name: rest.name.trim(),
		binary: rest.binary.trim(),
		model: rest.model.trim(),
		...(input.task === 'image-generation' && backend?.trim() ? { backend: backend.trim() } : {})
	};
}
