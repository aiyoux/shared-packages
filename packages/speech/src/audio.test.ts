import { describe, expect, it } from 'vitest';
import { chunkAudio, quietestCut } from './audio.js';
import { DEFAULT_STT_PROMPT, aiStatusToCode, buildSttAudioMessages, checkAiAudioSize, looksAudioCapable, rankModelsForAudio } from './aiParts.js';
import { MODEL_CATALOG, defaultSttModel, defaultTtsModel, sttModelsFor, ttsModelsFor } from './models.js';

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
	it('builds an OpenAI input_audio message', () => {
		const body = buildSttAudioMessages('gpt-4o-audio', 'QUJD');
		expect(body.model).toBe('gpt-4o-audio');
		expect(body.messages).toHaveLength(1);
		const [text, audio] = body.messages[0]!.content;
		expect(text).toEqual({ type: 'text', text: DEFAULT_STT_PROMPT });
		expect(audio).toEqual({ type: 'input_audio', input_audio: { data: 'QUJD', format: 'wav' } });
	});

	it('ranks audio-capable model ids first', () => {
		const ranked = rankModelsForAudio(['llama-3', 'gpt-4o', 'qwen2-audio', 'deepseek-chat']);
		expect(ranked[0]).toBe('gpt-4o');
		expect(ranked.filter((m) => looksAudioCapable(m))).toEqual(['gpt-4o', 'qwen2-audio']);
	});

	it('maps statuses to the hub error taxonomy', () => {
		expect(aiStatusToCode(401)).toBe('AI_AUTH');
		expect(aiStatusToCode(403)).toBe('AI_AUTH');
		expect(aiStatusToCode(404)).toBe('AI_NOT_FOUND');
		expect(aiStatusToCode(429)).toBe('AI_RATE');
		expect(aiStatusToCode(500)).toBe('AI_ERROR');
	});

	it('caps payloads around ten minutes of 16 kHz mono', () => {
		const ok = checkAiAudioSize(5 * 60_000);
		expect(ok.tooLarge).toBe(false);
		const tooBig = checkAiAudioSize(60 * 60_000);
		expect(tooBig.tooLarge).toBe(true);
		expect(tooBig.maxDurationMs).toBeGreaterThan(8 * 60_000);
		expect(tooBig.maxDurationMs).toBeLessThan(12 * 60_000);
	});
});

describe('model catalog integrity', () => {
	it('catalog sizes equal the sum of their files', () => {
		for (const def of MODEL_CATALOG) {
			const sum = def.files.reduce((n, f) => n + (f.bytes ?? 0), 0);
			expect(sum).toBe(def.sizeBytes);
			expect(def.files.length).toBeGreaterThan(0);
			expect(def.repo).toMatch(/^[\w.-]+\/[\w.-]+$/);
		}
	});

	it('routes models to the engine registries', () => {
		expect(sttModelsFor('transformers').map((m) => m.id)).toEqual([
			'whisper-tiny', 'whisper-base', 'whisper-small', 'moonshine-tiny', 'moonshine-base'
		]);
		expect(ttsModelsFor('kokoro').map((m) => m.id)).toEqual(['kokoro-82m']);
		expect(defaultSttModel('transformers')).toBe('whisper-tiny');
		expect(defaultTtsModel('kokoro')).toBe('kokoro-82m');
	});

	it('weights stay under the biggest useful download', () => {
		for (const def of MODEL_CATALOG) {
			// Every MVP model is under 1 GB; whisper-small is the ceiling.
			expect(def.sizeBytes).toBeLessThan(1024 ** 3);
		}
	});
});