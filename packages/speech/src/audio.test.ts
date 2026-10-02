import { describe, expect, it } from 'vitest';
import { chunkAudio, quietestCut } from './audio.js';
import { checkAiAudioSize } from './aiParts.js';
import { BROWSER_CHAT_MODELS, KOKORO_VOICES_MODEL, MODEL_CATALOG, defaultSttModel, speechBrowserModel, defaultTtsModel, sttModelsFor, ttsModelForDevice, ttsModelsFor } from './models.js';

describe('chunkAudio', () => {
	it('returns one chunk for short audio', () => {
		const samples = new Float32Array(16000); // 1 s
		const chunks = chunkAudio(samples, 16000);
		expect(chunks).toHaveLength(1);
		expect(chunks[0]?.startMs).toBe(0);
		expect(chunks[0]?.samples).toBe(samples);
	});

	it('splits long audio into ≤30 s windows with running offsets', () => {
		const rate = 16000;
		const samples = new Float32Array(rate * 95); // 95 s → 4 chunks
		const chunks = chunkAudio(samples, rate);
		expect(chunks.length).toBeGreaterThan(2);
		let covered = 0;
		for (const chunk of chunks) {
			expect(chunk.samples.length).toBeLessThanOrEqual(31 * rate);
			expect(chunk.startMs).toBeGreaterThanOrEqual(covered);
			covered = chunk.startMs + Math.round((chunk.samples.length / rate) * 1000);
		}
		expect(covered).toBeGreaterThanOrEqual(95_000 - 500);
	});

	it('cuts in silence when the overlap holds a quiet region', () => {
		const rate = 16000;
		const samples = new Float32Array(rate * 70); // 70 s
		// Loud before the raw cut, silent just inside the overlap window.
		for (let i = 0; i < samples.length; i++) samples[i] = i < rate * 29 ? 0.9 : 0;
		const chunks = chunkAudio(samples, rate);
		expect(chunks[0]!.samples.length).toBeGreaterThan(rate * 27);
		expect(chunks[0]!.samples.length).toBeLessThanOrEqual(rate * 30);
	});
});

describe('quietestCut', () => {
	it('prefers the silent region over the midpoint', () => {
		const samples = new Float32Array(1000);
		for (let i = 500; i < 700; i++) samples[i] = 0.9;
		const idx = quietestCut(samples, 0, 1000, 500);
		expect(idx).toBeLessThan(500);
	});
});

describe('aiParts', () => {
	it('caps payloads around thirteen minutes of 16 kHz mono', () => {
		const ok = checkAiAudioSize(5 * 60_000);
		expect(ok.tooLarge).toBe(false);
		const tooBig = checkAiAudioSize(60 * 60_000);
		expect(tooBig.tooLarge).toBe(true);
		expect(tooBig.maxDurationMs).toBeGreaterThan(10 * 60_000);
		expect(tooBig.maxDurationMs).toBeLessThan(16 * 60_000);
	});
});

describe('model catalog integrity', () => {
	it('pins every file to a revision with a size and Blake3', () => {
		for (const def of [...MODEL_CATALOG.map(speechBrowserModel), KOKORO_VOICES_MODEL, ...Object.values(BROWSER_CHAT_MODELS).map((chat) => chat.model)]) {
			expect(def.files.length).toBeGreaterThan(0);
			expect(def.origin).toMatchObject({ kind: 'hf', revision: expect.stringMatching(/^[a-f0-9]{40}$/) });
			for (const file of def.files) {
				expect(file.bytes).toBeGreaterThan(0);
				expect(file.blake3).toMatch(/^[a-f0-9]{64}$/);
				expect(file.url).toContain(`/resolve/${def.origin.kind === 'hf' ? def.origin.revision : ''}/${file.path}`);
			}
		}
	});

	it('routes models to the engine registries', () => {
		expect(sttModelsFor('transformers').map((m) => m.id)).toEqual([
			'whisper-tiny', 'whisper-base', 'whisper-small', 'moonshine-tiny', 'moonshine-base'
		]);
		expect(ttsModelsFor('kokoro').map((m) => m.id)).toEqual(['kokoro-82m', 'kokoro-82m-fp32']);
		expect(defaultSttModel('transformers')).toBe('whisper-tiny');
		expect(defaultTtsModel('kokoro')).toBe('kokoro-82m');
		// Device picks the weights: q8 on WebAssembly, fp32 on WebGPU.
		expect(ttsModelForDevice('kokoro', 'wasm')?.id).toBe('kokoro-82m');
		expect(ttsModelForDevice('kokoro', 'webgpu')?.id).toBe('kokoro-82m-fp32');
		expect(ttsModelForDevice('webspeech', 'wasm')).toBeNull();
	});

	it('weights stay under the biggest useful download', () => {
		for (const def of MODEL_CATALOG) {
			// Every MVP model is under 1 GB; whisper-small is the ceiling.
			expect(def.files.reduce((n, f) => n + (f.bytes ?? 0), 0)).toBeLessThan(1024 ** 3);
		}
	});
});