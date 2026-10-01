import type { AiLibraryEntry, AiNativeModelInput } from './library.js';

export const NATIVE_RUNTIME_NAMES: Record<string, string> = {
	transcription: 'whisper-cli',
	chat: 'llama-cli',
	'text-to-speech': 'piper',
	'image-generation': 'sd-cli'
};

/** Start with the library's task, without carrying paths from another runtime. */
export function nativeModelLibraryPrefill(entry: AiLibraryEntry) {
	return {
		name: entry.name,
		task: entry.task,
		model: entry.installedPath ?? '',
		binary: '',
		backend: '',
		device: 'cpu' as const
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
