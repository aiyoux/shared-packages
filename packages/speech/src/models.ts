import { requireFiles, type ModelDef, type ModelFileDef } from '@shared-packages/model-store';
import type { SpeechModelDef, SttEngineId, TtsDevice, TtsEngineId, TtsVoice } from './types.js';

export type { SpeechModelDef };

/**
 * Model weight catalogs: the exact files each engine loads for its dtype,
 * pinned to an upstream revision, with sizes and Blake3 hashes streamed from
 * those revisions by `model-store/scripts/hash-catalog.mjs`. Engines read
 * these files only from the browser model store, so the list is complete:
 * a file missing here is a file the engine cannot load.
 */

// Compact file-entry helper for the catalogs below.
const f = (path: string, bytes: number, blake3: string, optional?: boolean): ModelFileDef =>
	optional ? { path, bytes, blake3, optional } : { path, bytes, blake3 };

export const WHISPER_TINY: SpeechModelDef = {
	id: 'whisper-tiny',
	label: 'Whisper tiny',
	task: 'stt',
	engine: 'transformers',
	repo: 'onnx-community/whisper-tiny',
	revision: 'ff4177021cc41f7db950912b73ea4fdf7d01d8e7',
	dtype: 'q8',
	files: [
		f('config.json', 2243, '637661695816a08e5de1f520d79ccbd196c9218b3f11d8861899450565c1d9f1'),
		f('preprocessor_config.json', 339, '3842ae761792d0db0c3e09cfbbd30913bf1008f3b6f94e181ae368d899ad54f8'),
		f('generation_config.json', 3772, '6e3f511cb0a5f20da52473875f759c4f29a16431dd8d1b2263f34d2db7ad2e6c'),
		f('tokenizer.json', 2480466, 'a86dd41d99c0e21b9d56fe32adab1fc109d7edd35c07cb05f65a819e25490ca8'),
		f('tokenizer_config.json', 282683, 'f82d4be5952fe697d3c644bd1a25747565ee33fcce1320aafc3502d7c3f8068f'),
		f('onnx/encoder_model_quantized.onnx', 10124990, '1601131b73a1e48f5aae4c1b9c0eca9eb113037d4fa2ff697e9363137dcf74b3'),
		f('onnx/decoder_model_merged_quantized.onnx', 30719241, '8fc47ddfd309b9464da34540df434c2791588f0351ba3c13c958c2031d63b02a')
	],
	languages: ['multilingual']
};

export const WHISPER_BASE: SpeechModelDef = {
	id: 'whisper-base',
	label: 'Whisper base',
	task: 'stt',
	engine: 'transformers',
	repo: 'onnx-community/whisper-base',
	revision: '1846881b6b3a3024392c1eea3ad983695bc23925',
	dtype: 'q8',
	files: [
		f('config.json', 2243, '85dcd014d7287827acd68fc41cf077145e3800e6ba7b88c0565527a5bb1fda18'),
		f('preprocessor_config.json', 339, '3842ae761792d0db0c3e09cfbbd30913bf1008f3b6f94e181ae368d899ad54f8'),
		f('generation_config.json', 3832, 'f0b6bc3e87cec83be1e90fada80650fba362c2731ecc964151b8851d52eeac6d'),
		f('tokenizer.json', 2480466, 'a86dd41d99c0e21b9d56fe32adab1fc109d7edd35c07cb05f65a819e25490ca8'),
		f('tokenizer_config.json', 282682, 'e6ffce528ba7e34e6af773f26c5651389574fca566f3f23bfd0134eaa71a0c66'),
		f('onnx/encoder_model_quantized.onnx', 23201314, '2b665e06db0eee1bc1174d0d511320eb4cdc6d1fbbb2cb80a6e72e6c01ae0cdc'),
		f('onnx/decoder_model_merged_quantized.onnx', 53693315, '67d66853d5f5c3f0652a68ba892161c848906dd2dc9620b87c4e0d4a00219227')
	],
	languages: ['multilingual']
};

export const WHISPER_SMALL: SpeechModelDef = {
	id: 'whisper-small',
	label: 'Whisper small',
	task: 'stt',
	engine: 'transformers',
	repo: 'onnx-community/whisper-small',
	revision: '36050c46d777d46dc4b5f43f6d90574fc38f8732',
	dtype: 'q8',
	files: [
		f('config.json', 2227, '3653e3c8e70911faaff563511526e1c57564335ba541f5139f8bcb27eb604166'),
		f('preprocessor_config.json', 339, '3842ae761792d0db0c3e09cfbbd30913bf1008f3b6f94e181ae368d899ad54f8'),
		f('generation_config.json', 3893, '60220394dc50b80a754eb5212be5fa3af1868633f477f2558aedc1658bd15504'),
		f('tokenizer.json', 2480466, 'a86dd41d99c0e21b9d56fe32adab1fc109d7edd35c07cb05f65a819e25490ca8'),
		f('tokenizer_config.json', 282683, 'f82d4be5952fe697d3c644bd1a25747565ee33fcce1320aafc3502d7c3f8068f'),
		f('onnx/encoder_model_quantized.onnx', 92326160, '9d37dfd54079f634548b83ff999164778f630cdf865dd04e7f2d1e46b8bc52b1'),
		f('onnx/decoder_model_merged_quantized.onnx', 156750845, '4f03b7612125cec955b8241fbaab08be46e6d433bb0b1b0b8053e9088e8635b4')
	],
	languages: ['multilingual']
};

export const MOONSHINE_TINY: SpeechModelDef = {
	id: 'moonshine-tiny',
	label: 'Moonshine tiny',
	task: 'stt',
	engine: 'transformers',
	repo: 'onnx-community/moonshine-tiny-ONNX',
	revision: 'a6da1241cd305dcd64eab1edbd615f2bb9aabb95',
	dtype: 'q8',
	license: 'MIT',
	files: [
		f('config.json', 921, 'eba85f0d9419797759fcf45f14c3a6a0091839cb1a5c2fb62f108646189a13d6'),
		f('preprocessor_config.json', 128, '4b206fabb17e4745d5ff5f36b8a5b726ebdc159a27cb33a24014cf1a47eedacc'),
		f('generation_config.json', 147, 'f0154e6b5bd87736655c5b4afba5a214082ede255fc995a36c7a9b6cd4b4e0c8'),
		f('tokenizer.json', 3761754, '82f26f77ec002b83278e2c24dbdd3333d28e8a0288cee32061ddabe8b595e39d'),
		f('tokenizer_config.json', 135735, '6bd46f537adc6fcacacc543b4252805c58a32f4fab1fbdb54e360891d07ed685'),
		f('onnx/encoder_model_quantized.onnx', 7937661, '428a0e90ab7213661ce6164a7433bccaf7393228aaaad2aeca1c302caafb8795'),
		f('onnx/decoder_model_merged_quantized.onnx', 20243286, 'be0d9f9ba14fd639daa9f72a937c206d5f14dff80afefbdd5019731db24ce508')
	],
	languages: ['en']
};

export const MOONSHINE_BASE: SpeechModelDef = {
	id: 'moonshine-base',
	label: 'Moonshine base',
	task: 'stt',
	engine: 'transformers',
	repo: 'onnx-community/moonshine-base-ONNX',
	revision: 'b1e9b6aae3c3c7298f10c3798393fdf38e8fbbad',
	dtype: 'q8',
	license: 'MIT',
	files: [
		f('config.json', 922, 'c9f8d789438486322e65a38c307e09bc29067f26695e828176d70c36e805f81e'),
		f('preprocessor_config.json', 128, '4b206fabb17e4745d5ff5f36b8a5b726ebdc159a27cb33a24014cf1a47eedacc'),
		f('generation_config.json', 147, 'f0154e6b5bd87736655c5b4afba5a214082ede255fc995a36c7a9b6cd4b4e0c8'),
		f('tokenizer.json', 3761754, '82f26f77ec002b83278e2c24dbdd3333d28e8a0288cee32061ddabe8b595e39d'),
		f('tokenizer_config.json', 135735, '6bd46f537adc6fcacacc543b4252805c58a32f4fab1fbdb54e360891d07ed685'),
		f('onnx/encoder_model_quantized.onnx', 20513063, '396fe840678956a22718bf37335b04c32a7e1e2bbab63fa092375b06156cf979'),
		f('onnx/decoder_model_merged_quantized.onnx', 42498870, 'dd242fc24d17d505d857473b6403ee2a719167628abda677cc268ba5b64840c9')
	],
	languages: ['en']
};

export const KOKORO_82M: SpeechModelDef = {
	id: 'kokoro-82m',
	label: 'Kokoro 82M (q8 · WebAssembly)',
	task: 'tts',
	engine: 'kokoro',
	repo: 'onnx-community/Kokoro-82M-v1.0-ONNX',
	revision: '1939ad2a8e416c0acfeecc08a694d14ef25f2231',
	dtype: 'q8',
	license: 'Apache-2.0',
	files: [
		f('config.json', 44, '3ba179bc50c0f27c0d455b28bac0145c9fac89905ec72c13ebb7cf9c4e298196'),
		f('tokenizer.json', 3497, '9e98eb71512bca2b08e9819d2696e0acd95e5abcf5c9c6359f3379ca2f282d53'),
		f('tokenizer_config.json', 113, 'b229a131f6d661b0b14140cb2f2295d247d4c7d209fe80cbd1c12916a923403a'),
		f('onnx/model_quantized.onnx', 92361116, '2de01bc256b6a5601ad19e0f06fa21b751d81afa3ea6830c3faff22136b7aea9')
	],
	languages: ['en'],
	devices: ['wasm']
};

/** Full-precision Kokoro weights — what kokoro-js recommends on WebGPU (the
 *  quantized ops of the q8 file fall back to CPU there). Same repo, same
 *  small files, bigger model file. */
export const KOKORO_82M_FP32: SpeechModelDef = {
	id: 'kokoro-82m-fp32',
	label: 'Kokoro 82M (fp32 · WebGPU)',
	task: 'tts',
	engine: 'kokoro',
	repo: 'onnx-community/Kokoro-82M-v1.0-ONNX',
	revision: '1939ad2a8e416c0acfeecc08a694d14ef25f2231',
	dtype: 'fp32',
	license: 'Apache-2.0',
	files: [
		f('config.json', 44, '3ba179bc50c0f27c0d455b28bac0145c9fac89905ec72c13ebb7cf9c4e298196'),
		f('tokenizer.json', 3497, '9e98eb71512bca2b08e9819d2696e0acd95e5abcf5c9c6359f3379ca2f282d53'),
		f('tokenizer_config.json', 113, 'b229a131f6d661b0b14140cb2f2295d247d4c7d209fe80cbd1c12916a923403a'),
		f('onnx/model.onnx', 325532232, '0ad370358952d5ef5d73db022c0034856652d1a379e26703229ef5461b7d0089')
	],
	languages: ['en'],
	devices: ['webgpu']
};

export const MODEL_CATALOG: readonly SpeechModelDef[] = [
	WHISPER_TINY,
	WHISPER_BASE,
	WHISPER_SMALL,
	MOONSHINE_TINY,
	MOONSHINE_BASE,
	KOKORO_82M,
	KOKORO_82M_FP32
] as const;

export function modelDef(id: string): SpeechModelDef {
	const found = MODEL_CATALOG.find((m) => m.id === id);
	if (!found) throw new Error(`Unknown speech model: ${id}`);
	return found;
}

export function sttModelsFor(engine: SttEngineId): readonly SpeechModelDef[] {
	return MODEL_CATALOG.filter((m) => m.task === 'stt' && m.engine === (engine as SpeechModelDef['engine']));
}

export function ttsModelsFor(engine: TtsEngineId): readonly SpeechModelDef[] {
	return MODEL_CATALOG.filter((m) => m.task === 'tts' && m.engine === (engine as SpeechModelDef['engine']));
}

export function defaultSttModel(engine: SttEngineId): string | null {
	const models = sttModelsFor(engine);
	return models.length ? models[0]!.id : null;
}

/** The engine's model meant for `device` (a def without `devices` fits any). */
export function ttsModelForDevice(engine: TtsEngineId, device: TtsDevice): SpeechModelDef | null {
	const models = ttsModelsFor(engine);
	return models.find((m) => !m.devices || m.devices.includes(device)) ?? models[0] ?? null;
}

export function defaultTtsModel(engine: TtsEngineId): string | null {
	const models = ttsModelsFor(engine);
	return models.length ? models[0]!.id : null;
}

/** Pinned download URL for one file inside a model repo. */
export function hfResolveUrl(repo: string, revision: string, path: string): string {
	return `https://huggingface.co/${repo}/resolve/${revision}/${path}`;
}

const browserModels = new WeakMap<SpeechModelDef, ModelDef>();
/** The store's view of a speech def — derived, so each model is declared once. */
export function speechBrowserModel(def: SpeechModelDef): ModelDef {
	let model = browserModels.get(def);
	if (!model) {
		model = {
			id: `speech:${def.id}`,
			task: def.task === 'stt' ? 'transcription' : 'text-to-speech',
			label: def.label,
			...(def.license ? { license: def.license } : {}),
			files: def.files.map((file) => ({ ...file, url: hfResolveUrl(def.repo, def.revision, file.path) })),
			origin: { kind: 'hf', repo: def.repo, revision: def.revision }
		};
		browserModels.set(def, model);
	}
	return model;
}

/** Voice bin path inside the Kokoro repo for one voice id. */
export function kokoroVoicePath(voice: string): string {
	return `voices/${voice}.bin`;
}

export type KokoroVoice = TtsVoice & { bin: string; grade: string };

function kokoroEntry(id: string, name: string, gender: 'female' | 'male', grade: string): KokoroVoice {
	const american = id.startsWith('a');
	return {
		id,
		label: `${name} · ${gender} · grade ${grade}`,
		language: american ? 'en-US' : 'en-GB',
		group: american ? 'American English' : 'British English',
		grade,
		bin: kokoroVoicePath(id)
	};
}

/**
 * Every voice kokoro-js 1.2.1 accepts (its internal VOICES table — the
 * other 26 bins in the model repo are non-English and it rejects them).
 * Grades are the library's overall quality grade; each accent group is
 * ordered best first. `kokoroVoices.test.ts` pins this list to the library.
 */
export const KOKORO_VOICES: readonly KokoroVoice[] = [
	kokoroEntry('af_heart', 'Heart', 'female', 'A'),
	kokoroEntry('af_bella', 'Bella', 'female', 'A-'),
	kokoroEntry('af_nicole', 'Nicole', 'female', 'B-'),
	kokoroEntry('af_aoede', 'Aoede', 'female', 'C+'),
	kokoroEntry('af_kore', 'Kore', 'female', 'C+'),
	kokoroEntry('af_sarah', 'Sarah', 'female', 'C+'),
	kokoroEntry('af_alloy', 'Alloy', 'female', 'C'),
	kokoroEntry('af_nova', 'Nova', 'female', 'C'),
	kokoroEntry('af_sky', 'Sky', 'female', 'C-'),
	kokoroEntry('af_jessica', 'Jessica', 'female', 'D'),
	kokoroEntry('af_river', 'River', 'female', 'D'),
	kokoroEntry('am_fenrir', 'Fenrir', 'male', 'C+'),
	kokoroEntry('am_michael', 'Michael', 'male', 'C+'),
	kokoroEntry('am_puck', 'Puck', 'male', 'C+'),
	kokoroEntry('am_echo', 'Echo', 'male', 'D'),
	kokoroEntry('am_eric', 'Eric', 'male', 'D'),
	kokoroEntry('am_liam', 'Liam', 'male', 'D'),
	kokoroEntry('am_onyx', 'Onyx', 'male', 'D'),
	kokoroEntry('am_santa', 'Santa', 'male', 'D-'),
	kokoroEntry('am_adam', 'Adam', 'male', 'F+'),
	kokoroEntry('bf_emma', 'Emma', 'female', 'B-'),
	kokoroEntry('bf_isabella', 'Isabella', 'female', 'C'),
	kokoroEntry('bf_alice', 'Alice', 'female', 'D'),
	kokoroEntry('bf_lily', 'Lily', 'female', 'D'),
	kokoroEntry('bm_fable', 'Fable', 'male', 'C'),
	kokoroEntry('bm_george', 'George', 'male', 'C'),
	kokoroEntry('bm_lewis', 'Lewis', 'male', 'D+'),
	kokoroEntry('bm_daniel', 'Daniel', 'male', 'D')
];

export function kokoroVoice(voiceId: string): KokoroVoice {
	const found = KOKORO_VOICES.find((v) => v.id === voiceId);
	if (!found) throw new Error(`Unknown Kokoro voice: ${voiceId}`);
	return found;
}

/** Every Kokoro voice bin, one optional file each: a voice is usable once its
 *  own bin is stored, so readiness for a selection is {@link kokoroVoicesModel}. */
const KOKORO_VOICES_REVISION = '1939ad2a8e416c0acfeecc08a694d14ef25f2231';
export const KOKORO_VOICES_MODEL: ModelDef = {
	id: 'speech:kokoro-voices',
	task: 'text-to-speech',
	label: 'Kokoro voices',
	license: 'Apache-2.0',
	files: [
		f('voices/af_heart.bin', 522240, '57e1375372924a344bf535a0643c5e99eaca65c23e43bcf20cc58d3df01625de', true),
		f('voices/af_bella.bin', 522240, '9bea0697f57f3fda4accc8eb9db009461b46fcf722ecf66b6c937e827d5c37d0', true),
		f('voices/af_nicole.bin', 522240, '3c3f631259bf7c0983ee015d7e0e71b5654f9bbb4b72f843faded8e0528aaf87', true),
		f('voices/af_aoede.bin', 522240, '9d9f28768ccfa3eeac8a901f38d63f8a783f40715389278da104d518bb6e804f', true),
		f('voices/af_kore.bin', 522240, '0c6691f0d75830c7184b1ae409f8ca473aab6b154fa082aa09b0e3847cf584ee', true),
		f('voices/af_sarah.bin', 522240, '0971601ff79b5909684cb5628ed373dd5f4f3583fc6f1b2e2fafde77d0cb3b62', true),
		f('voices/af_alloy.bin', 522240, '1864ee0a1ac7b1ddd31acb3a25fd240ad727d230beaf73e10109669bddd66431', true),
		f('voices/af_nova.bin', 522240, '5148dfb14c0710f5c236cd539df0377c381099fdfa148f67cb8ea3be6ba847d7', true),
		f('voices/af_sky.bin', 522240, '65bd897dcdeacae285a8269dbc50bbc3aa55a65a350c4cd86c631e26c3406f8d', true),
		f('voices/af_jessica.bin', 522240, '7d8474434d5cb34778a52c942538f407c9d599e990b558faae3586465af580c7', true),
		f('voices/af_river.bin', 522240, '2e634184892bceb608034f2b45df96d31c85d7b6d4867e27ec0f567b7caee313', true),
		f('voices/am_fenrir.bin', 522240, 'ab7159a8d052b7294779e7d60597d8ef73e64c60862ca6fa90c26c7600fbcf94', true),
		f('voices/am_michael.bin', 522240, 'b1f137f6440af58c31329194468786cc752a627145559362cf2516200142ea0b', true),
		f('voices/am_puck.bin', 522240, '6f7e74d0b157f9e3c593158894326105dccc4d97817ce9bd8c23a8fcbfc4ea8f', true),
		f('voices/am_echo.bin', 522240, '4082423b6626e79d52d727f6868ed8ecd2d497ee6855ff3d2b274148df140376', true),
		f('voices/am_eric.bin', 522240, 'fcae5a3761cd3164f4484d0fb742411e01fb84c41486b64cf056d315a998d818', true),
		f('voices/am_liam.bin', 522240, 'c3505d7875332d80bddb2e61ca5c08ff663b30103ebee01bdab2ba1b431eedaa', true),
		f('voices/am_onyx.bin', 522240, 'a05584be9989c039d1474b6a4729e315dee7375ce08ec5ac156c92dca5db27ef', true),
		f('voices/am_santa.bin', 522240, '6af5d873e9c7f83fd0ad3a81ac5f58ff9e939871402b16afcd95947c7429f19f', true),
		f('voices/am_adam.bin', 522240, '613a20bb9fe54af1b569ae0b6f8c00049fbec01d6f7068cefd6cc952e0878816', true),
		f('voices/bf_emma.bin', 522240, '3db6128400ece1de7862d5bd3f1637b996db56b3b1ceb4e16c50f317669b936d', true),
		f('voices/bf_isabella.bin', 522240, '7e12855aa49d47627c9a707a1297908c16e05dff15b0704c7ed09dd0380f8c56', true),
		f('voices/bf_alice.bin', 522240, '96de3099b175bdf2f99b0c89276e78e39dbce3bcb67315f7e311afc99d96b0c7', true),
		f('voices/bf_lily.bin', 522240, 'b24410d84d22161938cae6d4a9c79914244b6fca7502a2865bf6d5dd7752480c', true),
		f('voices/bm_fable.bin', 522240, '9246c414d5024a2f4b45bdefe23b7c8c1ecc986830983380266899b968fec95f', true),
		f('voices/bm_george.bin', 522240, '3961cd5f8b49532df1f25dfb833a286e8409784d290a9bb81e0482f633e03293', true),
		f('voices/bm_lewis.bin', 522240, '5c14667171a7f4dd5406f0474c711de6a9b977622035e98f0c8946b2473ad7c4', true),
		f('voices/bm_daniel.bin', 522240, '7c78f4813659a5e46c02525a87a0454af543e24410b25a2a258f06fb4001a103', true)
	].map((file) => ({ ...file, url: hfResolveUrl(KOKORO_82M.repo, KOKORO_VOICES_REVISION, file.path) })),
	origin: { kind: 'hf', repo: KOKORO_82M.repo, revision: KOKORO_VOICES_REVISION }
};

/** The voices model with `voice`'s bin required. An empty/unknown voice falls
 *  back to the first catalog voice (the picker's default). */
export function kokoroVoicesModel(voice: string): ModelDef {
	const known = KOKORO_VOICES.find((v) => v.id === voice) ?? KOKORO_VOICES[0]!;
	return requireFiles(KOKORO_VOICES_MODEL, [known.bin]);
}

/** In-browser chat (SmolLM2) per device: WebGPU runs the q4f16 export. */
const SMOLLM2_REPO = 'onnx-community/SmolLM2-135M-Instruct-ONNX';
const SMOLLM2_REVISION = 'b8a5c0f183b78c55955a5364f610c36668b5e681';
function chatModel(dtype: 'q4' | 'q4f16', label: string, files: ModelFileDef[]) {
	return {
		repo: SMOLLM2_REPO,
		dtype,
		model: {
			id: `chat:smollm2-135m-${dtype}`,
			task: 'chat',
			label,
			license: 'Apache-2.0',
			files: files.map((file) => ({ ...file, url: hfResolveUrl(SMOLLM2_REPO, SMOLLM2_REVISION, file.path) })),
			origin: { kind: 'hf', repo: SMOLLM2_REPO, revision: SMOLLM2_REVISION }
		} satisfies ModelDef
	};
}
export const BROWSER_CHAT_MODELS = {
	wasm: chatModel('q4', 'SmolLM2 135M (q4 · WebAssembly)', [
		f('config.json', 976, 'fc24c05f9fbda437605174a35fdbbac018893b74bad7cf62e11a9b0eabf0231e'),
		f('generation_config.json', 132, '767e377e06e1a217b71411061d44b7aabd448e860122e556859d70bc3b8dd319'),
		f('tokenizer.json', 3522656, '6dbba694e56e9f722e4f60ec5bae96e02ca3b2969349f0f9986162189459bd4e'),
		f('tokenizer_config.json', 3794, 'c3d23d59c563ead5c78f0044e58f19a01a5a5d707f826c6300e7c2a103af5389'),
		f('onnx/model_q4.onnx', 180581125, '3c1ae8cf8b422fa35865a024cf953632ea9ab4f3abaf354e0dd8c87bd50107d5')
	]),
	webgpu: chatModel('q4f16', 'SmolLM2 135M (q4f16 · WebGPU)', [
		f('config.json', 976, 'fc24c05f9fbda437605174a35fdbbac018893b74bad7cf62e11a9b0eabf0231e'),
		f('generation_config.json', 132, '767e377e06e1a217b71411061d44b7aabd448e860122e556859d70bc3b8dd319'),
		f('tokenizer.json', 3522656, '6dbba694e56e9f722e4f60ec5bae96e02ca3b2969349f0f9986162189459bd4e'),
		f('tokenizer_config.json', 3794, 'c3d23d59c563ead5c78f0044e58f19a01a5a5d707f826c6300e7c2a103af5389'),
		f('onnx/model_q4f16.onnx', 117266133, 'd863458dedd3a749f12248e09acbc151217233545688310469e20bf97bb819cc')
	])
} as const;
