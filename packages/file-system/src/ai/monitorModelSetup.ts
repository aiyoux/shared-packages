import type { AiTaskKey } from './selection.js';
import { NATIVE_RUNTIME_NAMES, type NativeModelTask } from './nativeModelForm.js';

type SetupGuide = {
	title: string;
	steps: readonly string[];
	links: readonly { label: string; url: string }[];
	modelExample?: string;
};

/** Backend prerequisites, not model offers: these remain discoverable offline. */
export const MONITOR_MODEL_SETUP = {
	chat: {
		title: 'Chat',
		steps: [
			'Install or build llama.cpp on the computer running Monitor and download a compatible GGUF language model.',
			'Choose Configure model, enter the absolute paths to llama-cli and the GGUF file, select CPU or a GPU supported by your build, then Enable on monitor.',
			'Refresh the model list and select this model in Chat or in Default models for apps.'
		],
		links: [{ label: 'llama.cpp installation and models', url: 'https://github.com/ggml-org/llama.cpp' }],
		modelExample: '/home/you/models/chat.gguf'
	},
	transcription: {
		title: 'Speech recognition',
		steps: [
			'Install or build whisper.cpp on the computer running Monitor. Download compatible whisper.cpp GGML weights; the downloadable library below also provides Whisper weights.',
			'Choose Configure model, enter the absolute paths to whisper-cli and the model file, then Enable on monitor. CPU works without a GPU; Monitor currently checks NVIDIA/CUDA for the GPU option.',
			'Refresh, then select the Monitor model in Transcribe.'
		],
		links: [{ label: 'whisper.cpp installation and models', url: 'https://github.com/ggml-org/whisper.cpp' }],
		modelExample: '/home/you/models/ggml-tiny.bin'
	},
	'text-to-speech': {
		title: 'Speech synthesis',
		steps: [
			'Install a compatible Piper CLI on the computer running Monitor. It must support --model, --output_file and --length_scale. Download a voice .onnx file and its matching .onnx.json file and keep them together.',
			'Choose Configure model, enter the absolute paths to the Piper executable and the .onnx file, then Enable on monitor. Start with CPU; the GPU option requires NVIDIA/CUDA and a Piper build supporting --use-cuda.',
			'Refresh, then select this Monitor voice in Speak.'
		],
		links: [{ label: 'Piper CLI releases and voice instructions', url: 'https://github.com/rhasspy/piper' }],
		modelExample: '/home/you/models/voice.onnx'
	},
	'image-generation': {
		title: 'Image generation',
		steps: [
			'Install or build stable-diffusion.cpp on the computer running Monitor. Download a compatible complete checkpoint, such as a Stable Diffusion 1.5 .safetensors file, supported by sd-cli -m. Models needing separate text encoders or a VAE cannot be registered with this single-file form.',
			'Choose Configure model, enter the absolute paths to sd-cli and the checkpoint, then Enable on monitor. For CPU select CPU and enter cpu as Backend. For GPU build the appropriate CUDA, Vulkan or Metal backend and use a device name reported by sd-cli --list-devices, such as cuda0 or vulkan0.',
			'Refresh, open Generate, and select this Monitor and model in the header. Browser SDXS/SD-Turbo ONNX installations are separate from this Monitor runtime.'
		],
		links: [
			{ label: 'stable-diffusion.cpp installation and models', url: 'https://github.com/leejet/stable-diffusion.cpp' },
			{ label: 'Image backend selection', url: 'https://github.com/leejet/stable-diffusion.cpp/blob/master/docs/backend.md' }
		],
		modelExample: '/home/you/models/sd-v1-5.safetensors'
	},
	'video-interpolate': {
		title: 'Frame interpolation',
		steps: [
			'Install FFmpeg and FFprobe on the computer running Monitor; video and audio tools require both.',
			'Download the RIFE ncnn Vulkan release for that computer and extract the complete package, keeping its model files. Put rife-ncnn-vulkan on Monitor’s PATH or set [tools.rife] path in monitor.toml to the executable and restart Monitor.',
			'Refresh, then enable RIFE frame interpolation in Simple Video. The configured runtime needs a working Vulkan device.'
		],
		links: [{ label: 'RIFE runtime releases', url: 'https://github.com/nihui/rife-ncnn-vulkan/releases' }]
	},
	'video-upscale': {
		title: 'Video upscaling',
		steps: [
			'Install FFmpeg and FFprobe on the computer running Monitor; video and audio tools require both.',
			'Download the SRMD ncnn Vulkan release for that computer and extract the complete package, keeping its models directory. Put srmd-ncnn-vulkan on Monitor’s PATH or set [tools.srmd] path in monitor.toml to the executable and restart Monitor.',
			'Refresh, then enable SRMD upscaling in Simple Video. The configured runtime needs a working Vulkan device.'
		],
		links: [{ label: 'SRMD runtime releases', url: 'https://github.com/nihui/srmd-ncnn-vulkan/releases' }]
	},
	'audio-upsampling': {
		title: 'Audio upsampling',
		steps: [
			'Install FFmpeg and FFprobe on the computer running Monitor.',
			'For LavaSR and NovaSR install audiosronnx in your Python environment and put its executable on Monitor’s PATH, or set [tools.audio] path to that executable in monitor.toml and restart Monitor. Weights download on first use.',
			'For UniverSR or AudioSR use a Python environment containing the chosen package and set [tools.pytorch] python to its absolute interpreter path in monitor.toml, then restart Monitor. Follow the engine’s installation instructions for PyTorch and device support.',
			'Refresh and choose an engine in Simple Audio → Upsample audio, or set its default in Default models for apps.'
		],
		links: [
			{ label: 'LavaSR / NovaSR installation', url: 'https://pypi.org/project/audiosronnx/' },
			{ label: 'UniverSR installation', url: 'https://github.com/woongzip1/UniverSR' },
			{ label: 'AudioSR installation', url: 'https://github.com/haoheliu/versatile_audio_super_resolution' }
		]
	}
} as const satisfies Record<NativeModelTask, SetupGuide> & Partial<Record<AiTaskKey, SetupGuide>>;

export type MonitorSetupTask = keyof typeof MONITOR_MODEL_SETUP;
export function monitorModelSetup(task: string): SetupGuide | null {
	return Object.hasOwn(MONITOR_MODEL_SETUP, task) ? MONITOR_MODEL_SETUP[task as MonitorSetupTask] : null;
}
export function monitorRuntimeExample(task: string): string | null {
	return Object.hasOwn(NATIVE_RUNTIME_NAMES, task) ? `/usr/local/bin/${NATIVE_RUNTIME_NAMES[task]}` : null;
}

/** Values are placeholders; UI users substitute their provider's declared IDs. */
export function mediaModelConfigExample(task: string): string | null {
	if (!['image-generation', 'text-to-speech', 'transcription'].includes(task)) return null;
	return [
		'[[ai.media_models]]',
		`id = "my-${task}-model"`,
		`name = "My ${monitorModelSetup(task)?.title.toLowerCase()} model"`,
		'profile = "your-api-profile-id"',
		'model = "your-provider-model-id"',
		`task = "${task}"`,
		...(task === 'text-to-speech' ? ['voice = "your-provider-voice-id"'] : []),
		...(task === 'image-generation' ? ['# Set true only if your API requires response_format = b64_json.', 'request_b64_json = false'] : [])
	].join('\n');
}
